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
