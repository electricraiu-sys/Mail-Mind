import { textToHtml, bodyInner, splitComposeBody, htmlToText } from '../core/text';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function detailsWhenReady(tabId: number): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      return await messenger.compose.getComposeDetails(tabId);
    } catch (e) {
      lastErr = e;
      await sleep(150);
    }
  }
  throw lastErr;
}

/** Inserts text at the top of a compose window, keeping its signature and quoted text. */
export async function insertIntoCompose(tabId: number, text: string, mode: 'prepend' | 'replaceOwn' = 'prepend'): Promise<void> {
  const d = await detailsWhenReady(tabId);
  if (d.isPlainText) {
    const current: string = d.plainTextBody ?? '';
    const { rest } = splitComposeBody(current, false);
    const next = mode === 'replaceOwn' ? `${text.trim()}\n\n${rest}` : `${text.trim()}\n\n${current}`;
    await messenger.compose.setComposeDetails(tabId, { plainTextBody: next });
    return;
  }
  const html: string = d.body ?? '';
  const { before, inner, after } = bodyInner(html);
  const newHtml = textToHtml(text);
  let nextInner: string;
  if (mode === 'replaceOwn') {
    const { rest } = splitComposeBody(inner, true);
    nextInner = `${newHtml}<br>${rest}`;
  } else {
    nextInner = `${newHtml}<br>${inner}`;
  }
  await messenger.compose.setComposeDetails(tabId, { body: `${before}${nextInner}${after}` });
}

/** The user's own text in the compose window (without quote/signature), as plain text. */
export async function readOwnText(tabId: number): Promise<{ text: string; isPlainText: boolean; subject: string; details: any }> {
  const d = await detailsWhenReady(tabId);
  if (d.isPlainText) {
    return { text: splitComposeBody(d.plainTextBody ?? '', false).own.trim(), isPlainText: true, subject: d.subject ?? '', details: d };
  }
  const { inner } = bodyInner(d.body ?? '');
  return { text: htmlToText(splitComposeBody(inner, true).own), isPlainText: false, subject: d.subject ?? '', details: d };
}

/** Full compose text including quotes (for review). */
export async function readFullText(tabId: number): Promise<string> {
  const d = await detailsWhenReady(tabId);
  return d.isPlainText ? d.plainTextBody ?? '' : htmlToText(d.body ?? '');
}

export async function openNewDraft(d: { to?: string[]; cc?: string[]; subject?: string; body: string }): Promise<void> {
  const tab = await messenger.compose.beginNew({ to: d.to ?? [], cc: d.cc ?? [], subject: d.subject ?? '' });
  await insertIntoCompose(tab.id, d.body);
}

export async function openReplyDraft(messageId: number, body: string, replyAll = false): Promise<void> {
  const tab = await messenger.compose.beginReply(messageId, replyAll ? 'replyToAll' : 'replyToSender');
  await insertIntoCompose(tab.id, body);
}
