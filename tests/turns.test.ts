import { describe, it, expect } from 'vitest';
import { settleBlock, mergeBlock } from '../src/core/turns';
import type { ChatMessage } from '../src/core/llm';

const call = (id: string): ChatMessage => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'x', arguments: '{}' } }] });

describe('parallel chat turns', () => {
  it('keeps a finished request as-is', () => {
    const block: ChatMessage[] = [{ role: 'user', content: 'a' }, call('1'), { role: 'tool', tool_call_id: '1', content: 'r' }, { role: 'assistant', content: 'done' }];
    expect(settleBlock(block, '(Stopped.)')).toEqual(block);
  });

  it('drops a half-finished tool exchange and closes the turn after Stop', () => {
    const block: ChatMessage[] = [{ role: 'user', content: 'a' }, call('1'), { role: 'tool', tool_call_id: '1', content: 'r' }];
    expect(settleBlock(block, '(Stopped.)')).toEqual([{ role: 'user', content: 'a' }, { role: 'assistant', content: '(Stopped.)' }]);
  });

  it('treats a compatibility-mode tool result as unfinished', () => {
    const block: ChatMessage[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: '{"tool":"x"}' }, { role: 'user', content: '[TOOL RESULT: x]\nr' }];
    const out = settleBlock(block, '(Stopped.)');
    expect(out.at(-1)).toEqual({ role: 'assistant', content: '(Stopped.)' });
    expect(out.some((m) => m.content?.startsWith('[TOOL RESULT'))).toBe(false);
  });

  it('merges two overlapping requests as unbroken blocks, in finish order', () => {
    const history: ChatMessage[] = [];
    const slow: ChatMessage[] = [{ role: 'user', content: 'slow' }, call('s'), { role: 'tool', tool_call_id: 's', content: 'r' }, { role: 'assistant', content: 'slow done' }];
    const fast: ChatMessage[] = [{ role: 'user', content: 'fast' }, { role: 'assistant', content: 'fast done' }];
    mergeBlock(history, settleBlock(fast, ''));
    mergeBlock(history, settleBlock(slow, ''));
    expect(history.map((m) => m.content ?? `call:${m.tool_calls?.[0].id}`)).toEqual(['fast', 'fast done', 'slow', 'call:s', 'r', 'slow done']);
    // roles alternate user/assistant outside tool exchanges
    expect(history[1].role).toBe('assistant');
  });

  it('never leaves two user turns in a row', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'old, unanswered' }];
    mergeBlock(history, [{ role: 'user', content: 'new' }, { role: 'assistant', content: 'ok' }]);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});
