import { extractJson } from './jsonTools';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  /** Server's finish_reason; "length" means the reply hit max_tokens or the context limit. */
  finishReason?: string;
}

export interface ChatOptions {
  tools?: ToolDef[];
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  temperature?: number;
  jsonMode?: boolean;
  /** Upper bound on generated tokens. Unset = server default (often unlimited). */
  maxTokens?: number;
}

export interface JsonOptions extends ChatOptions {
  /** Number of items the reply should contain; sizes the output cap at TOKENS_PER_JSON_ITEM each. */
  items?: number;
}

/** Output budget per expected item in a JSON reply (one sender verdict, one summary, …). */
export const TOKENS_PER_JSON_ITEM = 200;
/** Fixed headroom on top of the per-item budget (brackets, a stray preamble). */
export const JSON_TOKEN_HEADROOM = 200;
/** Cap for JSON replies whose size isn't tied to an item count. */
export const DEFAULT_JSON_MAX_TOKENS = 1000;

export function jsonMaxTokens(opts: JsonOptions): number {
  if (opts.maxTokens) return opts.maxTokens;
  if (opts.items && opts.items > 0) return opts.items * TOKENS_PER_JSON_ITEM + JSON_TOKEN_HEADROOM;
  return DEFAULT_JSON_MAX_TOKENS;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  /**
   * "background" = low-priority work (the history junk scan) that should give way to everything else.
   * Every other request reports itself through `llmActivity.hook` so the background scan can pause.
   */
  priority?: 'normal' | 'background';
}

/** Set by core/aiActivity.ts; called when a normal-priority request starts and when it ends. */
export const llmActivity: { hook: ((phase: 'start' | 'end') => void) | null } = { hook: null };

export class LlmError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
    this.name = 'LlmError';
  }
}

/** True when the server rejected the request because the model can't use tools. */
export function isToolsUnsupported(err: unknown): boolean {
  if (!(err instanceof LlmError)) return false;
  const text = `${err.message} ${err.body ?? ''}`;
  return (err.status === 400 || err.status === 422 || err.status === 500 || err.status === 501) && /tool|function/i.test(text);
}

export function describeLlmError(err: unknown, baseUrl: string): string {
  if (err instanceof DOMException && err.name === 'AbortError') return 'Stopped.';
  if (err instanceof LlmError) {
    if (err.status === 403) {
      return `The AI server at ${baseUrl} refused the request (403). If you use Ollama, set the environment variable OLLAMA_ORIGINS=moz-extension://* and restart Ollama. For LM Studio, enable CORS in the server settings.`;
    }
    if (err.status === 404) {
      return `The AI server returned 404. Check the base URL (it should usually end in /v1) and that the model name exists. Details: ${err.body?.slice(0, 300) ?? ''}`;
    }
    if (err.status === undefined) {
      return `Couldn't reach the AI server at ${baseUrl}. Is Ollama / LM Studio running? (${err.message})`;
    }
    return `AI server error ${err.status}: ${(err.body || err.message).slice(0, 400)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export class LlmClient {
  constructor(public config: LlmConfig, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  private url(path: string): string {
    return this.config.baseUrl.replace(/\/+$/, '') + path;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) h.Authorization = `Bearer ${this.config.apiKey}`;
    return h;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) } });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw new LlmError(e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LlmError(`HTTP ${res.status}`, res.status, body);
    }
    return res;
  }

  async listModels(): Promise<string[]> {
    const res = await this.request('/models', { method: 'GET' });
    const json = await res.json();
    const data: any[] = json?.data ?? json?.models ?? [];
    return data.map((m) => m.id ?? m.name).filter(Boolean).sort();
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const report = this.config.priority !== 'background' ? llmActivity.hook : null;
    report?.('start');
    try {
      return await this.chatInner(messages, opts);
    } finally {
      report?.('end');
    }
  }

  private async chatInner(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: true,
      temperature: opts.temperature ?? this.config.temperature ?? 0.3,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = 'auto';
    }
    if (opts.jsonMode) body.response_format = { type: 'json_object' };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;

    const res = await this.request('/chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    const type = res.headers.get('content-type') ?? '';
    if (!res.body || type.includes('application/json')) {
      const json = await res.json();
      const choice = json?.choices?.[0] ?? {};
      const msg = choice.message ?? {};
      const content = msg.content ?? '';
      if (content) opts.onDelta?.(content);
      return { content, toolCalls: normalizeToolCalls(msg.tool_calls ?? []), finishReason: choice.finish_reason ?? undefined };
    }
    return readStream(res.body, opts.onDelta);
  }

  /** One-shot prompt without tools. */
  async complete(system: string, user: string, opts: ChatOptions = {}): Promise<string> {
    const r = await this.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      opts,
    );
    return r.content;
  }

  /**
   * One-shot prompt that must return JSON. Output is capped (see jsonMaxTokens) so a model that
   * rambles or loops can't fill the context window. A reply cut off by that cap is treated as a
   * failure rather than parsed. The single retry is a fresh request with a stricter reminder —
   * the failed reply is never sent back, so a runaway answer can't inflate the retry's prompt.
   * Returns null when both attempts fail.
   */
  async completeJson<T>(system: string, user: string, opts: JsonOptions = {}): Promise<T | null> {
    const { items: _items, ...chatOpts } = opts;
    const maxTokens = jsonMaxTokens(opts);
    const attempt = async (userText: string, temperature: number): Promise<T | null> => {
      const r = await this.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: userText },
        ],
        { ...chatOpts, temperature, maxTokens },
      );
      if (r.finishReason === 'length') return null;
      return extractJson<T>(r.content);
    };
    const first = await attempt(user, 0.1);
    if (first !== null) return first;
    return attempt(`${user}

Reply with ONLY the JSON — no explanation, no reasoning, nothing before or after it.`, 0);
  }

  async embed(model: string, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    const res = await this.request('/embeddings', {
      method: 'POST',
      body: JSON.stringify({ model, input: inputs }),
      signal,
    });
    const json = await res.json();
    const data: any[] = json?.data ?? [];
    return data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding as number[]);
  }
}

function normalizeToolCalls(raw: any[]): ToolCall[] {
  return raw
    .filter((c) => c?.function?.name)
    .map((c, i) => ({
      id: c.id || `call_${Date.now().toString(36)}_${i}`,
      type: 'function' as const,
      function: {
        name: c.function.name,
        arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}),
      },
    }));
}

/** Parses an OpenAI-style SSE stream, accumulating content and tool-call fragments. */
export async function readStream(body: ReadableStream<Uint8Array>, onDelta?: (t: string) => void): Promise<ChatResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason: string | undefined;
  const calls: { id?: string; name: string; args: string }[] = [];

  const handle = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const choice = json?.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta ?? choice?.message ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    const tcs: any[] = delta.tool_calls ?? [];
    tcs.forEach((tc) => {
      // Standard servers send `index`; some (older Ollama) send whole calls with only an id.
      const idx =
        typeof tc.index === 'number' ? tc.index : tc.id || calls.length === 0 ? calls.length : calls.length - 1;
      if (!calls[idx]) calls[idx] = { name: '', args: '' };
      const slot = calls[idx];
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      const a = tc.function?.arguments;
      if (typeof a === 'string') slot.args += a;
      else if (a && typeof a === 'object') slot.args = JSON.stringify(a);
    });
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer) handle(buffer);

  return {
    content,
    toolCalls: normalizeToolCalls(
      calls.filter(Boolean).map((c) => ({ id: c.id, function: { name: c.name, arguments: c.args || '{}' } })),
    ),
    finishReason,
  };
}
