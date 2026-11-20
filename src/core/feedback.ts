import { domainOf } from './text';
import { forgetSenders } from './junkScores';

/**
 * Senders the user has told us are NOT junk. Used three ways:
 *  1. that exact address is never flagged by the clean-up review or sent to the AI again;
 *  2. other senders on the same (non-freemail) domain get a nudge towards "keep";
 *  3. the most recent ones are listed in the AI classification prompt as examples of what the user wants.
 */
export interface KeptSender {
  address: string;
  name?: string;
  domain: string;
  /** One example subject, so the AI can see what kind of mail the user wants to keep. */
  sample?: string;
  at: number;
}

const KEY = 'keptSenders';
const MAX_KEPT = 2000;

/** Shared-mailbox domains where one address says nothing about another. */
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'gmx.de',
  'web.de', 'mail.com', 'yandex.com', 'yandex.ru', 'zoho.com', 'fastmail.com', 'hey.com', 'qq.com', '163.com',
]);

export function isFreemail(domain: string): boolean {
  return FREEMAIL.has(domain.toLowerCase());
}

export async function getKeptSenders(): Promise<KeptSender[]> {
  const s = await messenger.storage.local.get(KEY);
  return (s?.[KEY] as KeptSender[]) ?? [];
}

export async function keepSender(s: { address: string; name?: string; sample?: string }): Promise<void> {
  const address = s.address.toLowerCase();
  const list = (await getKeptSenders()).filter((k) => k.address !== address);
  list.unshift({ address, name: s.name || undefined, domain: domainOf(address), sample: s.sample?.slice(0, 120), at: Date.now() });
  await messenger.storage.local.set({ [KEY]: list.slice(0, MAX_KEPT) });
  // "Not junk" and "Junk" are opposites: the latest answer wins.
  await unmarkJunkSender(address);
  // The user's word replaces the model's: if they later undo this, the sender is judged afresh rather than
  // falling back to an old AI verdict.
  await forgetSenders([address]);
}

export async function unkeepSender(address: string): Promise<void> {
  const a = address.toLowerCase();
  await messenger.storage.local.set({ [KEY]: (await getKeptSenders()).filter((k) => k.address !== a) });
}

export interface KeptIndex {
  addresses: Set<string>;
  domains: Set<string>;
  list: KeptSender[];
}

export function indexKept(list: KeptSender[]): KeptIndex {
  return {
    addresses: new Set(list.map((k) => k.address)),
    domains: new Set(list.map((k) => k.domain).filter((d) => d && !isFreemail(d))),
    list,
  };
}

/** Prompt addition listing recent "not junk" senders (bounded so it can't crowd the context window). */
export function keptPromptHint(list: KeptSender[], max = 15): string {
  if (!list.length) return '';
  const lines = list
    .slice(0, max)
    .map((k) => `- ${k.name ? `${k.name.slice(0, 40)} ` : ''}<${k.address}>${k.sample ? ` e.g. "${k.sample.slice(0, 60)}"` : ''}`);
  return `\nThe user has told us these senders are NOT junk. Treat similar senders (same organisation, same kind of mail) as wanted:\n${lines.join('\n')}`;
}

/*
 * Senders the user has told us ARE junk (the "👎 Junk" button). The mirror image of the list above:
 *  1. that exact address is always shown as junk and never sent to the AI again;
 *  2. other senders on the same (non-freemail) domain get a nudge towards junk;
 *  3. the most recent ones are listed in the AI prompt as examples of mail the user doesn't want.
 * It only teaches MailMind; no email is moved or deleted.
 */
const JUNK_KEY = 'junkSenders';

export async function getJunkSenders(): Promise<KeptSender[]> {
  const s = await messenger.storage.local.get(JUNK_KEY);
  return (s?.[JUNK_KEY] as KeptSender[]) ?? [];
}

export async function markJunkSender(s: { address: string; name?: string; sample?: string }): Promise<void> {
  const address = s.address.toLowerCase();
  const list = (await getJunkSenders()).filter((k) => k.address !== address);
  list.unshift({ address, name: s.name || undefined, domain: domainOf(address), sample: s.sample?.slice(0, 120), at: Date.now() });
  await messenger.storage.local.set({ [JUNK_KEY]: list.slice(0, MAX_KEPT) });
  await unkeepSender(address);
  await forgetSenders([address]);
}

export async function unmarkJunkSender(address: string): Promise<void> {
  const a = address.toLowerCase();
  const list = await getJunkSenders();
  if (list.some((k) => k.address === a)) await messenger.storage.local.set({ [JUNK_KEY]: list.filter((k) => k.address !== a) });
}

/** Prompt addition listing recent senders the user called junk. */
export function junkPromptHint(list: KeptSender[], max = 15): string {
  if (!list.length) return '';
  const lines = list
    .slice(0, max)
    .map((k) => `- ${k.name ? `${k.name.slice(0, 40)} ` : ''}<${k.address}>${k.sample ? ` e.g. "${k.sample.slice(0, 60)}"` : ''}`);
  return `\nThe user has told us these senders ARE junk. Treat similar mail (same organisation, same kind of mail) as unwanted:\n${lines.join('\n')}`;
}

/*
 * Feedback on single emails (the 👍 / 👎 next to each email in the clean-up review). More specific than the
 * sender lists: "the invoices from this shop matter, the review requests don't". An entry matches an email by
 * id, or by sender + identical subject (ids change when Thunderbird moves mail, and duplicates get the same
 * answer). Like the sender lists, it only teaches MailMind; no email is moved.
 */
export type EmailVerdict = 'keep' | 'junk';

export interface EmailFeedback {
  id: number;
  address: string;
  subject: string;
  verdict: EmailVerdict;
  at: number;
}

const EMAIL_KEY = 'emailFeedback';
const MAX_EMAILS = 2000;

const emailKey = (address: string, subject: string) => `${address.toLowerCase()}\n${subject.trim().toLowerCase()}`;

export async function getEmailFeedback(): Promise<EmailFeedback[]> {
  const s = await messenger.storage.local.get(EMAIL_KEY);
  return (s?.[EMAIL_KEY] as EmailFeedback[]) ?? [];
}

/** Records the user's verdict on these emails; null forgets it. The latest answer wins. */
export async function setEmailFeedback(emails: { id: number; address: string; subject: string }[], verdict: EmailVerdict | null): Promise<void> {
  const ids = new Set(emails.map((e) => e.id));
  const keys = new Set(emails.map((e) => emailKey(e.address, e.subject)));
  const list = (await getEmailFeedback()).filter((f) => !ids.has(f.id) && !keys.has(emailKey(f.address, f.subject)));
  if (verdict) {
    const at = Date.now();
    const added = new Set<string>();
    for (const e of emails) {
      const k = emailKey(e.address, e.subject);
      if (added.has(k)) continue; // duplicates are matched by subject anyway
      added.add(k);
      list.unshift({ id: e.id, address: e.address.toLowerCase(), subject: e.subject.slice(0, 200), verdict, at });
    }
  }
  await messenger.storage.local.set({ [EMAIL_KEY]: list.slice(0, MAX_EMAILS) });
}

export interface EmailFeedbackIndex {
  verdictOf(m: { id: number; subject: string }, address: string): EmailVerdict | undefined;
}

export function indexEmailFeedback(list: EmailFeedback[]): EmailFeedbackIndex {
  const byId = new Map<number, EmailVerdict>();
  const byKey = new Map<string, EmailVerdict>();
  // Newest first in storage, so the first entry seen for a key is the latest answer.
  for (const f of list) {
    if (!byId.has(f.id)) byId.set(f.id, f.verdict);
    const k = emailKey(f.address, f.subject);
    if (!byKey.has(k)) byKey.set(k, f.verdict);
  }
  return { verdictOf: (m, address) => byId.get(m.id) ?? byKey.get(emailKey(address, m.subject)) };
}

/** Prompt addition with example emails the user judged one by one. */
export function emailPromptHint(list: EmailFeedback[], max = 10): string {
  const line = (f: EmailFeedback) => `- <${f.address}> "${f.subject.slice(0, 70)}"`;
  const keep = list.filter((f) => f.verdict === 'keep').slice(0, max);
  const junk = list.filter((f) => f.verdict === 'junk').slice(0, max);
  return (
    (keep.length ? `\nSingle emails the user said they WANT (mail like these is worth keeping):\n${keep.map(line).join('\n')}` : '') +
    (junk.length ? `\nSingle emails the user said are JUNK (mail like these is unwanted, even from senders they otherwise keep):\n${junk.map(line).join('\n')}` : '')
  );
}

/** All feedback lists as one prompt addition. */
export function feedbackPromptHint(kept: KeptSender[], junk: KeptSender[], emails: EmailFeedback[] = []): string {
  return keptPromptHint(kept) + junkPromptHint(junk) + emailPromptHint(emails);
}
