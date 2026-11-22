import { describe, it, expect, beforeEach } from 'vitest';
import { runAgent, trimHistory } from '../src/core/agent';
import { LlmError, type ChatMessage, type ChatResult, type LlmClient } from '../src/core/llm';
import { createTools, type ToolUi, type Proposal } from '../src/core/tools';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { fakeMessenger, header } from './helpers';
import { CARD_CLAIM_GUARD } from '../src/core/prompts';

function scriptedLlm(script: (ChatResult | Error)[]) {
  const seen: { messages: ChatMessage[]; tools: boolean }[] = [];
  const llm = {
    chat: async (messages: ChatMessage[], opts: any = {}) => {
      seen.push({ messages: structuredClone(messages), tools: !!opts.tools });
      const next = script.shift();
      if (!next) throw new Error('script exhausted');
      if (next instanceof Error) throw next;
      if (next.content) opts.onDelta?.(next.content);
      return next;
    },
  } as unknown as LlmClient;
  return { llm, seen };
}

function recordingUi() {
  const proposals: Proposal[] = [];
  const ui: ToolUi = {
    progress: () => {},
    showSenderReview: () => {},
    showProposal: (p) => proposals.push(p),
    showFiling: () => {},
    showRuleProposal: () => {},
    showFolderProposal: () => {},
    showDraft: () => {},
    showTopicResults: () => {},
    showAttachments: () => {},
    showEvents: () => {},
    showFollowups: () => {},
    showSubscriptions: () => {},
    showDigest: () => {},
  };
  return { ui, proposals };
}

const call = (name: string, args: object) => ({ id: `c_${name}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

describe('agent loop', () => {
  let api: ReturnType<typeof fakeMessenger>;
  beforeEach(() => {
    api = fakeMessenger([header({ id: 1, author: 'junk@email.com', subject: 'WIN' }), header({ id: 2, author: 'junk@email.com', subject: 'FREE' })]);
  });

  it('mutating requests only create proposals — nothing touches mail without approval', async () => {
    const { llm } = scriptedLlm([
      { content: '', toolCalls: [call('propose_actions', { action: 'delete', messageIds: [1, 2], reason: 'spam' })] },
      { content: 'I prepared a proposal to move 2 emails to Trash for your review.', toolCalls: [] },
    ]);
    const { ui, proposals } = recordingUi();
    const history: ChatMessage[] = [{ role: 'user', content: 'delete the junk' }];
    const r = await runAgent({ llm, system: 'sys', history, tools: createTools({ llm, settings: DEFAULT_SETTINGS, ui }), mode: 'native' });

    expect(r.finalText).toContain('proposal');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe('delete');
    expect(proposals[0].messages.map((m) => m.id)).toEqual([1, 2]);
    expect(api.calls.filter((c) => ['move', 'delete', 'archive', 'update'].includes(c.method))).toEqual([]);
    // tool result is in history, linked to the call
    const toolMsg = history.find((m) => m.role === 'tool')!;
    expect(toolMsg.tool_call_id).toBe('c_propose_actions');
    expect(toolMsg.content).toMatch(/NOT been executed/);
  });

  it('the v0.2 tools only show cards and proposals — they never change mail', async () => {
    const tagLlm = { completeJson: async () => ({ tag: 'mailmind_receipt' }) };
    const { llm } = scriptedLlm([
      { content: '', toolCalls: [call('find_followups', {})] },
      { content: '', toolCalls: [call('find_subscriptions', { fromDate: '2021-01-01' })] },
      { content: '', toolCalls: [call('suggest_tags', { messageIds: [1, 2] })] },
      { content: '', toolCalls: [call('summarize_thread', { messageId: 1 })] },
      { content: 'Done.', toolCalls: [] },
    ]);
    Object.assign(llm, tagLlm);
    const shown: string[] = [];
    const { ui, proposals } = recordingUi();
    ui.showFollowups = () => shown.push('followups');
    ui.showSubscriptions = () => shown.push('subscriptions');
    const r = await runAgent({ llm, system: 's', history: [{ role: 'user', content: 'go' }], tools: createTools({ llm, settings: DEFAULT_SETTINGS, ui }), mode: 'native' });
    expect(r.finalText).toBe('Done.');
    expect(shown).toEqual(['followups', 'subscriptions']);
    expect(proposals.map((p) => [p.kind, p.tag, p.messages.length])).toEqual([['tag', 'mailmind_receipt', 2]]);
    expect(api.calls.filter((c) => ['move', 'delete', 'archive', 'update', 'tags.create'].includes(c.method))).toEqual([]);
  });

  it('switches to JSON compatibility mode when the server rejects tools', async () => {
    const { llm, seen } = scriptedLlm([
      new LlmError('HTTP 400', 400, '{"error":"registry.ollama.ai/library/gemma3 does not support tools"}'),
      { content: '{"tool":"search_messages","args":{"from":"junk@email.com"}}', toolCalls: [] },
      { content: 'You have 2 emails from junk@email.com.', toolCalls: [] },
    ]);
    const { ui } = recordingUi();
    const switched: string[] = [];
    const history: ChatMessage[] = [{ role: 'user', content: 'how many from junk?' }];
    const r = await runAgent({
      llm,
      system: 'sys',
      history,
      tools: createTools({ llm, settings: DEFAULT_SETTINGS, ui }),
      mode: 'native',
      events: { onModeSwitch: (m) => switched.push(m) },
    });
    expect(r.mode).toBe('json');
    expect(switched).toEqual(['json']);
    expect(r.finalText).toBe('You have 2 emails from junk@email.com.');
    expect(seen[1].tools).toBe(false);
    expect(seen[1].messages[0].content).toContain('{"tool": "tool_name"');
    const toolResult = history.find((m) => m.role === 'user' && m.content?.startsWith('[TOOL RESULT'));
    expect(toolResult?.content).toContain('[1]');
    expect(toolResult?.content).toContain('[2]');
  });

  it('reports bad tool arguments back to the model instead of crashing', async () => {
    const { llm } = scriptedLlm([
      { content: '', toolCalls: [{ id: 'x', type: 'function', function: { name: 'get_message', arguments: '{oops' } }] },
      { content: 'Sorry, let me retry later.', toolCalls: [] },
    ]);
    const { ui } = recordingUi();
    const history: ChatMessage[] = [{ role: 'user', content: 'read it' }];
    await runAgent({ llm, system: 's', history, tools: createTools({ llm, settings: DEFAULT_SETTINGS, ui }), mode: 'native' });
    expect(history.find((m) => m.role === 'tool')?.content).toMatch(/not valid JSON/);
  });

  it('a reply that claims a proposal without calling propose_actions is retracted and the model is sent back once', async () => {
    const { llm, seen } = scriptedLlm([
      { content: '', toolCalls: [call('search_messages', { from: 'junk@email.com' })] },
      { content: "I've found 2 emails. I have prepared a proposal to move them to the Trash. Would you like to proceed?", toolCalls: [] },
      { content: '', toolCalls: [call('propose_actions', { action: 'delete', messageIds: [1, 2] })] },
      { content: 'The proposal is in Actions.', toolCalls: [] },
    ]);
    const { ui, proposals } = recordingUi();
    let retracted = 0;
    const history: ChatMessage[] = [{ role: 'user', content: 'find junk@email.com and delete them' }];
    const r = await runAgent({
      llm, system: 's', history, tools: createTools({ llm, settings: DEFAULT_SETTINGS, ui }), mode: 'native',
      claimGuard: CARD_CLAIM_GUARD, events: { onRetract: () => retracted++ },
    });
    expect(retracted).toBe(1);
    expect(proposals).toHaveLength(1);
    expect(seen[2].messages.at(-1)?.content).toMatch(/did not call propose_actions/);
    expect(r.finalText).toBe('The proposal is in Actions.');
    // The false reply and the nudge are not saved in the conversation.
    expect(history.some((m) => /Would you like to proceed/.test(m.content ?? ''))).toBe(false);
  });

  it('an honest proposal reply passes the guard; a repeated false claim gets a visible correction', async () => {
    const honest = scriptedLlm([
      { content: '', toolCalls: [call('propose_actions', { action: 'delete', messageIds: [1] })] },
      { content: 'I prepared a proposal — click Approve on the card.', toolCalls: [] },
    ]);
    const r1 = await runAgent({ llm: honest.llm, system: 's', history: [{ role: 'user', content: 'x' }], tools: createTools({ llm: honest.llm, settings: DEFAULT_SETTINGS, ui: recordingUi().ui }), mode: 'native', claimGuard: CARD_CLAIM_GUARD });
    expect(r1.finalText).toBe('I prepared a proposal — click Approve on the card.');

    const stubborn = scriptedLlm([
      { content: 'I prepared a proposal for you.', toolCalls: [] },
      { content: 'I prepared a proposal for you.', toolCalls: [] },
    ]);
    const r2 = await runAgent({ llm: stubborn.llm, system: 's', history: [{ role: 'user', content: 'x' }], tools: createTools({ llm: stubborn.llm, settings: DEFAULT_SETTINGS, ui: recordingUi().ui }), mode: 'native', claimGuard: CARD_CLAIM_GUARD });
    expect(r2.finalText).toMatch(/No proposal card was actually created/);
  });

  it('stops after maxSteps', async () => {
    const loop = Array.from({ length: 5 }, () => ({ content: '', toolCalls: [call('list_rules', {})] }));
    const { llm } = scriptedLlm(loop);
    const { ui } = recordingUi();
    const r = await runAgent({ llm, system: 's', history: [{ role: 'user', content: 'x' }], tools: createTools({ llm, settings: DEFAULT_SETTINGS, ui }), mode: 'native', maxSteps: 3 });
    expect(r.finalText).toMatch(/stopped after 3 steps/i);
  });
});

describe('trimHistory', () => {
  it('drops old turns and never starts with a tool result', () => {
    const h: ChatMessage[] = [
      { role: 'user', content: 'a'.repeat(100) },
      { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: '1', content: 'b'.repeat(100) },
      { role: 'user', content: 'latest' },
    ];
    const t = trimHistory(h, 50);
    expect(t[0].role).toBe('user');
    expect(t[t.length - 1].content).toBe('latest');
  });
});
