import type { ChatMessage } from './llm';

/**
 * Parallel chat requests: each one runs on its own copy of the conversation and is merged back
 * as one unbroken block when it ends. Two requests running at once never interleave their
 * tool calls, so every assistant tool_call stays right next to its tool results.
 */

/** A message the conversation can safely end on (not a dangling tool call or a tool result). */
function settled(m: ChatMessage): boolean {
  return (m.role === 'user' && !m.content?.startsWith('[TOOL RESULT')) || (m.role === 'assistant' && !m.tool_calls);
}

/**
 * Cleans up a request's messages before they are merged: drops a half-finished tool exchange
 * (after Stop or an error), and closes the block with an assistant message so the history keeps
 * alternating between user and assistant. Some local chat templates (e.g. Gemma) reject two user turns in a row.
 */
export function settleBlock(block: ChatMessage[], endNote: string): ChatMessage[] {
  const out = [...block];
  while (out.length && !settled(out[out.length - 1])) {
    const dropped = out.pop()!;
    // Compatibility mode: the tool request was plain assistant text right before its result, so drop it too.
    if (dropped.role === 'user' && out[out.length - 1]?.role === 'assistant' && !out[out.length - 1].tool_calls) out.pop();
  }
  if (!out.length) return out;
  if (out[out.length - 1].role === 'user') out.push({ role: 'assistant', content: endNote });
  return out;
}

/** Keeps the history alternating when a new block starts with a user message right after one that ended on a user message. */
export function mergeBlock(history: ChatMessage[], block: ChatMessage[]): void {
  if (!block.length) return;
  const last = history[history.length - 1];
  if (last && last.role === 'user' && block[0].role === 'user') history.push({ role: 'assistant', content: '(No reply.)' });
  history.push(...block);
}
