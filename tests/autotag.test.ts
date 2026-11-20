import { describe, it, expect } from 'vitest';
import { autoTagNew, ensureTags, AUTO_TAG_MAX_PER_EVENT, TAG_KEYS } from '../src/core/autotag';
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
    const n = await autoTagNew(msgs, llm, [], NOW);
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
    await autoTagNew(msgs, llm, ['mailmind_receipt'], NOW);
    expect(calls()).toBe(AUTO_TAG_MAX_PER_EVENT);

    const only = [header({ id: 5000, subject: 'Question?', date: fresh })];
    const api = fakeMessenger(only);
    expect(await autoTagNew(only, llmBySubject().llm, ['mailmind_receipt'], NOW)).toBe(0);
    expect(api.store.get(5000)!.tags).toEqual([]);
  });
});
