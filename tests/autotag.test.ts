import { describe, it, expect } from 'vitest';
import { autoTagNew, ensureTags, makeCustomTag, suggestNewTags, activeTags, allTags, AUTO_TAG_MAX_PER_EVENT, TAG_KEYS, TAGS } from '../src/core/autotag';
const RECEIPT_ONLY = TAGS.filter((t) => t.key === 'mailmind_receipt');
import { getUndoLog, undo } from '../src/core/actions';
import type { LlmClient } from '../src/core/llm';
import { fakeMessenger, header } from './helpers';

const NOW = new Date('2026-11-20T12:00:00Z').getTime();

function llmBySubject() {
  let calls = 0;
  const llm = {
    completeJson: async (_s: string, user: string) => {
      calls++;
      if (/receipt/i.test(user)) return { tag: 'mailmind_receipt' };
      if (/\?/.test(user)) return { tag: 'mailmind_needs_reply' };
      if (/hack/i.test(user)) return { tag: 'not_a_real_tag' };
      return { tag: 'none' };
    },
  } as unknown as LlmClient;
  return { llm, calls: () => calls };
}

describe('auto-tagging', () => {
  it('creates only the missing MailMind tags', async () => {
    const api = fakeMessenger([], undefined, { tags: [{ key: 'mailmind_fyi', tag: 'FYI', color: '#000' }] });
    await ensureTags();
    const created = api.calls.filter((c) => c.method === 'tags.create').map((c) => c.args[0]);
    expect(created).toEqual(TAG_KEYS.filter((k) => k !== 'mailmind_fyi'));
  });

  it('tags fresh mail, one undoable batch per tag, ignoring old mail and invalid answers', async () => {
    const fresh = new Date(NOW - 3_600_000);
    const msgs = [
      header({ id: 1, subject: 'Your receipt', date: fresh }),
      header({ id: 2, subject: 'Another receipt', date: fresh }),
      header({ id: 3, subject: 'Can you call me?', date: fresh }),
      header({ id: 4, subject: 'Newsletter', date: fresh }),
      header({ id: 5, subject: 'hack the planet', date: fresh }),
      header({ id: 6, subject: 'Old receipt', date: new Date(NOW - 10 * 86_400_000) }),
    ];
    const api = fakeMessenger(msgs);
    const { llm, calls } = llmBySubject();
    const n = await autoTagNew(msgs, llm, TAGS, NOW);
    expect(n).toBe(3);
    expect(calls()).toBe(5); // the old message was never sent to the AI
    expect(api.store.get(1)!.tags).toEqual(['mailmind_receipt']);
    expect(api.store.get(3)!.tags).toEqual(['mailmind_needs_reply']);
    expect(api.store.get(5)!.tags).toEqual([]);
    expect(api.store.get(6)!.tags).toEqual([]);
    const log = await getUndoLog();
    expect(log).toHaveLength(2);
    expect(log.every((e) => e.kind === 'tag' && e.source?.startsWith('Auto-tag'))).toBe(true);

    const receiptEntry = log.find((e) => e.source === 'Auto-tag: Receipt')!;
    await undo(receiptEntry.id);
    expect(api.store.get(1)!.tags).toEqual([]);
  });

  it('respects the per-event cap and the allowed tag list', async () => {
    const fresh = new Date(NOW - 60_000);
    const msgs = Array.from({ length: AUTO_TAG_MAX_PER_EVENT + 20 }, (_, i) => header({ id: 1000 + i, subject: `receipt ${i}`, date: fresh }));
    fakeMessenger(msgs);
    const { llm, calls } = llmBySubject();
    await autoTagNew(msgs, llm, RECEIPT_ONLY, NOW);
    expect(calls()).toBe(AUTO_TAG_MAX_PER_EVENT);

    const only = [header({ id: 5000, subject: 'Question?', date: fresh })];
    const api = fakeMessenger(only);
    expect(await autoTagNew(only, llmBySubject().llm, RECEIPT_ONLY, NOW)).toBe(0);
    expect(api.store.get(5000)!.tags).toEqual([]);
  });
});

describe('custom tags', () => {
  const tb = [{ key: '$label1', tag: 'Important', color: '#FF0000' }];

  it('makes a lower-case key, refuses duplicates and empty descriptions, and reuses Thunderbird tags by name', () => {
    const t = makeCustomTag({ label: "Kids' school", hint: 'school mail' }, TAGS, tb);
    expect(t.key).toBe('mailmind_u_kids_school');
    expect(t.label).toBe("Kids' school");
    expect(() => makeCustomTag({ label: 'receipt', hint: 'x' }, TAGS)).toThrow(/already/);
    expect(() => makeCustomTag({ label: 'Bills', hint: '  ' }, TAGS)).toThrow(/Describe/);
    const reused = makeCustomTag({ label: 'important', hint: 'urgent mail' }, TAGS, tb);
    expect(reused).toMatchObject({ key: '$label1', label: 'Important', color: '#FF0000' });
    expect(() => makeCustomTag({ label: 'Important', hint: 'x' }, [...TAGS, reused], tb)).toThrow(/already/);
  });

  it('auto-tags with a custom tag picked by its label, and skips mail that already has any MailMind tag', async () => {
    const kids = makeCustomTag({ label: "Kids' school", hint: 'mail from the school' }, TAGS);
    const s = { customTags: [kids], autoTagKeys: [] as string[] };
    expect(activeTags(s).map((t) => t.key)).toContain(kids.key);
    expect(activeTags({ ...s, autoTagKeys: [kids.key] })).toEqual([kids]);

    const fresh = new Date(NOW - 60_000);
    const msgs = [
      header({ id: 1, subject: 'School trip on Friday', date: fresh }),
      header({ id: 2, subject: 'School play', date: fresh, tags: [kids.key] }),
    ];
    const api = fakeMessenger(msgs);
    const llm = { completeJson: async (system: string) => ({ tag: system.includes("Kids' school") ? "kids' SCHOOL" : 'none' }) } as unknown as LlmClient;
    expect(await autoTagNew(msgs, llm, activeTags(s), NOW, allTags(s).map((t) => t.key))).toBe(1);
    expect(api.store.get(1)!.tags).toEqual([kids.key]);
    expect(api.calls.some((c) => c.method === 'tags.create' && c.args[0] === kids.key)).toBe(true);
    expect((await getUndoLog())[0].source).toBe("Auto-tag: Kids' school");
  });
});

describe('AI tag suggestions', () => {
  it('cleans the reply, drops ideas that match existing tags, and caps at 5', async () => {
    const msgs = Array.from({ length: 10 }, (_, i) => header({ id: i + 1, subject: `Subject ${i}` }));
    const llm = {
      completeJson: async () => [
        { label: 'Kids school', hint: 'From the school', examples: ['Subject 1', 'Subject 2'] },
        { label: 'RECEIPT', hint: 'dup of a built-in' },
        { label: 'No hint' },
        { label: '<b>Club</b>', hint: 'Club events' },
        ...Array.from({ length: 6 }, (_, i) => ({ label: `Idea ${i}`, hint: 'h' })),
      ],
    } as unknown as LlmClient;
    const out = await suggestNewTags(llm, msgs, TAGS);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ label: 'Kids school', hint: 'From the school', examples: ['Subject 1', 'Subject 2'] });
    expect(out.map((s) => s.label)).not.toContain('RECEIPT');
    expect(out[1].label).toBe('bClubb'); // <, > and / are not allowed in tag names
  });

  it('does not ask the AI when there is too little mail', async () => {
    let called = false;
    const llm = { completeJson: async () => ((called = true), []) } as unknown as LlmClient;
    expect(await suggestNewTags(llm, [header({ id: 1 })], TAGS)).toEqual([]);
    expect(called).toBe(false);
  });
});
