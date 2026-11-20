import type { ChatMessage, LlmClient, ToolDef } from './llm';
import { isToolsUnsupported } from './llm';
import { toolsToPrompt, parseToolCall } from './jsonTools';
import { truncate } from './text';

export interface ToolHandler {
  def: ToolDef;
  run(args: Record<string, any>, signal?: AbortSignal): Promise<string>;
}

export interface AgentEvents {
  onAssistantStart?(): void;
  onDelta?(text: string): void;
  onAssistantEnd?(fullText: string, hadToolCall: boolean): void;
  onToolStart?(name: string, args: Record<string, any>): void;
  onToolEnd?(name: string, result: string, isError: boolean): void;
  onModeSwitch?(mode: 'native' | 'json'): void;
}

export interface AgentOptions {
  llm: LlmClient;
  system: string;
  /** Conversation so far (user/assistant/tool messages, no system). Mutated in place. */
  history: ChatMessage[];
  tools: ToolHandler[];
  mode: 'native' | 'json';
  maxSteps?: number;
  maxToolResultChars?: number;
  historyCharBudget?: number;
  events?: AgentEvents;
  signal?: AbortSignal;
}

export interface AgentResult {
  mode: 'native' | 'json';
  steps: number;
  finalText: string;
}

function msgChars(m: ChatMessage): number {
  return (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
}

/** Drops the oldest turns so the prompt fits a small local context window. Never starts on a tool result. */
export function trimHistory(history: ChatMessage[], budget: number): ChatMessage[] {
  const out = [...history];
  let total = out.reduce((n, m) => n + msgChars(m), 0);
  while (out.length > 1 && total > budget) {
    total -= msgChars(out.shift()!);
    while (out.length > 1 && out[0].role !== 'user') total -= msgChars(out.shift()!);
  }
  return out;
}

function parseArgs(raw: string): Record<string, any> | null {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return null;
  }
}

export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const maxSteps = o.maxSteps ?? 8;
  const maxResult = o.maxToolResultChars ?? 8000;
  const budget = o.historyCharBudget ?? 24000;
  const ev = o.events ?? {};
  const byName = new Map(o.tools.map((t) => [t.def.function.name, t]));
  const defs = o.tools.map((t) => t.def);
  let mode = o.mode;
  let finalText = '';

  const runTool = async (name: string, args: Record<string, any> | null): Promise<string> => {
    const tool = byName.get(name);
    ev.onToolStart?.(name, args ?? {});
    let result: string;
    let isError = false;
    if (!tool) {
      result = `ERROR: unknown tool "${name}". Available: ${[...byName.keys()].join(', ')}`;
      isError = true;
    } else if (args === null) {
      result = 'ERROR: tool arguments were not valid JSON. Try again with valid JSON arguments.';
      isError = true;
    } else {
      try {
        result = await tool.run(args, o.signal);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        result = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
        isError = true;
      }
    }
    result = truncate(result, maxResult);
    ev.onToolEnd?.(name, result, isError);
    return result;
  };

  for (let step = 1; step <= maxSteps; step++) {
    if (o.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const trimmed = trimHistory(o.history, budget);
    const system = mode === 'json' ? `${o.system}\n\n${toolsToPrompt(defs)}` : o.system;
    const messages: ChatMessage[] = [{ role: 'system', content: system }, ...trimmed];

    ev.onAssistantStart?.();
    let content = '';
    let toolCalls: { id: string; name: string; args: string }[] = [];
    try {
      const r = await o.llm.chat(messages, {
        tools: mode === 'native' ? defs : undefined,
        signal: o.signal,
        onDelta: mode === 'native' ? ev.onDelta : undefined,
      });
      content = r.content;
      toolCalls = r.toolCalls.map((c) => ({ id: c.id, name: c.function.name, args: c.function.arguments }));
    } catch (e) {
      if (mode === 'native' && isToolsUnsupported(e)) {
        mode = 'json';
        ev.onModeSwitch?.('json');
        step--;
        continue;
      }
      throw e;
    }

    if (mode === 'native') {
      if (toolCalls.length) {
        o.history.push({
          role: 'assistant',
          content: content || null,
          tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
        });
        ev.onAssistantEnd?.(content, true);
        for (const c of toolCalls) {
          const result = await runTool(c.name, parseArgs(c.args));
          o.history.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: result });
        }
        continue;
      }
      o.history.push({ role: 'assistant', content });
      ev.onAssistantEnd?.(content, false);
      finalText = content;
      return { mode, steps: step, finalText };
    }

    // JSON fallback mode: the model writes {"tool":..., "args":...} in plain text.
    const call = parseToolCall(content, [...byName.keys()]);
    if (call) {
      o.history.push({ role: 'assistant', content });
      ev.onAssistantEnd?.('', true);
      const result = await runTool(call.name, call.args);
      o.history.push({ role: 'user', content: `[TOOL RESULT: ${call.name}]\n${result}\n[END TOOL RESULT]` });
      continue;
    }
    ev.onDelta?.(content);
    o.history.push({ role: 'assistant', content });
    ev.onAssistantEnd?.(content, false);
    finalText = content;
    return { mode, steps: step, finalText };
  }

  finalText = `I stopped after ${maxSteps} steps to avoid looping. Tell me how you'd like to continue.`;
  o.history.push({ role: 'assistant', content: finalText });
  ev.onAssistantStart?.();
  ev.onDelta?.(finalText);
  ev.onAssistantEnd?.(finalText, false);
  return { mode, steps: maxSteps, finalText };
}
