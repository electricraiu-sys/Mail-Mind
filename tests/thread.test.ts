import { describe, it, expect } from 'vitest';
import { normalizeSubject, parseMessageIds } from '../src/core/text';
import { threadIdsFrom } from '../src/core/mail';
import { getThread, threadBlock } from '../src/core/thread';
import { fakeMessenger, header, SENT } from './helpers';

describe('thread helpers', () => {
  it('normalizes reply/forward prefixes and list tags', () => {
    expect(normalizeSubject('Re: Fwd: [club] RE:  Plan  for Friday')).toBe('plan for friday');
    expect(normalizeSubject('AW: WG: Angebot')).toBe('angebot');
    expect(normalizeSubject(undefined)).toBe('');
  });

  it('parses References and In-Reply-To', () => {
    expect(parseMessageIds(['<a@x> <b@x>', '<b@x>'])).toEqual(['a@x', 'b@x']);
    expect(threadIdsFrom({ references: ['<a@x> <b@x>'], 'in-reply-to': ['<c@x>'] })).toEqual(['a@x', 'b@x', 'c@x']);
  });
});

describe('getThread', () => {
  it('finds ancestors and later replies, and skips same-subject mail from other threads', async () => {
    const a = header({ id: 1, subject: 'Plan', headerMessageId: 'a@x', date: new Date('2026-11-01T10:00:00Z') });
    const b = header({ id: 2, subject: 'Re: Plan', headerMessageId: 'b@x', date: new Date('2026-11-02T10:00:00Z'), folder: SENT });
    const c = header({ id: 3, subject: 'Re: Plan', headerMessageId: 'c@x', date: new Date('2026-11-03T10:00:00Z') });
    const other = header({ id: 4, subject: 'Plan', headerMessageId: 'z@x', date: new Date('2026-11-04T10:00:00Z') });
    fakeMessenger([a, b, c, other], undefined, {
      rawHeaders: { 2: { references: ['<a@x>'] }, 3: { references: ['<a@x> <b@x>'] } },
      bodies: { 1: 'Shall we meet?', 2: 'Yes, Friday.\n> Shall we meet?', 3: 'Great' },
    });
    const thread = await getThread(2);
    expect(thread.map((h) => h.id)).toEqual([1, 2, 3]);
    const block = await threadBlock(thread, 3000);
    expect(block).toContain('Message 1 of 3');
    expect(block).toContain('Yes, Friday.');
    expect(block).not.toContain('> Shall we meet?');
    expect(block).toContain('untrusted');
  });

  it('returns just the message when it has no thread', async () => {
    fakeMessenger([header({ id: 9, subject: 'Hi' })]);
    expect((await getThread(9)).map((h) => h.id)).toEqual([9]);
    expect(await getThread(12345)).toEqual([]);
  });
});
