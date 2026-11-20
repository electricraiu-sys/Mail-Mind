import '../../core/aiActivity'; // lets the background junk scan pause while this page uses the AI
import { $ } from '../dom';
import { getSettings } from '../../core/settings';
import { LlmClient, describeLlmError } from '../../core/llm';
import { COMPOSE_PROMPTS, REWRITE_SYSTEM, REVIEW_SYSTEM } from '../../core/prompts';
import { renderMarkdown, stripThinking, truncate } from '../../core/text';
import { insertIntoCompose, readOwnText, readFullText } from '../composeHelpers';

const out = $('#out');
const outActions = $('#outActions');
const replaceBtn = $('#btn-replace') as HTMLButtonElement;
const insertBtn = $('#btn-insert') as HTMLButtonElement;
const useSubjectBtn = $('#btn-use-subject') as HTMLButtonElement;
const copyBtn = $('#btn-copy') as HTMLButtonElement;
const stopBtn = $('#btn-stop') as HTMLButtonElement;
const opButtons = [...document.querySelectorAll('button[data-op], #btn-custom, #btn-review, #btn-subject')] as HTMLButtonElement[];

type Kind = 'rewrite' | 'review' | 'subject';
let tabId: number;
let lastText = '';
let lastKind: Kind = 'rewrite';
let controller: AbortController | null = null;

function setRunning(running: boolean) {
  for (const b of opButtons) b.disabled = running;
  outActions.classList.remove('hidden');
  stopBtn.classList.toggle('hidden', !running);
  replaceBtn.classList.toggle('hidden', running || lastKind !== 'rewrite');
  insertBtn.classList.toggle('hidden', running || lastKind !== 'rewrite');
  useSubjectBtn.classList.toggle('hidden', running || lastKind !== 'subject');
  copyBtn.classList.toggle('hidden', running);
}

async function run(kind: Kind, system: string, user: string) {
  const s = await getSettings();
  const llm = new LlmClient(s);
  controller = new AbortController();
  lastKind = kind;
  lastText = '';
  out.classList.toggle('plain', kind !== 'review');
  out.textContent = '…';
  setRunning(true);
  try {
    await llm.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      {
        signal: controller.signal,
        onDelta: (t) => {
          lastText += t;
          const clean = stripThinking(lastText);
          if (kind === 'review') out.innerHTML = renderMarkdown(clean);
          else out.textContent = clean;
        },
      },
    );
    lastText = stripThinking(lastText).trim().replace(/^["“]|["”]$/g, '');
    if (kind === 'subject') lastText = lastText.replace(/^subject:\s*/i, '').split('\n')[0].trim();
  } catch (e) {
    out.textContent = describeLlmError(e, s.baseUrl);
    lastKind = 'review';
  } finally {
    controller = null;
    setRunning(false);
  }
}

async function rewrite(instruction: string) {
  const { text } = await readOwnText(tabId);
  if (!text.trim()) {
    out.textContent = 'Write something in the email first (notes are fine).';
    outActions.classList.add('hidden');
    return;
  }
  const s = await getSettings();
  await run('rewrite', REWRITE_SYSTEM, `Instruction: ${instruction}\n\nEmail text:\n${truncate(text, s.maxCharsPerMessage * 2)}`);
}

for (const b of document.querySelectorAll<HTMLButtonElement>('button[data-op]')) {
  b.addEventListener('click', () => rewrite(COMPOSE_PROMPTS[b.dataset.op!]));
}

$('#btn-custom').addEventListener('click', () => {
  const v = ($('#custom') as HTMLInputElement).value.trim();
  if (v) rewrite(v);
});
$('#custom').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') $('#btn-custom').click();
});

$('#btn-review').addEventListener('click', async () => {
  const s = await getSettings();
  const d = await messenger.compose.getComposeDetails(tabId);
  const atts = await messenger.compose.listAttachments(tabId).catch(() => []);
  const full = await readFullText(tabId);
  const meta = [
    `To: ${[].concat(d.to ?? []).join(', ')}`,
    d.cc?.length ? `Cc: ${[].concat(d.cc).join(', ')}` : '',
    `Subject: ${d.subject ?? ''}`,
    `Attachments: ${atts.length ? atts.map((a: any) => a.name).join(', ') : 'none'}`,
  ]
    .filter(Boolean)
    .join('\n');
  await run('review', REVIEW_SYSTEM, `${meta}\n\nDraft (including any quoted thread):\n${truncate(full, s.maxCharsPerMessage * 2)}`);
});

$('#btn-subject').addEventListener('click', async () => {
  const { text } = await readOwnText(tabId);
  await run('subject', 'Suggest one concise, specific email subject line. Reply with the subject only.', truncate(text || '(empty)', 3000));
});

replaceBtn.addEventListener('click', async () => {
  if (!lastText) return;
  await insertIntoCompose(tabId, lastText, 'replaceOwn');
  window.close();
});
insertBtn.addEventListener('click', async () => {
  if (!lastText) return;
  await insertIntoCompose(tabId, lastText, 'prepend');
  window.close();
});
useSubjectBtn.addEventListener('click', async () => {
  if (!lastText) return;
  await messenger.compose.setComposeDetails(tabId, { subject: lastText });
  window.close();
});
copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(lastText);
  copyBtn.textContent = 'Copied';
  setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
});
stopBtn.addEventListener('click', () => controller?.abort());

(async () => {
  const [tab] = await messenger.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  if (tabId === undefined) {
    out.textContent = 'No compose window found.';
    for (const b of opButtons) b.disabled = true;
  }
})();
