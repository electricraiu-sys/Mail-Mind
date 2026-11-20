import type { MessageHeader, Verdict } from './types';
import { VERDICTS } from './types';
import type { LlmClient } from './llm';
import { feedbackPromptHint, getEmailFeedback, getJunkSenders, getKeptSenders, indexKept, type KeptSender } from './feedback';
import { getRawHeaders } from './mail';
import { applyAiVerdict, classifyWithAi, groupBySender, mapLimit, scoreGroups, type SenderGroup } from './triage';

/**
 * Saved AI junk verdicts, one per sender, so a later clean-up doesn't ask the model about the same sender again.
 *
 * Only the model's own opinion is stored. Everything the user can change is read fresh on every clean-up and
 * always wins over a saved verdict:
 *  - "Not junk" / "Junk" in MailMind (feedback.ts): the sender is kept or junked, and its saved verdict is deleted;
 *  - "Not junk" / "Junk" in Thunderbird: the saved verdict for that sender is deleted (see forgetSenders);
 *  - writing to the sender, flagging their mail, opening it: heuristics recompute these on every run.
 * A saved verdict also goes stale after VERDICT_TTL_MS, or once the sender has sent far more mail than the
 * model saw when it judged them.
 */
export interface SavedVerdict {
  verdict: Verdict;
  confidence: number;
  reason: string;
  /** Emails from this sender the model was shown. */
  count: number;
  at: number;
  /** SCORES_VERSION when saved; older scores are redone (e.g. from before "order" existed). */
  v?: number;
}

/** Bump when the categories or the prompt change enough that old verdicts shouldn't be reused. */
export const SCORES_VERSION = 3;

export const JUNK_SCORES_KEY = 'junkScores';
export const VERDICT_TTL_MS = 60 * 86_400_000;
const MAX_SAVED = 5000;

export async function getSavedVerdicts(): Promise<Record<string, SavedVerdict>> {
  const s = await messenger.storage.local.get(JUNK_SCORES_KEY);
  return (s?.[JUNK_SCORES_KEY] as Record<string, SavedVerdict>) ?? {};
}

/** True when a saved verdict can be reused for a sender who now has `count` emails in the scan. */
export function isFresh(v: SavedVerdict | undefined, count: number, now = Date.now()): v is SavedVerdict {
  if (!v || v.v !== SCORES_VERSION || !VERDICTS.includes(v.verdict)) return false;
  if (now - v.at > VERDICT_TTL_MS) return false;
  // Judged on only 1–2 emails but there are now plenty: look again with the bigger picture.
  if (v.count < 3 && count >= 10) return false;
  return true;
}

// Writes in this page/background script run one at a time so read-modify-write cycles don't overwrite each other.
let chain: Promise<unknown> = Promise.resolve();
function update(fn: (map: Record<string, SavedVerdict>) => boolean): Promise<void> {
  const next = chain.then(async () => {
    const map = await getSavedVerdicts();
    if (!fn(map)) return;
    const entries = Object.entries(map);
    const trimmed = entries.length > MAX_SAVED ? Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SAVED)) : map;
    await messenger.storage.local.set({ [JUNK_SCORES_KEY]: trimmed });
  });
  chain = next.catch(() => {});
  return next;
}

/** Saves the model's verdicts for groups it just classified (groups without `ai` are skipped). */
export function saveVerdicts(groups: SenderGroup[], now = Date.now()): Promise<void> {
  const fresh = groups.filter((g) => g.ai && !g.userKept && !g.userJunk);
  if (!fresh.length) return Promise.resolve();
  return update((map) => {
    for (const g of fresh) map[g.address] = { ...g.ai!, count: Math.max(g.count, map[g.address]?.count ?? 0), at: now, v: SCORES_VERSION };
    return true;
  });
}

/** Deletes saved verdicts, e.g. after the user said a sender is (or isn't) junk. */
export function forgetSenders(addresses: string[]): Promise<void> {
  const list = addresses.map((a) => a.toLowerCase()).filter(Boolean);
  if (!list.length) return Promise.resolve();
  return update((map) => {
    let changed = false;
    for (const a of list) if (a in map) changed = delete map[a];
    return changed;
  });
}

export function clearSavedVerdicts(): Promise<void> {
  return update((map) => {
    for (const k of Object.keys(map)) delete map[k];
    return true;
  });
}

/**
 * Applies saved verdicts to freshly scored groups and marks them `cached` so pickForAi skips them.
 * Call after scoreGroups and before applyKept, so the user's "not junk" list still overrides them.
 */
export function applySavedVerdicts(groups: SenderGroup[], saved: Record<string, SavedVerdict>, now = Date.now()): number {
  let n = 0;
  for (const g of groups) {
    const v = saved[g.address];
    if (g.youWroteTo || g.userKept || !isFresh(v, g.count, now)) continue;
    applyAiVerdict(g, v.verdict, v.confidence, v.reason);
    g.cached = true;
    n++;
  }
  return n;
}

export const NEW_MAIL_MAX_SENDERS = 30;

/**
 * Runs when new mail arrives: asks the model about senders it hasn't judged yet and saves the verdicts.
 * Read-only — never changes any email. Returns how many senders were scored.
 */
export async function scoreNewMail(
  headers: MessageHeader[],
  llm: LlmClient,
  deps: { myAddresses?: string[]; sentTo?: Set<string>; signal?: AbortSignal; now?: number; maxSenders?: number } = {},
): Promise<number> {
  const now = deps.now ?? Date.now();
  const sentTo = deps.sentTo ?? new Set<string>();
  const kept = await getKeptSenders().catch(() => []);
  const keptIdx = indexKept(kept);
  const junkIdx = indexKept(await getJunkSenders().catch(() => []));
  const saved = await getSavedVerdicts();

  const groups = groupBySender(headers, deps.myAddresses ?? []).filter(
    (g) => !keptIdx.addresses.has(g.address) && !junkIdx.addresses.has(g.address) && !sentTo.has(g.address) && !isFresh(saved[g.address], g.count, now),
  );
  return scoreSenders(groups.slice(0, deps.maxSenders ?? NEW_MAIL_MAX_SENDERS), llm, kept, deps.signal, now);
}

/** Classifies sender groups with heuristics + AI and saves the AI verdicts (even if aborted part-way). */
export async function scoreSenders(
  todo: SenderGroup[],
  llm: LlmClient,
  kept: KeptSender[],
  signal?: AbortSignal,
  now = Date.now(),
): Promise<number> {
  if (!todo.length) return 0;

  await mapLimit(todo, 4, async (g) => {
    if (signal?.aborted) return;
    const hdrs = await getRawHeaders(g.messages[0].id);
    g.hasUnsubscribe = !!(hdrs['list-unsubscribe']?.length || hdrs['list-id']?.length);
    g.bulk = (hdrs['precedence'] ?? []).some((v) => /bulk|list/i.test(v));
  });
  scoreGroups(todo);
  const junk = await getJunkSenders().catch(() => []);
  const emails = await getEmailFeedback().catch(() => []);
  try {
    await classifyWithAi(llm, todo, { signal, hint: feedbackPromptHint(kept, junk, emails) });
  } finally {
    await saveVerdicts(todo, now);
  }
  return todo.filter((g) => g.ai).length;
}
