import type { ToolDef } from './llm';

/**
 * Fallback for models/servers that don't support native OpenAI tool calling:
 * tools are described in the system prompt and the model replies with a JSON object.
 */
export function toolsToPrompt(tools: ToolDef[]): string {
  const list = tools
    .map((t) => `- ${t.function.name}: ${t.function.description}\n  args schema: ${JSON.stringify(t.function.parameters)}`)
    .join('\n');
  return [
    'You can use tools. To call a tool, reply with ONLY a JSON object and nothing else, exactly like:',
    '{"tool": "tool_name", "args": { ... }}',
    'Call one tool per reply. After each call you will receive a message starting with [TOOL RESULT].',
    'When you have enough information, reply to the user normally in plain text (no JSON).',
    '',
    'Available tools:',
    list,
  ].join('\n');
}

/** Returns every balanced top-level {...} or [...] substring, respecting JSON strings. */
export function findJsonCandidates(text: string): string[] {
  const out: string[] = [];
  for (let start = 0; start < text.length; start++) {
    const ch = text[start];
    if (ch !== '{' && ch !== '[') continue;
    const stack: string[] = [];
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') {
        const open = stack.pop();
        if ((c === '}' && open !== '{') || (c === ']' && open !== '[')) break;
        if (stack.length === 0) {
          out.push(text.slice(start, i + 1));
          start = i;
          break;
        }
      }
    }
  }
  return out;
}

/** Extracts the first parseable JSON value from model output (handles ```json fences and chatter). */
export function extractJson<T = unknown>(text: string): T | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const sources = fence ? [fence[1], cleaned] : [cleaned];
  for (const src of sources) {
    try {
      return JSON.parse(src.trim()) as T;
    } catch {
      /* try candidates */
    }
    for (const cand of findJsonCandidates(src)) {
      try {
        return JSON.parse(cand) as T;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export function parseToolCall(text: string, knownTools?: string[]): ParsedToolCall | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  for (const cand of findJsonCandidates(cleaned)) {
    let obj: any;
    try {
      obj = JSON.parse(cand);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    const name = obj.tool ?? obj.name ?? obj.function ?? obj.tool_name;
    if (typeof name !== 'string') continue;
    if (knownTools && !knownTools.includes(name)) continue;
    let args = obj.args ?? obj.arguments ?? obj.parameters ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    return { name, args: args && typeof args === 'object' ? args : {} };
  }
  return null;
}
