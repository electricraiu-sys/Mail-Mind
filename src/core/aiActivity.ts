import { llmActivity } from './llm';

/**
 * Tells the background junk scan when the AI is needed for something else (chat, popups, rules,
 * auto-tagging, the briefing), so the scan can pause and get out of the way.
 *
 * Importing this module turns reporting on for every normal-priority LlmClient in this page or script.
 * The state lives in storage so every page sees it, and a runtime message lets the background script
 * abort a scan request that is already running.
 */

export const AI_ACTIVITY_KEY = 'aiActivity';
export const AI_ACTIVITY_MESSAGE = 'mailmind-ai-activity';
/** The scan waits this long after the last request ends (the chat often sends several in a row). */
export const QUIET_MS = 60_000;
/** A request that never reports its end (page closed mid-stream) stops counting as busy after this. */
const MAX_REQUEST_MS = 10 * 60_000;

export interface AiActivity {
  /** Last start or end of a normal-priority request. */
  at: number;
  /** Busy until this time while requests are running in some page. */
  until: number;
}

const listeners = new Set<() => void>();
let running = 0;

function write(state: AiActivity): void {
  messenger.storage.local.set({ [AI_ACTIVITY_KEY]: state }).catch(() => {});
}

llmActivity.hook = (phase) => {
  const now = Date.now();
  if (phase === 'start') {
    running++;
    write({ at: now, until: now + MAX_REQUEST_MS });
    for (const fn of listeners) fn();
    // Doesn't reach listeners in the same script, which is why the local listeners above exist.
    messenger.runtime.sendMessage({ type: AI_ACTIVITY_MESSAGE }).catch(() => {});
  } else {
    running = Math.max(0, running - 1);
    if (!running) write({ at: now, until: now });
  }
};

export async function getAiActivity(): Promise<AiActivity> {
  const s = await messenger.storage.local.get(AI_ACTIVITY_KEY);
  const a = s?.[AI_ACTIVITY_KEY] as AiActivity | undefined;
  return { at: Number(a?.at) || 0, until: Number(a?.until) || 0 };
}

export function isAiBusy(a: AiActivity, now = Date.now()): boolean {
  return now < a.until || now - a.at < QUIET_MS;
}

/** Calls `fn` whenever a normal-priority AI request starts in any page or in this script. */
export function onAiActivity(fn: () => void): () => void {
  listeners.add(fn);
  const onMsg = (msg: any) => {
    if (msg?.type === AI_ACTIVITY_MESSAGE) fn();
    return undefined;
  };
  messenger.runtime.onMessage.addListener(onMsg);
  return () => {
    listeners.delete(fn);
    messenger.runtime.onMessage.removeListener(onMsg);
  };
}
