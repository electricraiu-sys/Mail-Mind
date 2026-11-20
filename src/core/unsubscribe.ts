import type { MessageHeader, Verdict } from './types';
import { collectMessages, getMyAddresses, getRawHeaders, getSentRecipients, hasUse, type SearchCriteria } from './mail';
import { groupBySender, mapLimit, scoreGroups, type SenderGroup } from './triage';
import { originPattern } from './settings';

/**
 * Unsubscribe assistant. Finding subscriptions is read-only. Unsubscribing contacts the sender's
 * server (one-click POST), opens their page in the browser, or opens a prefilled email the user
 * sends themselves. It only happens when the user clicks the button for that sender.
 */

export interface MailtoTarget {
  to: string;
  subject?: string;
  body?: string;
}

export interface UnsubInfo {
  https?: string;
  mailto?: MailtoTarget;
  /** RFC 8058: List-Unsubscribe-Post: List-Unsubscribe=One-Click */
  oneClick: boolean;
}

export type UnsubMethod = 'one-click' | 'web' | 'email';

export interface Subscription {
  address: string;
  name: string;
  count: number;
  unread: number;
  openRate: number;
  perMonth: number;
  firstDate: string;
  lastDate: string;
  info: UnsubInfo | null;
  listId?: string;
  verdict: Verdict;
  messageIds: number[];
  unsubscribedAt?: number;
  /** Emails received more than 2 days after unsubscribing. */
  sinceUnsubscribe?: number;
}

export interface SubscriptionResult {
  scanned: number;
  subscriptions: Subscription[];
}

const UNSUB_KEY = 'unsubscribed';

export function parseMailto(uri: string): MailtoTarget | null {
  const m = uri.match(/^mailto:([^?]+)(?:\?(.*))?$/i);
  if (!m) return null;
  let to: string;
  try {
    to = decodeURIComponent(m[1]).trim();
  } catch {
    to = m[1].trim();
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(to)) return null;
  const params = new URLSearchParams(m[2] ?? '');
  const get = (k: string) => {
    for (const [key, v] of params) if (key.toLowerCase() === k) return v;
    return undefined;
  };
  return { to, subject: get('subject'), body: get('body') };
}

export function parseListUnsubscribe(raw: Record<string, string[]>): UnsubInfo | null {
  const value = (raw['list-unsubscribe'] ?? []).join(',');
  const uris = [...value.matchAll(/<([^<>]+)>/g)].map((m) => m[1].trim());
  if (!uris.length && value.trim()) uris.push(...value.split(',').map((s) => s.trim()));
  let https: string | undefined;
  let mailto: MailtoTarget | undefined;
  for (const u of uris) {
    if (!https && /^https:\/\//i.test(u)) {
      try {
        https = new URL(u).href;
      } catch {
        /* ignore malformed */
      }
    } else if (!mailto && /^mailto:/i.test(u)) mailto = parseMailto(u) ?? undefined;
  }
  if (!https && !mailto) return null;
  const oneClick = !!https && (raw['list-unsubscribe-post'] ?? []).some((v) => /list-unsubscribe\s*=\s*one-click/i.test(v));
  return { https, mailto, oneClick };
}

export function bestMethod(info: UnsubInfo | null): UnsubMethod | null {
  if (!info) return null;
  if (info.oneClick) return 'one-click';
  if (info.https) return 'web';
  if (info.mailto) return 'email';
  return null;
}

/** Spam: unsubscribing just confirms the address is live. */
export function isUnsafeToUnsubscribe(s: Pick<Subscription, 'verdict'>): boolean {
  return s.verdict === 'junk';
}

export async function getUnsubscribed(): Promise<Record<string, { date: number; method: UnsubMethod }>> {
  const s = await messenger.storage.local.get(UNSUB_KEY);
  return (s?.[UNSUB_KEY] as Record<string, { date: number; method: UnsubMethod }>) ?? {};
}

async function recordUnsubscribe(address: string, method: UnsubMethod): Promise<void> {
  const map = await getUnsubscribed();
  map[address] = { date: Date.now(), method };
  await messenger.storage.local.set({ [UNSUB_KEY]: map });
}

export async function findSubscriptions(
  criteria: SearchCriteria,
  opts: { signal?: AbortSignal; onProgress?: (label: string, fraction?: number) => void; now?: Date } = {},
): Promise<SubscriptionResult> {
  const p = opts.onProgress ?? (() => {});
  const now = opts.now ?? new Date();
  p('Searching messages…');
  const headers: MessageHeader[] = (await collectMessages(criteria, { signal: opts.signal, onProgress: (n) => p(`Scanned ${n.toLocaleString()} messages…`) })).filter(
    (h) => !hasUse(h.folder, 'sent', 'drafts', 'templates', 'outbox'),
  );
  const groups = groupBySender(headers, await getMyAddresses());
  const sent = await getSentRecipients().catch(() => new Set<string>());
  for (const g of groups) g.youWroteTo = sent.has(g.address);

  const toSample = groups.filter((g) => !g.youWroteTo).slice(0, 300);
  const info = new Map<string, { info: UnsubInfo | null; listId?: string }>();
  let done = 0;
  await mapLimit(toSample, 4, async (g) => {
    if (opts.signal?.aborted) return;
    const raw = await getRawHeaders(g.messages[0].id);
    const parsed = parseListUnsubscribe(raw);
    const listId = raw['list-id']?.[0];
    g.hasUnsubscribe = !!(parsed || listId);
    g.bulk = (raw['precedence'] ?? []).some((v) => /bulk|list/i.test(v));
    if (g.hasUnsubscribe) info.set(g.address, { info: parsed, listId });
    done++;
    if (done % 10 === 0) p(`Inspecting senders… ${done}/${toSample.length}`, done / toSample.length);
  });
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  scoreGroups(groups);
  const unsubscribed = await getUnsubscribed();
  const subs = groups.filter((g) => info.has(g.address)).map((g) => toSubscription(g, info.get(g.address)!, unsubscribed[g.address], now));
  subs.sort((a, b) => noise(b) - noise(a));
  return { scanned: headers.length, subscriptions: subs };
}

function toSubscription(
  g: SenderGroup,
  i: { info: UnsubInfo | null; listId?: string },
  unsub: { date: number } | undefined,
  now: Date,
): Subscription {
  const first = g.firstDate ? new Date(g.firstDate).getTime() : now.getTime();
  const months = Math.max(1, (now.getTime() - first) / (30 * 86_400_000));
  const sub: Subscription = {
    address: g.address,
    name: g.name,
    count: g.count,
    unread: g.unread,
    openRate: g.count ? (g.count - g.unread) / g.count : 0,
    perMonth: Math.round((g.count / months) * 10) / 10,
    firstDate: g.firstDate.slice(0, 10),
    lastDate: g.lastDate.slice(0, 10),
    info: i.info,
    listId: i.listId,
    verdict: g.verdict,
    messageIds: g.messages.map((m) => m.id),
  };
  if (unsub) {
    sub.unsubscribedAt = unsub.date;
    const grace = unsub.date + 2 * 86_400_000;
    sub.sinceUnsubscribe = g.messages.filter((m) => new Date(m.date).getTime() > grace).length;
  }
  return sub;
}

/** Ranking: lots of mail you don't open comes first. */
export function noise(s: Pick<Subscription, 'count' | 'openRate'>): number {
  return s.count * (1 - s.openRate) + s.count * 0.1;
}

export interface UnsubOutcome {
  ok: boolean;
  method: UnsubMethod;
  message: string;
}

/**
 * Must be called straight from a click handler (no await before it), because
 * permissions.request only works during a user action.
 */
export async function unsubscribe(sub: Pick<Subscription, 'address' | 'info'>, method: UnsubMethod, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<UnsubOutcome> {
  const info = sub.info;
  if (method === 'one-click') {
    const url = info?.https;
    const pattern = url ? originPattern(url) : null;
    if (!url || !pattern || !info?.oneClick) return { ok: false, method, message: 'This sender has no one-click unsubscribe link.' };
    const granted = await messenger.permissions.request({ origins: [pattern] }).catch(() => false);
    if (!granted) return { ok: false, method, message: `Permission to contact ${new URL(url).host} was not granted.` };
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok && res.type !== 'opaqueredirect') return { ok: false, method, message: `The sender's server answered ${res.status}. Try the web page instead.` };
    } catch (e) {
      return { ok: false, method, message: `Couldn't reach the sender's server: ${(e as Error).message}` };
    }
    await recordUnsubscribe(sub.address, method);
    return { ok: true, method, message: 'Unsubscribed (one-click). It can take a few days to stop.' };
  }
  if (method === 'web') {
    if (!info?.https) return { ok: false, method, message: 'No unsubscribe web page.' };
    await messenger.windows.openDefaultBrowser(info.https);
    await recordUnsubscribe(sub.address, method);
    return { ok: true, method, message: 'Opened the unsubscribe page in your browser. Finish there.' };
  }
  if (!info?.mailto) return { ok: false, method, message: 'No unsubscribe email address.' };
  await messenger.compose.beginNew({
    to: [info.mailto.to],
    subject: info.mailto.subject || 'unsubscribe',
    isPlainText: true,
    plainTextBody: info.mailto.body || 'unsubscribe',
  });
  await recordUnsubscribe(sub.address, method);
  return { ok: true, method, message: 'Opened an unsubscribe email. Press Send in the compose window to finish.' };
}

export function describeMethod(m: UnsubMethod | null): string {
  return m === 'one-click' ? 'one-click' : m === 'web' ? 'web page' : m === 'email' ? 'by email' : 'no link';
}

export function summarizeSubscriptions(r: SubscriptionResult, top = 15): string {
  const lines = r.subscriptions
    .slice(0, top)
    .map(
      (s) =>
        `- ${s.name ? s.name + ' ' : ''}<${s.address}>: ${s.count} emails (~${s.perMonth}/month), opened ${Math.round(s.openRate * 100)}%, unsubscribe: ${describeMethod(bestMethod(s.info))}${isUnsafeToUnsubscribe(s) ? ' (looks like spam — mark as junk instead)' : ''}${s.sinceUnsubscribe ? ` — still sent ${s.sinceUnsubscribe} emails after unsubscribing` : ''}`,
    );
  return [
    `Scanned ${r.scanned} messages; found ${r.subscriptions.length} mailing lists/newsletters.`,
    lines.join('\n'),
    'A subscriptions card is shown to the user with Unsubscribe and "move old mail to Trash" buttons for each sender. Nothing has been done yet.',
  ].join('\n');
}
