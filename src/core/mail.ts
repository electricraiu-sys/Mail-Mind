import type { MailFolder, MessageHeader } from './types';
import { htmlToText, parseAddress, normalizeWhitespace, stripQuotedText, truncate, parseMessageIds } from './text';

/** Thin, defensive wrappers around Thunderbird's messenger.* APIs (TB 128+, MV3). */

export const NON_MAIL_FOLDERS = ['sent', 'drafts', 'templates', 'outbox'];
export const NOT_A_DESTINATION = ['inbox', 'sent', 'drafts', 'templates', 'outbox', 'trash', 'junk'];

let accountNames: Map<string, string> | null = null;

export async function getAccountNames(): Promise<Map<string, string>> {
  if (accountNames) return accountNames;
  const accounts: any[] = await messenger.accounts.list(false);
  accountNames = new Map(accounts.map((a) => [a.id, a.name]));
  return accountNames;
}

export async function getMyAddresses(): Promise<string[]> {
  const out = new Set<string>();
  try {
    const accounts: any[] = await messenger.accounts.list(false);
    for (const a of accounts) for (const id of a.identities ?? []) if (id.email) out.add(String(id.email).toLowerCase());
  } catch {
    /* identities permission missing */
  }
  return [...out];
}

function flatten(folders: MailFolder[] | undefined, out: MailFolder[]) {
  for (const f of folders ?? []) {
    out.push(f);
    flatten(f.subFolders, out);
  }
}

export async function listFolders(): Promise<MailFolder[]> {
  try {
    const all: MailFolder[] = await messenger.folders.query({});
    if (Array.isArray(all) && all.length) return all.filter((f: any) => !f.isRoot);
  } catch {
    /* fall back to walking accounts */
  }
  const accounts: any[] = await messenger.accounts.list(true);
  const out: MailFolder[] = [];
  for (const a of accounts) flatten(a.rootFolder?.subFolders ?? a.folders, out);
  return out;
}

export function hasUse(f: MailFolder | undefined, ...uses: string[]): boolean {
  return !!f?.specialUse?.some((u) => uses.includes(u));
}

export async function folderLabel(f: MailFolder): Promise<string> {
  const names = await getAccountNames();
  return `${names.get(f.accountId) ?? f.accountId}${f.path}`;
}

export async function resolveFolder(idOrName: string | undefined): Promise<MailFolder | null> {
  if (!idOrName) return null;
  const folders = await listFolders();
  const want = idOrName.trim().toLowerCase();
  return (
    folders.find((f) => f.id === idOrName) ??
    folders.find((f) => f.path.toLowerCase() === want || f.path.toLowerCase() === `/${want}`) ??
    folders.find((f) => f.name.toLowerCase() === want) ??
    folders.find((f) => f.path.toLowerCase().endsWith(`/${want}`)) ??
    null
  );
}

export async function trashFolderFor(accountId: string): Promise<MailFolder | null> {
  try {
    const found: MailFolder[] = await messenger.folders.query({ accountId, specialUse: ['trash'] });
    if (found?.length) return found[0];
  } catch {
    /* ignore */
  }
  const folders = await listFolders();
  return (
    folders.find((f) => f.accountId === accountId && hasUse(f, 'trash')) ??
    folders.find((f) => f.accountId === accountId && /^(trash|deleted( items| messages)?)$/i.test(f.name)) ??
    null
  );
}

export interface SearchCriteria {
  fromDate?: string;
  toDate?: string;
  author?: string;
  subject?: string;
  body?: string;
  fullText?: string;
  folderId?: string;
  accountId?: string;
  unread?: boolean;
  flagged?: boolean;
  junk?: boolean;
  headerMessageId?: string;
  includeSubFolders?: boolean;
  hasAttachment?: boolean;
}

/** Parses "2021", "2021-03" or "2021-03-15" in local time (start or end of that period). */
export function parseDate(s: string | undefined, endOfPeriod: boolean): Date | undefined {
  if (!s) return undefined;
  const t = String(s).trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d{4})$/))) {
    const y = Number(m[1]);
    return endOfPeriod ? new Date(y, 11, 31, 23, 59, 59, 999) : new Date(y, 0, 1);
  }
  if ((m = t.match(/^(\d{4})-(\d{1,2})$/))) {
    const [y, mo] = [Number(m[1]), Number(m[2])];
    return endOfPeriod ? new Date(y, mo, 0, 23, 59, 59, 999) : new Date(y, mo - 1, 1);
  }
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return endOfPeriod ? new Date(y, mo - 1, d, 23, 59, 59, 999) : new Date(y, mo - 1, d);
  }
  const d = new Date(t);
  return isNaN(d.getTime()) ? undefined : d;
}

export function buildQuery(c: SearchCriteria): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const from = parseDate(c.fromDate, false);
  const to = parseDate(c.toDate, true);
  if (from) q.fromDate = from;
  if (to) q.toDate = to;
  if (c.author) q.author = c.author;
  if (c.subject) q.subject = c.subject;
  if (c.body) q.body = c.body;
  if (c.fullText) q.fullText = c.fullText;
  if (c.folderId) {
    q.folderId = c.folderId;
    if (c.includeSubFolders) q.includeSubFolders = true;
  }
  if (c.accountId) q.accountId = c.accountId;
  if (typeof c.unread === 'boolean') q.read = !c.unread;
  if (typeof c.flagged === 'boolean') q.flagged = c.flagged;
  if (typeof c.junk === 'boolean') q.junk = c.junk;
  if (c.headerMessageId) q.headerMessageId = c.headerMessageId;
  if (c.hasAttachment) q.attachment = true;
  return q;
}

export interface CollectOptions {
  limit?: number;
  /** count = messages kept so far, scanned = messages looked at so far. */
  onProgress?: (count: number, scanned: number) => void;
  signal?: AbortSignal;
  /** Keep only messages passing this test; `limit` counts kept messages. */
  filter?: (m: MessageHeader) => boolean;
  /** Give up (keeping partial results) once Date.now() passes this. */
  deadline?: number;
  /** Filled in on return: how many messages were scanned and whether the search ran to the end. */
  stats?: { scanned: number; complete: boolean };
}

const TIMED_OUT = Symbol('timeout');

/** Awaits p, but rejects at once on abort and resolves TIMED_OUT at the deadline (a pending TB search can take minutes). */
function guard<T>(p: Promise<T>, signal?: AbortSignal, deadline?: number): Promise<T | typeof TIMED_OUT> {
  if (!signal && deadline === undefined) return p;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')));
    const finish = (f: () => void) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      f();
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (deadline !== undefined) timer = setTimeout(() => finish(() => resolve(TIMED_OUT)), Math.max(0, deadline - Date.now()));
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

/** Starts a query; prefers getting the list id first (TB 121+) so a slow search can be aborted. */
async function startQuery(q: Record<string, unknown>): Promise<{ listId: string | null; firstPage: any | null }> {
  try {
    const r = await messenger.messages.query({ ...q, returnMessageListId: true });
    if (typeof r === 'string') return { listId: r, firstPage: null };
    return { listId: r?.id ?? null, firstPage: r };
  } catch (e) {
    if (!/returnMessageListId/i.test(String((e as any)?.message ?? e))) throw e;
    const r = await messenger.messages.query(q);
    return { listId: r?.id ?? null, firstPage: r };
  }
}

/** Runs messages.query and walks every page. Abortable mid-search; stops at `deadline` with partial results. */
export async function collectMessages(criteria: SearchCriteria, opts: CollectOptions = {}): Promise<MessageHeader[]> {
  const limit = opts.limit ?? 20000;
  const out: MessageHeader[] = [];
  const stats = opts.stats ?? { scanned: 0, complete: true };
  stats.scanned = 0;
  stats.complete = true;
  let listId: string | null = null;
  const abortList = async () => {
    if (!listId) return;
    try {
      await messenger.messages.abortList(listId);
    } catch {
      /* not supported / already finished */
    }
  };
  try {
    const start = await guard(startQuery(buildQuery(criteria)), opts.signal, opts.deadline);
    if (start === TIMED_OUT) {
      stats.complete = false;
      return out;
    }
    listId = start.listId;
    let page = start.firstPage ?? (listId ? await guard(messenger.messages.continueList(listId), opts.signal, opts.deadline) : null);
    for (;;) {
      if (page === TIMED_OUT) {
        stats.complete = false;
        await abortList();
        break;
      }
      for (const m of page?.messages ?? []) {
        stats.scanned++;
        if (opts.filter && !opts.filter(m)) continue;
        out.push(m);
        if (out.length >= limit) break;
      }
      opts.onProgress?.(out.length, stats.scanned);
      listId = page?.id ?? null;
      if (!listId) break;
      if (out.length >= limit) {
        stats.complete = false;
        await abortList();
        break;
      }
      page = await guard(messenger.messages.continueList(listId), opts.signal, opts.deadline);
    }
  } catch (e) {
    await abortList();
    throw e;
  }
  return out;
}

export async function getHeader(id: number): Promise<MessageHeader | null> {
  try {
    return await messenger.messages.get(id);
  } catch {
    return null;
  }
}

export async function getHeaders(ids: number[]): Promise<MessageHeader[]> {
  const out: MessageHeader[] = [];
  for (let i = 0; i < ids.length; i += 25) {
    const batch = await Promise.all(ids.slice(i, i + 25).map(getHeader));
    for (const h of batch) if (h) out.push(h);
  }
  return out;
}

function walkParts(part: any, acc: { plain: string[]; html: string[] }) {
  if (!part) return;
  const type = String(part.contentType ?? '').toLowerCase();
  const isAttachment = part.headers?.['content-disposition']?.some?.((d: string) => /attachment/i.test(d));
  if (typeof part.body === 'string' && !isAttachment) {
    if (type.startsWith('text/plain')) acc.plain.push(part.body);
    else if (type.startsWith('text/html')) acc.html.push(part.body);
  }
  for (const p of part.parts ?? []) walkParts(p, acc);
}

/** Readable body text for a message: prefers text/plain, falls back to converted HTML. */
export async function getBodyText(id: number): Promise<string> {
  try {
    if (messenger.messages.listInlineTextParts) {
      const parts: any[] = await messenger.messages.listInlineTextParts(id);
      const plain = parts.filter((p) => /text\/plain/i.test(p.contentType)).map((p) => p.content);
      if (plain.join('').trim()) return normalizeWhitespace(plain.join('\n\n'));
      const html = parts.filter((p) => /text\/html/i.test(p.contentType)).map((p) => p.content);
      if (html.length) return htmlToText(html.join('\n'));
    }
  } catch {
    /* fall back to getFull */
  }
  const full = await messenger.messages.getFull(id);
  const acc = { plain: [] as string[], html: [] as string[] };
  walkParts(full, acc);
  if (acc.plain.join('').trim()) return normalizeWhitespace(acc.plain.join('\n\n'));
  return htmlToText(acc.html.join('\n'));
}

/** Raw headers (lowercased keys → values). */
export async function getRawHeaders(id: number): Promise<Record<string, string[]>> {
  try {
    const full = await messenger.messages.getFull(id);
    return full?.headers ?? {};
  } catch {
    return {};
  }
}

export interface MessageAttachment {
  name: string;
  size: number;
  contentType: string;
  partName: string;
}

export async function listAttachments(id: number): Promise<MessageAttachment[]> {
  try {
    return await messenger.messages.listAttachments(id);
  } catch {
    return [];
  }
}

export async function openMessage(id: number): Promise<void> {
  try {
    await messenger.messageDisplay.open({ messageId: id, location: 'tab', active: true });
  } catch {
    await messenger.messageDisplay.open({ messageId: id });
  }
}

export async function messageFolderUses(): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const f of await listFolders()) map.set(f.id, f.specialUse ?? []);
  return map;
}

export async function sentFolders(): Promise<MailFolder[]> {
  return (await listFolders()).filter((f) => hasUse(f, 'sent'));
}

export async function inboxFolders(): Promise<MailFolder[]> {
  return (await listFolders()).filter((f) => hasUse(f, 'inbox'));
}

/** Message-IDs this message replies to (References + In-Reply-To), oldest first. */
export function threadIdsFrom(raw: Record<string, string[]>): string[] {
  const refs = parseMessageIds(raw['references']);
  for (const id of parseMessageIds(raw['in-reply-to'])) if (!refs.includes(id)) refs.push(id);
  return refs;
}

export async function findByMessageId(messageId: string): Promise<MessageHeader | null> {
  try {
    const [m] = await collectMessages({ headerMessageId: messageId.replace(/^<|>$/g, '') }, { limit: 1 });
    return m ?? null;
  } catch {
    return null;
  }
}

/** Addresses the user has written to (from Sent folders). */
export async function getSentRecipients(limit = 10000): Promise<Set<string>> {
  const out = new Set<string>();
  const folders = await sentFolders();
  for (const f of folders) {
    try {
      const msgs = await collectMessages({ folderId: f.id }, { limit });
      for (const m of msgs) for (const r of [...(m.recipients ?? []), ...(m.ccList ?? [])]) out.add(parseAddress(r).address);
    } catch {
      /* folder may be unavailable */
    }
  }
  return out;
}

/** A few short samples of the user's own writing, used to imitate their style. */
export async function getStyleSamples(count = 3): Promise<string[]> {
  const folders = await sentFolders();
  const samples: string[] = [];
  for (const f of folders) {
    try {
      const msgs = await collectMessages({ folderId: f.id }, { limit: 400 });
      msgs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      for (const m of msgs.slice(0, 10)) {
        const text = truncate(stripQuotedText(await getBodyText(m.id)), 500);
        if (text.length > 60) samples.push(text);
        if (samples.length >= count) return samples;
      }
    } catch {
      /* ignore */
    }
  }
  return samples;
}

export function headerLine(m: MessageHeader): string {
  const date = m.date ? new Date(m.date).toISOString().slice(0, 10) : '';
  const flags = [m.read ? '' : 'unread', m.flagged ? 'flagged' : '', m.junk ? 'junk' : ''].filter(Boolean).join(',');
  return `[${m.id}] ${date} | ${m.author} | ${m.subject || '(no subject)'} | ${m.folder?.path ?? ''}${flags ? ' | ' + flags : ''}`;
}

export interface IndexHits {
  term: string;
  ids: number[];
  /** False if the term had more matches than the lookup returns. */
  complete: boolean;
}

/**
 * Looks terms up in Thunderbird's Global Search index (MailMind's read-only Experiment API).
 * Near-instant, unlike messages.query's text search. Returns null when the index can't be used
 * (indexing switched off, Experiment missing or broken by a Thunderbird update), so callers fall back.
 */
export async function searchIndex(terms: string[], c: SearchCriteria, timeoutMs = 30_000): Promise<IndexHits[] | null> {
  const api = (globalThis as any).messenger?.glodaSearch;
  if (!api || !terms.length) return null;
  try {
    if (!(await api.isAvailable())) return null;
    const opts: Record<string, number> = { limit: 5000, timeoutMs };
    const from = parseDate(c.fromDate, false);
    const to = parseDate(c.toDate, true);
    if (from) opts.fromDate = from.getTime();
    if (to) opts.toDate = to.getTime();
    const r = await api.search(terms, opts);
    return Array.isArray(r) ? r : null;
  } catch {
    return null;
  }
}

/**
 * Which messages have attachments, answered from header flags and Thunderbird's index without
 * opening them (Experiment API). Ids missing from the result are unknown. Empty map if unavailable.
 */
export async function attachmentFlags(ids: number[], timeoutMs = 30_000): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>();
  const api = (globalThis as any).messenger?.glodaSearch;
  if (!api?.attachmentInfo || !ids.length) return out;
  try {
    const r = await api.attachmentInfo(ids, { timeoutMs });
    for (const x of Array.isArray(r) ? r : []) if (typeof x?.id === 'number') out.set(x.id, !!x.has);
  } catch {
    /* fall back to opening messages */
  }
  return out;
}
