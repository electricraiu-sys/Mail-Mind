import { describe, expect, it } from 'vitest';
import { LlmClient, jsonMaxTokens, readStream } from '../src/core/llm';
import { classifyWithAi } from '../src/core/triage';

type Reply = { content: string; finish?: string };

/** Fake fetch returning queued non-streaming replies and recording each request body. */
function fakeServer(replies: Reply[]) {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const r = replies.shift() ?? { content: '' };
    return new Response(JSON.stringify({ choices: [{ message: { content: r.content }, finish_reason: r.finish ?? 'stop' }] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { client: new LlmClient({ baseUrl: 'http://x/v1', model: 'm' }, fetchImpl), bodies };
}

describe('jsonMaxTokens', () => {
  it('scales with item count, falls back to a fixed cap, honours explicit maxTokens', () => {
    expect(jsonMaxTokens({ items: 10 })).toBe(2200);
    expect(jsonMaxTokens({})).toBe(1000);
    expect(jsonMaxTokens({ items: 10, maxTokens: 50 })).toBe(50);
  });
});

describe('completeJson', () => {
  it('sends max_tokens and does not forward the items option', async () => {
    const { client, bodies } = fakeServer([{ content: '[{"i":0}]' }]);
    expect(await client.completeJson('sys', 'u', { items: 3 })).toEqual([{ i: 0 }]);
    expect(bodies[0].max_tokens).toBe(800);
    expect(bodies[0].items).toBeUndefined();
  });

  it('treats a length-truncated reply as failed even if it happens to parse', async () => {
    const { client, bodies } = fakeServer([{ content: '[{"i":0}]', finish: 'length' }, { content: '[{"i":1}]' }]);
    expect(await client.completeJson('sys', 'u')).toEqual([{ i: 1 }]);
    expect(bodies).toHaveLength(2);
  });

  it('retries with a fresh two-message prompt, never echoing the failed reply', async () => {
    const junk = 'thinking '.repeat(500);
    const { client, bodies } = fakeServer([{ content: junk }, { content: '{"ok":true}' }]);
    expect(await client.completeJson('sys', 'u')).toEqual({ ok: true });
    expect(bodies[1].messages).toHaveLength(2);
    expect(JSON.stringify(bodies[1].messages)).not.toContain('thinking');
  });

  it('returns null when both attempts fail', async () => {
    const { client } = fakeServer([{ content: 'nope', finish: 'length' }, { content: 'nope' }]);
    expect(await client.completeJson('sys', 'u')).toBeNull();
  });
});

describe('readStream', () => {
  it('captures finish_reason', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n';
    const r = await readStream(new Response(sse).body!);
    expect(r).toMatchObject({ content: 'hi', finishReason: 'length' });
  });
});

describe('classifyWithAi batch splitting', () => {
  const group = (address: string) =>
    ({ address, name: '', count: 5, unread: 5, youWroteTo: false, subjects: ['s'], messages: [], score: 0.5, verdict: 'unknown', reason: '' }) as any;

  it('splits a failed batch in half and classifies each half', async () => {
    const groups = ['a', 'b', 'c', 'd'].map(group);
    const sizes: number[] = [];
    const llm = {
      completeJson: async (_s: string, user: string) => {
        const payload = JSON.parse(user);
        sizes.push(payload.length);
        if (payload.length === 4) return null; // full batch "cut off"
        return payload.map((p: any) => ({ i: p.i, verdict: 'promo', confidence: 0.9, reason: 'r' }));
      },
    } as any;
    await classifyWithAi(llm, groups, { batchSize: 4 });
    expect(sizes).toEqual([4, 2, 2]);
    expect(groups.every((g) => g.verdict === 'promo')).toBe(true);
  });
});
