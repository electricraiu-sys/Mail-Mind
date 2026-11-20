import { describe, it, expect, beforeEach } from 'vitest';
import { fakeMessenger } from './helpers';
import {
  newConversation, saveConversation, loadConversation, listConversations, deleteConversation,
  clearConversations, getCurrentId, setCurrentId, titleFor, visibleUserText, trimMessages, MAX_CONVERSATIONS,
} from '../src/core/conversations';
import type { ChatMessage } from '../src/core/llm';

const qa = (q: string, a = 'ok'): ChatMessage[] => [{ role: 'user', content: q }, { role: 'assistant', content: a }];

describe('saved conversations', () => {
  let fake: ReturnType<typeof fakeMessenger>;
  beforeEach(() => {
    fake = fakeMessenger([]);
  });

  it('saves, lists and reloads a conversation', async () => {
    const c = newConversation();
    c.messages = qa('[Since my last message: archived 3]\n\nFind junk in 2021');
    await saveConversation(c);
    const list = await listConversations();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: c.id, title: 'Find junk in 2021', count: 2 });
    expect((await loadConversation(c.id))?.messages).toEqual(c.messages);
  });

  it('does not save an empty conversation', async () => {
    await saveConversation(newConversation());
    expect(await listConversations()).toEqual([]);
  });

  it('lists the most recently updated first', async () => {
    const a = newConversation();
    a.messages = qa('first');
    await saveConversation(a);
    const b = newConversation();
    b.messages = qa('second');
    await saveConversation(b);
    await new Promise((r) => setTimeout(r, 5));
    a.messages.push(...qa('more'));
    await saveConversation(a);
    expect((await listConversations()).map((c) => c.title)).toEqual(['first', 'second']);
  });

  it('moves the single chat history from older versions into the list', async () => {
    fake.storage.local.set({ chatHistory: qa('old question') });
    const list = await listConversations();
    expect(list.map((c) => c.title)).toEqual(['old question']);
    expect(await getCurrentId()).toBe(list[0].id);
    expect(await fake.storage.local.get('chatHistory')).toEqual({});
  });

  it('deletes one conversation and clears the current one if it was that', async () => {
    const c = newConversation();
    c.messages = qa('x');
    await saveConversation(c);
    await setCurrentId(c.id);
    await deleteConversation(c.id);
    expect(await listConversations()).toEqual([]);
    expect(await loadConversation(c.id)).toBeNull();
    expect(await getCurrentId()).toBeNull();
  });

  it('drops the oldest beyond the limit, and clears everything', async () => {
    let first = '';
    for (let i = 0; i < MAX_CONVERSATIONS + 2; i++) {
      const c = newConversation();
      c.messages = qa(`q${i}`);
      if (!first) first = c.id;
      await saveConversation(c);
    }
    expect(await listConversations()).toHaveLength(MAX_CONVERSATIONS);
    expect(await fake.storage.local.get(`chat:${first}`)).toEqual({});
    await clearConversations();
    expect(await listConversations()).toEqual([]);
  });
});

describe('conversation helpers', () => {
  it('strips every context note in front of the question', () => {
    expect(visibleUserText('[Still being worked on in parallel: "a"]\n\n[I have selected these emails:\nx]\n\nhello')).toBe('hello');
  });

  it('titles from the first question, shortened', () => {
    expect(titleFor([{ role: 'user', content: 'a'.repeat(100) }])).toHaveLength(68);
    expect(titleFor([])).toBe('Untitled chat');
  });

  it('trims to start on a user message', () => {
    const msgs = [...qa('1'), ...qa('2'), ...qa('3')];
    expect(trimMessages(msgs, 3)).toEqual(qa('3'));
  });
});
