import { describe, it, expect } from 'vitest';
import { readStream, isToolsUnsupported, LlmError } from '../src/core/llm';
import { parseDate, buildQuery } from '../src/core/mail';
import { cheapMatch, validateRule, type Rule } from '../src/core/rules';
import { isLocalUrl } from '../src/core/settings';
import { header } from './helpers';

function sse(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      // split awkwardly to exercise buffering
      const all = lines.map((l) => `data: ${l}\n\n`).join('');
      for (let i = 0; i < all.length; i += 7) c.enqueue(enc.encode(all.slice(i, i + 7)));
      c.close();
    },
  });
}

describe('readStream', () => {
  it('accumulates content deltas', async () => {
    const deltas: string[] = [];
    const r = await readStream(
      sse([JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }), JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }), '[DONE]']),
      (t) => deltas.push(t),
    );
    expect(r.content).toBe('Hello');
    expect(deltas).toEqual(['Hel', 'lo']);
  });
  it('assembles indexed tool-call fragments (OpenAI style)', async () => {
    const r = await readStream(
      sse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'search_', arguments: '{"fr' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'messages', arguments: 'om":"x"}' } }] } }] }),
      ]),
    );
    expect(r.toolCalls).toEqual([{ id: 'a', type: 'function', function: { name: 'search_messages', arguments: '{"from":"x"}' } }]);
  });
  it('handles whole tool calls without index (Ollama style)', async () => {
    const r = await readStream(
      sse([JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'c1', function: { name: 'list_folders', arguments: {} } }, { id: 'c2', function: { name: 'list_rules', arguments: '{}' } }] } }] })]),
    );
    expect(r.toolCalls.map((c) => c.function.name)).toEqual(['list_folders', 'list_rules']);
    expect(r.toolCalls[0].function.arguments).toBe('{}');
  });
});

describe('isToolsUnsupported', () => {
  it('detects common server messages', () => {
    expect(isToolsUnsupported(new LlmError('HTTP 400', 400, 'model does not support tools'))).toBe(true);
    expect(isToolsUnsupported(new LlmError('HTTP 404', 404, 'model not found'))).toBe(false);
  });
});

describe('dates and queries', () => {
  it('parses years, months and days in local time', () => {
    expect(parseDate('2021', false)!.getTime()).toBe(new Date(2021, 0, 1).getTime());
    expect(parseDate('2021', true)!.getTime()).toBe(new Date(2021, 11, 31, 23, 59, 59, 999).getTime());
    expect(parseDate('2021-02', true)!.getDate()).toBe(28);
    expect(parseDate('2021-12-31', true)!.getHours()).toBe(23);
    expect(parseDate('nonsense', false)).toBeUndefined();
  });
  it('buildQuery maps criteria to the TB query shape', () => {
    const q = buildQuery({ fromDate: '2021-01-01', toDate: '2021-12-31', author: 'bob', unread: true, folderId: 'f1' });
    expect(q.author).toBe('bob');
    expect(q.read).toBe(false);
    expect(q.folderId).toBe('f1');
    expect(q.fromDate).toBeInstanceOf(Date);
  });
});

describe('rules', () => {
  const rule = (match: Rule['match']): Rule => ({ id: 'r', name: 'r', enabled: true, createdAt: 0, appliedCount: 0, match, action: { kind: 'delete' } });
  it('matches exact sender addresses case-insensitively', () => {
    expect(cheapMatch(rule({ fromAddresses: ['junk@email.com'] }), header({ author: 'Junk <JUNK@email.com>' }))).toBe(true);
    expect(cheapMatch(rule({ fromAddresses: ['junk@email.com'] }), header({ author: 'x@email.com' }))).toBe(false);
  });
  it('needs extra data for list/AI conditions', () => {
    expect(cheapMatch(rule({ fromContains: 'shop', hasListUnsubscribe: true }), header({ author: 'deals@shop.com' }))).toBe('needs-extras');
  });
  it('validates rules', () => {
    expect(validateRule({}, { kind: 'delete' })).toMatch(/condition/);
    expect(validateRule({ fromContains: 'x' }, { kind: 'move' })).toMatch(/folder/);
    expect(validateRule({ fromContains: 'x' }, { kind: 'archive' })).toBeNull();
  });
});

describe('isLocalUrl', () => {
  it('accepts localhost/LAN and rejects the internet', () => {
    expect(isLocalUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLocalUrl('http://192.168.1.20:1234/v1')).toBe(true);
    expect(isLocalUrl('http://172.20.0.5/v1')).toBe(true);
    expect(isLocalUrl('https://api.example.com/v1')).toBe(false);
    expect(isLocalUrl('http://172.32.0.1/v1')).toBe(false);
  });
});
