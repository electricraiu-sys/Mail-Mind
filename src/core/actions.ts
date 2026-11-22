import type { ActionKind, MessageHeader } from './types';
import { ACTION_LABELS } from './types';
import { getHeaders, trashFolderFor, hasUse, collectMessages, collapseGmailCopies } from './mail';

/**
 * Executes user-approved actions in batches and records an undo log.
 * Deletes are always moves to the account's Trash folder — never permanent.
 */

export interface UndoItem {
  headerMessageId: string;
  fromFolderId: string;
  accountId: string;
  prev: { read: boolean; junk: boolean; flagged: boolean; tags: string[] };
}

export interface UndoEntry {
  id: string;
  time: number;
  kind: ActionKind;
  label: string;
  count: number;
  destFolderIds: string[];
  items: UndoItem[];
  undone?: boolean;
  source?: string;
}

export interface ExecuteOptions {
  folderId?: string;
  tag?: string;
  source?: string;
  onProgress?: (done: number, total: number) => void;
  /**
   * Called if this action has to wait for an earlier one to finish first, and again whenever its place in the
   * queue changes, until it starts.
   */
  onQueued?: (pos: QueuePosition) => void;
}

/** Where a waiting action stands in the queue. */
export interface QueuePosition {
  /** Actions that run before this one (including the one running now). */
  jobsAhead: number;
  /** Emails those actions still have to process. */
  emailsAhead: number;
}

/** The whole queue at a glance. */
export interface QueueSnapshot {
  /** Actions running or waiting. */
  jobs: number;
  /** Emails across those actions, including those already done by the running one. */
  total: number;
  done: number;
  /** Rough time left, once a few batches have been timed. */
  etaMs?: number;
}

export interface ExecuteResult {
  entry: UndoEntry;
  skipped: number;
}

const BATCH = 50;
const LOG_KEY = 'undoLog';
const MAX_LOG = 50;

export const MOVE_KINDS: ActionKind[] = ['delete', 'move', 'archive'];

/**
 * User actions run one after another on a single queue. That queue is separate from any AI work, so you can
 * delete or move mail while a review or chat turn is still running, and queue up more actions without
 * waiting. Running them one at a time keeps IMAP moves and the undo log consistent.
 */
let tail: Promise<unknown> = Promise.resolve();

interface QueueJob {
  /** Emails this action will touch (an estimate until it starts and filters its targets). */
  total: number;
  done: number;
  onQueued?: (pos: QueuePosition) => void;
}

/** Running job first, then the waiting ones in order. */
const queue: QueueJob[] = [];
const listeners = new Set<(s: QueueSnapshot) => void>();
/** Measured cost of email-touching work this session, for the time estimate. */
let timedEmails = 0;
let timedMs = 0;
/** Ignore the estimate until this many emails have been timed, so one quick batch doesn't mislead. */
const MIN_TIMED = 20;

function notifyQueue(): void {
  queue.forEach((job, i) => {
    if (i === 0 || !job.onQueued) return;
    const ahead = queue.slice(0, i);
    job.onQueued({ jobsAhead: ahead.length, emailsAhead: ahead.reduce((n, j) => n + Math.max(0, j.total - j.done), 0) });
  });
  const s = queueSnapshot();
  for (const fn of listeners) fn(s);
}

function enqueue<T>(job: QueueJob, fn: () => Promise<T>): Promise<T> {
  queue.push(job);
  notifyQueue();
  const run = tail.then(fn, fn);
  tail = run
    .catch(() => undefined)
    .finally(() => {
      const i = queue.indexOf(job);
      if (i >= 0) queue.splice(i, 1);
      notifyQueue();
    });
  return run;
}

/** How many user actions are running or waiting. */
export function pendingActions(): number {
  return queue.length;
}

export function queueSnapshot(): QueueSnapshot {
  const total = queue.reduce((n, j) => n + j.total, 0);
  const done = queue.reduce((n, j) => n + Math.min(j.done, j.total), 0);
  const etaMs = timedEmails >= MIN_TIMED ? Math.round(((total - done) * timedMs) / timedEmails) : undefined;
  return { jobs: queue.length, total, done, etaMs };
}

/** Calls `fn` whenever the queue changes. Returns an unsubscribe function. */
export function onQueueChange(fn: (s: QueueSnapshot) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function executeAction(kind: ActionKind, messageIds: number[], opts: ExecuteOptions = {}): Promise<ExecuteResult> {
  const job: QueueJob = { total: new Set(messageIds).size, done: 0, onQueued: opts.onQueued };
  return enqueue(job, () => executeNow(kind, messageIds, opts, job));
}

async function executeNow(kind: ActionKind, messageIds: number[], opts: ExecuteOptions, job?: QueueJob): Promise<ExecuteResult> {
  if (kind === 'move' && !opts.folderId) throw new Error('A destination folder is required for move.');
  if (kind === 'tag' && !opts.tag) throw new Error('A tag is required.');

  const unique = [...new Set(messageIds.map(Number).filter(Number.isFinite))];
  const headers = await getHeaders(unique);
  let skipped = unique.length - headers.length;

  // Gmail: one copy per message (the Inbox one) — moving it covers its other labels and skips slow folder resyncs.
  let targets: MessageHeader[] = MOVE_KINDS.includes(kind) ? await collapseGmailCopies(headers) : headers;
  if (kind === 'delete') {
    // Already in Trash → deleting again would be permanent, so skip them.
    const before = targets.length;
    targets = targets.filter((h) => !hasUse(h.folder, 'trash'));
    skipped += before - targets.length;
  }
  if (kind === 'move') {
    const before = targets.length;
    targets = targets.filter((h) => h.folder?.id !== opts.folderId);
    skipped += before - targets.length;
  }

  const entry: UndoEntry = {
    id: `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    time: Date.now(),
    kind,
    label: `${ACTION_LABELS[kind]}${opts.tag ? ` "${opts.tag}"` : ''} — ${targets.length} email${targets.length === 1 ? '' : 's'}`,
    count: targets.length,
    destFolderIds: [],
    items: targets.map((h) => ({
      headerMessageId: h.headerMessageId,
      fromFolderId: h.folder?.id ?? '',
      accountId: h.folder?.accountId ?? '',
      prev: { read: !!h.read, junk: !!h.junk, flagged: !!h.flagged, tags: [...(h.tags ?? [])] },
    })),
    source: opts.source,
  };

  let done = 0;
  let batchStart = Date.now();
  if (job) {
    job.total = targets.length;
    notifyQueue();
  }
  // Lets the UI switch from "queued" to a 0/N progress bar as soon as this action starts.
  opts.onProgress?.(0, targets.length);
  const progress = (n: number) => {
    done += n;
    const now = Date.now();
    timedEmails += n;
    timedMs += now - batchStart;
    batchStart = now;
    opts.onProgress?.(done, targets.length);
    if (job) {
      job.done = done;
      notifyQueue();
    }
  };

  if (kind === 'delete') {
    const byAccount = groupBy(targets, (h) => h.folder?.accountId ?? '');
    for (const [accountId, list] of byAccount) {
      const trash = await trashFolderFor(accountId);
      if (trash) {
        entry.destFolderIds.push(trash.id);
        // One source folder at a time: Thunderbird syncs each folder it moves from, so progress moves per folder.
        for (const fromFolder of groupBy(list, (h) => h.folder?.id ?? '').values()) {
          for (const b of chunks(fromFolder, BATCH)) {
            await messenger.messages.move(b.map((h) => h.id), trash.id);
            progress(b.length);
          }
        }
      } else {
        for (const b of chunks(list, BATCH)) {
          await messenger.messages.delete(b.map((h) => h.id), false);
          progress(b.length);
        }
      }
    }
  } else if (kind === 'move') {
    entry.destFolderIds.push(opts.folderId!);
    for (const fromFolder of groupBy(targets, (h) => h.folder?.id ?? '').values()) {
      for (const b of chunks(fromFolder, BATCH)) {
        await messenger.messages.move(b.map((h) => h.id), opts.folderId);
        progress(b.length);
      }
    }
  } else if (kind === 'archive') {
    for (const b of chunks(targets, BATCH)) {
      await messenger.messages.archive(b.map((h) => h.id));
      progress(b.length);
    }
  } else {
    for (const b of chunks(targets, BATCH)) {
      await Promise.all(b.map((h) => messenger.messages.update(h.id, updateFor(kind, h, opts.tag))));
      progress(b.length);
    }
  }

  if (entry.count > 0) await pushUndo(entry);
  return { entry, skipped };
}

export function updateFor(kind: ActionKind, h: MessageHeader, tag?: string): Record<string, unknown> {
  switch (kind) {
    case 'mark_read':
      return { read: true };
    case 'mark_unread':
      return { read: false };
    case 'mark_junk':
      return { junk: true };
    case 'mark_not_junk':
      return { junk: false };
    case 'flag':
      return { flagged: true };
    case 'unflag':
      return { flagged: false };
    case 'tag':
      return { tags: [...new Set([...(h.tags ?? []), tag!])] };
    default:
      return {};
  }
}

export async function getUndoLog(): Promise<UndoEntry[]> {
  const s = await messenger.storage.local.get(LOG_KEY);
  return (s?.[LOG_KEY] as UndoEntry[]) ?? [];
}

async function pushUndo(entry: UndoEntry): Promise<void> {
  const log = await getUndoLog();
  log.unshift(entry);
  await messenger.storage.local.set({ [LOG_KEY]: log.slice(0, MAX_LOG) });
}

async function markUndone(id: string): Promise<void> {
  const log = await getUndoLog();
  const e = log.find((x) => x.id === id);
  if (e) e.undone = true;
  await messenger.storage.local.set({ [LOG_KEY]: log });
}

/** Finds the current copy of a message by its Message-ID header, wherever it is now. */
async function locate(item: UndoItem): Promise<MessageHeader[]> {
  if (!item.headerMessageId) return [];
  try {
    return await collectMessages({ headerMessageId: item.headerMessageId }, { limit: 10 });
  } catch {
    return [];
  }
}

export function undo(entryId: string, onProgress?: (done: number, total: number) => void): Promise<{ restored: number; missing: number }> {
  // Size is unknown until the log entry is read; the job counts in the queue once progress starts.
  const job: QueueJob = { total: 0, done: 0 };
  return enqueue(job, () =>
    undoNow(entryId, (done, total) => {
      job.total = total;
      job.done = done;
      notifyQueue();
      onProgress?.(done, total);
    }),
  );
}

async function undoNow(entryId: string, onProgress?: (done: number, total: number) => void): Promise<{ restored: number; missing: number }> {
  const entry = (await getUndoLog()).find((e) => e.id === entryId);
  if (!entry) throw new Error('That action is no longer in the undo history.');
  if (entry.undone) return { restored: 0, missing: 0 };

  let restored = 0;
  let missing = 0;
  let done = 0;
  const total = entry.items.length;
  // Nothing done yet → the UI shows a busy bar while the folders are read.
  onProgress?.(0, total);

  /**
   * Message-ID → current copies, read from the folders the emails should be in now, in ONE pass per folder.
   * Searching the whole mailbox once per email (526 searches for 526 emails) is what made Undo look frozen.
   * Emails not found there (moved again since, or an archive with no recorded destination) are looked up
   * one by one, which is the rare case.
   */
  const wanted = new Set(entry.items.map((i) => i.headerMessageId).filter(Boolean));
  const index = new Map<string, MessageHeader[]>();
  const indexFolders = async (folderIds: string[]) => {
    for (const folderId of new Set(folderIds.filter(Boolean))) {
      let found: MessageHeader[] = [];
      try {
        found = await collectMessages({ folderId }, { limit: 200000, filter: (m) => wanted.has(m.headerMessageId) });
      } catch {
        /* folder gone — fall back to per-email lookup */
      }
      for (const m of found) {
        const list = index.get(m.headerMessageId) ?? [];
        list.push(m);
        index.set(m.headerMessageId, list);
      }
    }
  };
  const find = async (item: UndoItem) => index.get(item.headerMessageId) ?? (await locate(item));

  if (MOVE_KINDS.includes(entry.kind)) {
    await indexFolders(entry.destFolderIds);
    const moves = new Map<string, number[]>();
    for (const item of entry.items) {
      const copies = await find(item);
      const moved = copies.find((c) => {
        const fid = c.folder?.id ?? '';
        if (fid === item.fromFolderId) return false;
        if (entry.destFolderIds.length) return entry.destFolderIds.includes(fid);
        // Archive: destination wasn't recorded; accept archive or trash folders.
        return hasUse(c.folder, 'archives', 'trash') || /archive/i.test(c.folder?.path ?? '');
      });
      const alreadyBack = copies.some((c) => c.folder?.id === item.fromFolderId);
      if (moved && item.fromFolderId) {
        const arr = moves.get(item.fromFolderId) ?? [];
        arr.push(moved.id);
        moves.set(item.fromFolderId, arr);
      } else {
        if (!alreadyBack) missing++;
        // Nothing to move for this one: count it as done straight away.
        done++;
      }
    }
    if (done) onProgress?.(done, total);
    for (const [folderId, ids] of moves) {
      for (const b of chunks(ids, BATCH)) {
        await messenger.messages.move(b, folderId);
        restored += b.length;
        done += b.length;
        onProgress?.(done, total);
      }
    }
  } else {
    await indexFolders(entry.items.map((i) => i.fromFolderId));
    for (const item of entry.items) {
      const copies = await find(item);
      const current = copies.find((c) => c.folder?.id === item.fromFolderId) ?? copies[0];
      if (!current) {
        missing++;
        onProgress?.(++done, total);
        continue;
      }
      await messenger.messages.update(current.id, {
        read: item.prev.read,
        junk: item.prev.junk,
        flagged: item.prev.flagged,
        tags: item.prev.tags,
      });
      restored++;
      onProgress?.(++done, total);
    }
  }
  await markUndone(entryId);
  return { restored, missing };
}

export function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function groupBy<T>(arr: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of arr) {
    const k = key(x);
    const list = m.get(k) ?? [];
    list.push(x);
    m.set(k, list);
  }
  return m;
}
