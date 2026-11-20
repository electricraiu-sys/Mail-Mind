import type { ChatMessage } from './llm';

/**
 * Saved chat conversations. A small index (titles and dates) lives under one key and each
 * conversation's messages under their own key, so saving one conversation doesn't rewrite them all.
 */

export interface ConversationMeta {
  id: string;
  title: string;
  created: number;
  updated: number;
  /** Visible messages (questions and answers), for the history list. */
  count: number;
}

export interface Conversation {
  id: string;
  title: string;
  created: number;
  messages: ChatMessage[];
}

const INDEX_KEY = 'chatIndex';
const CURRENT_KEY = 'chatCurrentId';
const LEGACY_KEY = 'chatHistory';
const msgKey = (id: string) => `chat:${id}`;

/** Messages kept per conversation (the model only sees the most recent ones anyway). */
export const MAX_MESSAGES = 80;
/** Conversations kept; the oldest are dropped beyond this. */
export const MAX_CONVERSATIONS = 100;

export function newConversation(): Conversation {
  return { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, title: '', created: Date.now(), messages: [] };
}

/** The text the user actually typed, without the context notes added in front of it. */
export function visibleUserText(content: string | null | undefined): string {
  let s = content ?? '';
  for (;;) {
    const next = s.replace(/^\[(Since my last message|I have selected|Still being worked on)[\s\S]*?\]\n\n/, '');
    if (next === s) return s;
    s = next;
  }
}

/** Questions and answers worth showing (not tool calls or tool results). */
export function visibleMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => (m.role === 'user' && !m.content?.startsWith('[TOOL RESULT')) || (m.role === 'assistant' && !!m.content && !m.tool_calls));
}

export function titleFor(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user' && !m.content?.startsWith('[TOOL RESULT'));
  const text = visibleUserText(first?.content).replace(/\s+/g, ' ').trim();
  if (!text) return 'Untitled chat';
  return text.length > 70 ? `${text.slice(0, 67).trimEnd()}…` : text;
}

/** Keeps the last `max` messages, starting on a user message so the history stays valid. */
export function trimMessages(messages: ChatMessage[], max = MAX_MESSAGES): ChatMessage[] {
  let h = messages.slice(-max);
  while (h.length && h[0].role !== 'user') h = h.slice(1);
  return h;
}

async function readIndex(): Promise<ConversationMeta[]> {
  const s = await messenger.storage.local.get(INDEX_KEY);
  const list = s?.[INDEX_KEY];
  return Array.isArray(list) ? (list as ConversationMeta[]) : [];
}

async function writeIndex(list: ConversationMeta[]): Promise<void> {
  await messenger.storage.local.set({ [INDEX_KEY]: list });
}

/** Moves the single conversation older versions kept into the saved list. */
async function migrateLegacy(): Promise<void> {
  const s = await messenger.storage.local.get(LEGACY_KEY);
  const old = s?.[LEGACY_KEY] as ChatMessage[] | undefined;
  if (!old) return;
  await messenger.storage.local.remove(LEGACY_KEY);
  if (!Array.isArray(old) || !old.length) return;
  const conv = newConversation();
  conv.messages = old;
  await saveConversation(conv);
  await setCurrentId(conv.id);
}

/** Saved conversations, most recently used first. */
export async function listConversations(): Promise<ConversationMeta[]> {
  await migrateLegacy();
  return (await readIndex()).sort((a, b) => b.updated - a.updated);
}

export async function loadConversation(id: string): Promise<Conversation | null> {
  const meta = (await readIndex()).find((c) => c.id === id);
  if (!meta) return null;
  const s = await messenger.storage.local.get(msgKey(id));
  const messages = s?.[msgKey(id)];
  return { id, title: meta.title, created: meta.created, messages: Array.isArray(messages) ? messages : [] };
}

/** Saves a conversation (an empty one isn't saved) and drops the oldest beyond the limit. */
export async function saveConversation(conv: Conversation): Promise<void> {
  const messages = trimMessages(conv.messages);
  if (!messages.length) return;
  if (!conv.title) conv.title = titleFor(conv.messages);
  await messenger.storage.local.set({ [msgKey(conv.id)]: messages });
  const meta: ConversationMeta = { id: conv.id, title: conv.title, created: conv.created, updated: Date.now(), count: visibleMessages(messages).length };
  const list = (await readIndex()).filter((c) => c.id !== conv.id);
  list.unshift(meta);
  list.sort((a, b) => b.updated - a.updated);
  for (const dropped of list.splice(MAX_CONVERSATIONS)) await messenger.storage.local.remove(msgKey(dropped.id));
  await writeIndex(list);
}

export async function deleteConversation(id: string): Promise<void> {
  await messenger.storage.local.remove(msgKey(id));
  await writeIndex((await readIndex()).filter((c) => c.id !== id));
  if ((await getCurrentId()) === id) await setCurrentId(null);
}

export async function clearConversations(): Promise<void> {
  for (const c of await readIndex()) await messenger.storage.local.remove(msgKey(c.id));
  for (const k of [INDEX_KEY, CURRENT_KEY, LEGACY_KEY]) await messenger.storage.local.remove(k);
}

/** The conversation the chat page reopens to. */
export async function getCurrentId(): Promise<string | null> {
  const s = await messenger.storage.local.get(CURRENT_KEY);
  return (s?.[CURRENT_KEY] as string) ?? null;
}

export async function setCurrentId(id: string | null): Promise<void> {
  if (id) await messenger.storage.local.set({ [CURRENT_KEY]: id });
  else await messenger.storage.local.remove(CURRENT_KEY);
}
