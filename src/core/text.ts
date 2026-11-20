const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith('#x')) return safeChar(parseInt(lower.slice(2), 16), m);
    if (lower.startsWith('#')) return safeChar(parseInt(lower.slice(1), 10), m);
    return ENTITIES[lower] ?? m;
  });
}

function safeChar(n: number, fallback: string): string {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : fallback;
  } catch {
    return fallback;
  }
}

/** Dependency-free HTML → readable text (works in background, pages and tests). */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n• ');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|section|article|header|footer)>/gi, '\n');
  s = s.replace(/<(p|div|tr|h[1-6]|table)[^>]*>/gi, '\n');
  s = s.replace(/<td[^>]*>/gi, ' ');
  s = s.replace(/<a [^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
    const t = text.replace(/<[^>]+>/g, '').trim();
    return t && !href.startsWith('mailto:') && t !== href ? `${t}` : t || href;
  });
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return normalizeWhitespace(s);
}

export function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Removes quoted reply history so the model sees only the new content. */
export function stripQuotedText(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*>/.test(line)) continue;
    if (/^On .{5,200}wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^From: .+/.test(line) && i + 1 < lines.length && /^(Sent|Date): /.test(lines[i + 1])) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 20)).trimEnd() + '\n…[truncated]';
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/** Hides chain-of-thought blocks some local models emit. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '');
}

const HTML_MARKERS = [
  '<div class="moz-cite-prefix"',
  '<blockquote type="cite"',
  '<div class="moz-forward-container"',
  '<div class="moz-signature"',
  '<pre class="moz-signature"',
];

export interface SplitBody {
  /** The part the user wrote (safe to rewrite). */
  own: string;
  /** Signature / quoted history to keep unchanged after the rewrite. */
  rest: string;
}

/** Splits a compose body into the user's own text and the quoted/signature tail. */
export function splitComposeBody(body: string, isHtml: boolean): SplitBody {
  if (isHtml) {
    const lower = body.toLowerCase();
    let idx = -1;
    for (const marker of HTML_MARKERS) {
      const i = lower.indexOf(marker);
      if (i >= 0 && (idx < 0 || i < idx)) idx = i;
    }
    // Content may be wrapped in <body>…</body>; keep the wrapper in `rest` handling simple.
    if (idx < 0) {
      const closing = lower.lastIndexOf('</body>');
      return closing >= 0 ? { own: body.slice(0, closing), rest: body.slice(closing) } : { own: body, rest: '' };
    }
    return { own: body.slice(0, idx), rest: body.slice(idx) };
  }
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (
      lines[i] === '-- ' ||
      /^On .{5,200}wrote:$/.test(t) ||
      /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(t) ||
      /^>/.test(t)
    ) {
      return { own: lines.slice(0, i).join('\n'), rest: lines.slice(i).join('\n') };
    }
  }
  return { own: body, rest: '' };
}

/** Pulls the HTML inside <body> (or the whole string). */
export function bodyInner(html: string): { before: string; inner: string; after: string } {
  const open = html.match(/<body[^>]*>/i);
  const closeIdx = html.toLowerCase().lastIndexOf('</body>');
  if (!open || open.index === undefined || closeIdx < 0) return { before: '', inner: html, after: '' };
  const start = open.index + open[0].length;
  return { before: html.slice(0, start), inner: html.slice(start, closeIdx), after: html.slice(closeIdx) };
}

/** Very small, safe markdown renderer for chat output (escapes first, then formats). */
export function renderMarkdown(src: string): string {
  const codeBlocks: string[] = [];
  let s = src.replace(/```[a-z0-9_-]*\n?([\s\S]*?)(```|$)/gi, (_m, code: string) => {
    codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  const inline = (t: string) =>
    t
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  const blocks = s.split(/\n{2,}/);
  const html = blocks.map((block) => {
    const trimmed = block.trim();
    const code = trimmed.match(/^\u0000CODE(\d+)\u0000$/);
    if (code) return codeBlocks[Number(code[1])];
    const lines = trimmed.split('\n');
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    }
    const h = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (h && lines.length === 1) return `<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  });
  return html.join('').replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => codeBlocks[Number(i)]);
}

/** Parses "Name <a@b.c>" → { name, address }. */
export function parseAddress(author: string): { name: string; address: string } {
  const s = (author || '').trim();
  const m = s.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    const name = m[1].replace(/^"|"$/g, '').trim();
    return { name, address: m[2].trim().toLowerCase() };
  }
  const email = s.match(/[^\s<>"]+@[^\s<>"]+/);
  return { name: '', address: (email ? email[0] : s).toLowerCase() };
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1) : '';
}

export function formatDate(d: Date | string | undefined): string {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

/** "Re: [list] Fwd: Hello  world" → "hello world" (for matching messages in the same conversation). */
export function normalizeSubject(s: string | undefined): string {
  let t = (s ?? '').trim();
  for (;;) {
    const next = t.replace(/^((re|fwd?|aw|wg|sv|vs|antw|tr|rif)(\[\d+\])?\s*:|\[[^\]]{1,40}\])\s*/i, '');
    if (next === t) break;
    t = next;
  }
  return t.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Extracts <message-ids> from References / In-Reply-To header values (without angle brackets). */
export function parseMessageIds(values: string[] | undefined): string[] {
  const out: string[] = [];
  for (const v of values ?? []) for (const m of String(v).matchAll(/<([^<>\s]+)>/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
