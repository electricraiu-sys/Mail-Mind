import type { MessageHeader } from './types';
import { getHeaders, listAttachments } from './mail';
import { mapLimit } from './triage';

export interface AttachmentRow {
  messageId: number;
  subject: string;
  author: string;
  date: string;
  name: string;
  size: number;
  contentType: string;
  partName: string;
}

export type AttachmentCategory = 'pdf' | 'spreadsheet' | 'document' | 'image' | 'archive' | 'other';

export const CATEGORY_LABELS: Record<AttachmentCategory, string> = {
  pdf: 'PDFs',
  spreadsheet: 'Spreadsheets',
  document: 'Documents',
  image: 'Images',
  archive: 'Archives',
  other: 'Other',
};

export const CATEGORY_ICONS: Record<AttachmentCategory, string> = {
  pdf: '📕',
  spreadsheet: '📊',
  document: '📄',
  image: '🖼',
  archive: '🗜',
  other: '📎',
};

export function categoryOf(contentType: string, name: string): AttachmentCategory {
  const t = (contentType || '').toLowerCase();
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  if (t.includes('pdf') || ext === 'pdf') return 'pdf';
  if (/spreadsheet|excel|csv/.test(t) || ['xls', 'xlsx', 'csv', 'ods', 'numbers'].includes(ext)) return 'spreadsheet';
  if (t.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'heic', 'webp', 'bmp', 'tif', 'tiff'].includes(ext)) return 'image';
  if (/zip|compressed|x-7z|x-rar|gzip|tar/.test(t) || ['zip', '7z', 'rar', 'gz', 'tar'].includes(ext)) return 'archive';
  if (/word|document|text\/plain|rtf|presentation|powerpoint/.test(t) || ['doc', 'docx', 'odt', 'rtf', 'txt', 'ppt', 'pptx', 'odp', 'pages', 'key'].includes(ext))
    return 'document';
  return 'other';
}

/** Logos, tracking pixels and signature images that clutter attachment lists. */
export function isSmallInlineImage(a: { contentType: string; name: string; size: number }): boolean {
  return categoryOf(a.contentType, a.name) === 'image' && (a.size < 30 * 1024 || /^(image\d{3}|logo|icon|spacer|outlook-)/i.test(a.name));
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function collectAttachments(
  messageIds: number[],
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; headers?: MessageHeader[] } = {},
): Promise<AttachmentRow[]> {
  const headers = opts.headers ?? (await getHeaders(messageIds));
  const rows: AttachmentRow[] = [];
  let done = 0;
  await mapLimit(headers, 4, async (h) => {
    if (opts.signal?.aborted) return;
    const atts = await listAttachments(h.id);
    for (const a of atts) {
      rows.push({
        messageId: h.id,
        subject: h.subject || '(no subject)',
        author: h.author,
        date: h.date ? new Date(h.date).toISOString().slice(0, 10) : '',
        name: a.name || 'attachment',
        size: a.size ?? 0,
        contentType: a.contentType ?? '',
        partName: a.partName,
      });
    }
    opts.onProgress?.(++done, headers.length);
  });
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.name.localeCompare(b.name)));
}

export function summarizeAttachments(rows: AttachmentRow[], max = 80): string {
  const real = rows.filter((r) => !isSmallInlineImage(r));
  const hidden = rows.length - real.length;
  const emails = new Set(real.map((r) => r.messageId)).size;
  const total = real.reduce((n, r) => n + r.size, 0);
  if (!real.length) return `No attachments found${hidden ? ` (only ${hidden} small inline images/logos)` : ''}.`;
  const lines = real.slice(0, max).map((r) => `- ${r.date} | ${r.name} (${formatSize(r.size)}) | email [${r.messageId}] "${r.subject}"`);
  return [
    `${real.length} attachments (${formatSize(total)}) in ${emails} emails${hidden ? `; ${hidden} small inline images/logos hidden` : ''}:`,
    ...lines,
    real.length > max ? `…and ${real.length - max} more (all are listed in the card shown to the user).` : '',
    'The user sees an attachments card with Open / Save / Save all (.zip) buttons.',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function attachmentFile(row: Pick<AttachmentRow, 'messageId' | 'partName'>): Promise<File> {
  return messenger.messages.getAttachmentFile(row.messageId, row.partName);
}

/** Makes names unique inside a zip: "a.pdf", "a (2).pdf", … */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const name = raw.replace(/[\\/:*?"<>|]+/g, '_') || 'attachment';
    const key = name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n === 1) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
  });
}
