import type { LlmClient } from './llm';
import { getKeptSenders, indexKept } from './feedback';
import { collectMessages, getMyAddresses, hasUse } from './mail';
import { groupBySender, scoreGroups } from './triage';
import { applySavedVerdicts, getSavedVerdicts, isFresh, scoreSenders, VERDICT_TTL_MS } from './junkScores';
import { discoverCategories, discoveryDue, getCategories, getMemberships, markDiscoveryRun, needsPlacing, placeSenders } from './smartCategories';

/**
 * Background scan that gives older mail a saved junk score, a little at a time.
 *
 * It walks back through the mailbox one month at a time. Each run (one alarm tick) scores at most
 * BACKFILL_SENDERS_PER_RUN senders, which is one AI request, so it never holds the model for long.
 * The caller skips runs while the AI is busy with anything else and aborts a run that is in progress
 * when a new request starts (see aiActivity.ts). It never changes any email.
 */

export const BACKFILL_KEY = 'junkBackfill';
export const BACKFILL_SENDERS_PER_RUN = 10;
/** Stop after this many months in a row with no mail at all (we've gone past the oldest email). */
const EMPTY_MONTHS_TO_FINISH = 36;
const EARLIEST_YEAR = 1990;
const QUERY_MS = 30_000;
const SKIP_FOLDERS = ['sent', 'drafts', 'templates', 'outbox', 'trash'];

export interface BackfillState {
  /** Month being scanned, "YYYY-MM". */
  month: string;
  emptyMonths: number;
  /** Senders in `month` the model gave no usable answer for; skipped until the scan moves on. */
  failed: string[];
  scored: number;
  startedAt: number;
  lastRunAt?: number;
  finishedAt?: number;
}

export function monthOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function freshState(now = Date.now()): BackfillState {
  return { month: monthOf(new Date(now)), emptyMonths: 0, failed: [], scored: 0, startedAt: now };
}

export async function getBackfillState(): Promise<BackfillState | null> {
  const s = await messenger.storage.local.get(BACKFILL_KEY);
  return (s?.[BACKFILL_KEY] as BackfillState) ?? null;
}

async function saveState(state: BackfillState): Promise<void> {
  await messenger.storage.local.set({ [BACKFILL_KEY]: state });
}

export async function resetBackfill(now = Date.now()): Promise<void> {
  await saveState(freshState(now));
}

function advance(state: BackfillState, hadMail: boolean, now: number): void {
  state.emptyMonths = hadMail ? 0 : state.emptyMonths + 1;
  state.failed = [];
  state.month = previousMonth(state.month);
  if (state.emptyMonths >= EMPTY_MONTHS_TO_FINISH || Number(state.month.slice(0, 4)) < EARLIEST_YEAR) state.finishedAt = now;
}

export type BackfillOutcome = 'scored' | 'advanced' | 'finished' | 'idle';

/**
 * One step of the scan. Throws AbortError if `signal` fires (whatever the model already answered is saved).
 * `sentTo` = addresses the user has written to (they're never junk, so they're not sent to the model).
 */
export async function runBackfillStep(deps: {
  llm: LlmClient;
  sentTo?: Set<string>;
  signal?: AbortSignal;
  now?: number;
  /** Give senders saved junk scores (default true). */
  scoreJunk?: boolean;
  /** Place senders in the user's smart categories once their junk scores are done (default false). */
  placeCategories?: boolean;
}): Promise<BackfillOutcome> {
  const scoreJunk = deps.scoreJunk ?? true;
  const now = deps.now ?? Date.now();
  let state = (await getBackfillState()) ?? freshState(now);
  if (state.finishedAt) {
    // Saved scores expire, so start over once the last full pass is that old.
    if (now - state.finishedAt < VERDICT_TTL_MS) return 'idle';
    state = freshState(now);
  }
  state.lastRunAt = now;

  const headers = await collectMessages(
    { fromDate: state.month, toDate: state.month },
    { signal: deps.signal, deadline: now + QUERY_MS, filter: (h) => !hasUse(h.folder, ...SKIP_FOLDERS) },
  );
  const [mine, kept, saved] = await Promise.all([getMyAddresses(), getKeptSenders().catch(() => []), getSavedVerdicts()]);
  const keptIdx = indexKept(kept);
  const failed = new Set(state.failed);
  const sentTo = deps.sentTo ?? new Set<string>();
  const groups = groupBySender(headers, mine, now);
  const todo = scoreJunk
    ? groups.filter(
        (g) => !keptIdx.addresses.has(g.address) && !sentTo.has(g.address) && !failed.has(g.address) && !isFresh(saved[g.address], g.count, now),
      )
    : [];

  if (!todo.length && deps.placeCategories && (await getCategories()).length) {
    // Junk scores for this month are done: place its senders in the smart categories (one AI request).
    scoreGroups(groups, now);
    applySavedVerdicts(groups, saved, now);
    const place = needsPlacing(groups, await getMemberships(), now)
      .filter((g) => !failed.has(g.address))
      .slice(0, BACKFILL_SENDERS_PER_RUN);
    if (place.length) {
      try {
        await placeSenders(deps.llm, place, { signal: deps.signal, now, max: place.length });
        // Anything still unplaced got no usable answer: skip it for the rest of this pass.
        const left = new Set(needsPlacing(place, await getMemberships(), now).map((g) => g.address));
        for (const g of place) if (left.has(g.address)) state.failed.push(g.address);
      } finally {
        await saveState(state);
      }
      return 'scored';
    }
  }

  if (!todo.length) {
    advance(state, headers.length > 0, now);
    await saveState(state);
    return state.finishedAt ? 'finished' : 'advanced';
  }

  // groupBySender sorts by volume, so the senders that matter most for a clean-up go first.
  const batch = todo.slice(0, BACKFILL_SENDERS_PER_RUN);
  try {
    state.scored += await scoreSenders(batch, deps.llm, kept, deps.signal, now);
    // The model answered but gave nothing usable for these: don't ask about them again this pass.
    // (If the request failed outright, e.g. the server is down, nothing is marked and the next run retries.)
    for (const g of batch) if (!g.ai) state.failed.push(g.address);
  } finally {
    await saveState(state);
  }
  return 'scored';
}

const DISCOVERY_DAYS = 90;

/**
 * Looks for new smart-category ideas in the last 90 days of mail, at most once a week (one AI request).
 * Suggestions wait for the user's approval in the chat. Returns how many were found, or null when not due.
 */
export async function runDiscoveryStep(deps: { llm: LlmClient; signal?: AbortSignal; now?: number }): Promise<number | null> {
  const now = deps.now ?? Date.now();
  if (!(await discoveryDue(now))) return null;
  await markDiscoveryRun(now); // before the AI call, so a failing server can't make it retry every minute
  const from = new Date(now - DISCOVERY_DAYS * 86_400_000);
  const headers = await collectMessages(
    { fromDate: `${monthOf(from)}-${String(from.getDate()).padStart(2, '0')}` },
    { signal: deps.signal, deadline: now + QUERY_MS, limit: 5000, filter: (h) => !hasUse(h.folder, ...SKIP_FOLDERS, 'junk') },
  );
  const groups = groupBySender(headers, await getMyAddresses(), now);
  scoreGroups(groups, now);
  applySavedVerdicts(groups, await getSavedVerdicts(), now);
  return (await discoverCategories(deps.llm, groups, { signal: deps.signal, now })).length;
}
