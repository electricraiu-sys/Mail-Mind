import { describe, it, expect } from 'vitest';
import { parseToolCall, extractJson, findJsonCandidates } from '../src/core/jsonTools';

describe('parseToolCall', () => {
  it('parses a bare JSON tool call', () => {
    expect(parseToolCall('{"tool":"search_messages","args":{"from":"bob"}}')).toEqual({ name: 'search_messages', args: { from: 'bob' } });
  });
  it('parses a fenced call with chatter and braces inside strings', () => {
    const text = 'Sure, let me look.\n```json\n{"tool": "get_message", "args": {"messageId": 12, "note": "a } b"}}\n```';
    expect(parseToolCall(text)).toEqual({ name: 'get_message', args: { messageId: 12, note: 'a } b' } });
  });
  it('accepts name/arguments variants and string arguments', () => {
    expect(parseToolCall('{"name":"list_folders","arguments":"{}"}')).toEqual({ name: 'list_folders', args: {} });
  });
  it('ignores unknown tools when a list is given and plain answers', () => {
    expect(parseToolCall('{"tool":"rm_rf","args":{}}', ['search_messages'])).toBeNull();
    expect(parseToolCall('You have 3 unread emails.')).toBeNull();
  });
  it('ignores JSON inside thinking blocks', () => {
    expect(parseToolCall('<think>{"tool":"x","args":{}}</think>Done.')).toBeNull();
  });
});

describe('extractJson', () => {
  it('finds arrays in noisy output', () => {
    expect(extractJson('Here you go: [{"i":0,"verdict":"promo"}] hope that helps')).toEqual([{ i: 0, verdict: 'promo' }]);
  });
  it('returns null when there is no JSON', () => {
    expect(extractJson('no json here')).toBeNull();
  });
  it('findJsonCandidates handles nesting', () => {
    expect(findJsonCandidates('a {"x":{"y":[1,2]}} b [3]')).toEqual(['{"x":{"y":[1,2]}}', '[3]']);
  });
});
