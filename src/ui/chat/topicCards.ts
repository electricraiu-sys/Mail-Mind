import { el, confirmButton, plural, download } from '../dom';
import { card, statusArea, folderSelect, type CardDeps } from './cards';
import type { TopicResult } from '../../core/topic';
import type { ActionKind } from '../../core/types';
import { ACTION_LABELS } from '../../core/types';
import { executeAction } from '../../core/actions';
import { openMessage } from '../../core/mail';
import { parseAddress, formatDate } from '../../core/text';
import {
  collectAttachments,
  attachmentFile,
  categoryOf,
  formatSize,
  isSmallInlineImage,
  uniqueNames,
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  type AttachmentRow,
  type AttachmentCategory,
} from '../../core/attachments';
import { makeZip } from '../../core/zip';

function openLink(messageId: number): HTMLAnchorElement {
  const a = el('a', { href: '#', class: 'small' }, 'open');
  a.addEventListener('click', (e) => {
    e.preventDefault();
    openMessage(messageId);
  });
  return a;
}

// ---------------------------------------------------------------------------
// Topic search results ("all emails about my stock trading")
// ---------------------------------------------------------------------------

export function topicCard(r: TopicResult, resultSetId: string, deps: CardDeps, append: (node: HTMLElement) => void): HTMLElement {
  const hits = r.hits;
  const chosen = new Set(hits.map((h) => h.header.id));
  const removed = new Set<number>();
  const status = statusArea(deps);
  const list = el('div', { class: 'msg-list' });
  const SHOW = 300;
  for (const h of hits.slice(0, SHOW)) {
    const m = h.header;
    const box = el('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    box.addEventListener('change', () => (box.checked ? chosen.add(m.id) : chosen.delete(m.id)));
    const who = parseAddress(m.author);
    list.append(
      el(
        'label',
        { class: 'msg-row', title: `Matched: ${h.matched.join(', ')}` },
        box,
        el('span', { class: 'small muted date' }, formatDate(m.date)),
        el('span', { class: 'small from' }, who.name || who.address),
        el('span', { class: 'subj' }, m.subject || '(no subject)'),
        openLink(m.id),
      ),
    );
  }
  if (hits.length > SHOW) list.append(el('div', { class: 'small muted' }, `…and ${hits.length - SHOW} more (included in actions)`));

  const ids = () => [...chosen].filter((id) => !removed.has(id));
  const run = async (kind: ActionKind, folderId?: string) => {
    const sel = ids();
    if (!sel.length) return;
    const onProgress = status.working(`${ACTION_LABELS[kind]}…`);
    try {
      const { entry, skipped } = await executeAction(kind, sel, { folderId, onProgress, source: `Topic: ${r.topic}` });
      for (const id of sel) removed.add(id);
      status.done(entry, skipped);
      deps.note(`User applied "${ACTION_LABELS[kind]}" to ${entry.count} of the emails about "${r.topic}" (${resultSetId}).`);
    } catch (e) {
      status.error(e);
    }
  };

  const attBtn = el('button', { class: 'primary' }, '📎 List attachments');
  attBtn.addEventListener('click', async () => {
    attBtn.disabled = true;
    const onProgress = status.working('Listing attachments…');
    try {
      const rows = await collectAttachments([], { headers: hits.map((h) => h.header).filter((m) => chosen.has(m.id) && !removed.has(m.id)), onProgress });
      status.node.classList.add('hidden');
      append(attachmentsCard(rows, `Attachments · ${r.topic}`, deps));
    } catch (e) {
      status.error(e);
    } finally {
      attBtn.disabled = false;
    }
  });
  const moveSel = folderSelect();
  const moveBtn = el('button', null, 'Move');
  moveBtn.addEventListener('click', () => (moveSel.value ? run('move', moveSel.value) : moveSel.focus()));
  const archiveBtn = el('button', null, 'Archive');
  archiveBtn.addEventListener('click', () => run('archive'));
  const delBtn = confirmButton('🗑 Delete', () => `Confirm: move ${plural(ids().length, 'email')} to Trash`, () => run('delete'));

  const dropped = r.candidates - hits.length;
  const searched = [...r.plan.keywords.map((k) => `“${k}”`), ...r.plan.senders.map((s) => `from ${s}`)];
  return card(
    `Emails about “${r.topic}” · ${plural(hits.length, 'email')}`,
    el(
      'div',
      { class: 'small muted' },
      `Searched ${searched.join(', ')}. `,
      r.verified && dropped ? `AI removed ${plural(dropped, 'off-topic match', 'off-topic matches')}. ` : '',
      r.verifyError ? `(Relevance check unavailable: ${r.verifyError}) ` : '',
      r.capped ? 'Too many matches, so results were capped — try a date range. ' : '',
      hits.length ? 'Hover an email to see what matched.' : '',
    ),
    hits.length ? list : el('div', { class: 'muted small' }, 'Nothing found. Try different words or a wider date range.'),
    hits.length ? el('div', { class: 'card-actions row' }, attBtn, moveSel, moveBtn, archiveBtn, delBtn) : null,
    status.node,
  );
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

async function openAttachment(row: AttachmentRow) {
  try {
    const tab = await messenger.tabs.getCurrent();
    await messenger.messages.openAttachment(row.messageId, row.partName, tab?.id);
  } catch {
    // Fall back to saving it if Thunderbird can't open it from this tab.
    download(await attachmentFile(row), row.name);
  }
}

export function attachmentsCard(rows: AttachmentRow[], title: string, deps: CardDeps): HTMLElement {
  let showSmall = false;
  let category: AttachmentCategory | 'all' = 'all';
  let filter = '';
  const chosen = new Set<AttachmentRow>(rows.filter((r) => !isSmallInlineImage(r)));
  const status = statusArea(deps);
  const list = el('div', { class: 'msg-list att-list' });
  const summary = el('span', { class: 'small muted' });
  const chips = el('div', { class: 'row chips' });
  const filterInput = el('input', { type: 'text', placeholder: 'Filter by file name, sender or subject…', class: 'att-filter' }) as HTMLInputElement;
  const smallBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const smallCount = rows.filter(isSmallInlineImage).length;
  const cat = (r: AttachmentRow) => categoryOf(r.contentType, r.name);

  const visible = () =>
    rows.filter(
      (r) =>
        (showSmall || !isSmallInlineImage(r)) &&
        (category === 'all' || cat(r) === category) &&
        (!filter || `${r.name} ${r.subject} ${r.author}`.toLowerCase().includes(filter)),
    );

  function renderChips() {
    const counts = new Map<AttachmentCategory, number>();
    for (const r of rows) if (showSmall || !isSmallInlineImage(r)) counts.set(cat(r), (counts.get(cat(r)) ?? 0) + 1);
    const make = (key: AttachmentCategory | 'all', label: string) => {
      const b = el('button', { class: `small chip${category === key ? ' primary' : ''}` }, label);
      b.addEventListener('click', () => {
        category = key;
        render();
      });
      return b;
    };
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    chips.replaceChildren(make('all', `All (${total})`), ...[...counts.entries()].map(([k, n]) => make(k, `${CATEGORY_ICONS[k]} ${CATEGORY_LABELS[k]} (${n})`)));
  }

  function render() {
    renderChips();
    list.replaceChildren();
    const vis = visible();
    for (const r of vis.slice(0, 500)) {
      const box = el('input', { type: 'checkbox', checked: chosen.has(r) }) as HTMLInputElement;
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(r);
        else chosen.delete(r);
        updateSummary();
      });
      const open = el('button', { class: 'small ghost', title: 'Open with the default program' }, 'Open');
      open.addEventListener('click', (e) => {
        e.preventDefault();
        openAttachment(r);
      });
      const save = el('button', { class: 'small ghost' }, 'Save');
      save.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          download(await attachmentFile(r), r.name);
        } catch (err) {
          status.error(err);
        }
      });
      const who = parseAddress(r.author);
      list.append(
        el(
          'label',
          { class: 'msg-row att-row' },
          box,
          el('span', { class: 'att-icon' }, CATEGORY_ICONS[cat(r)]),
          el('span', { class: 'att-main' }, el('span', { class: 'att-name' }, r.name), el('span', { class: 'small muted att-from' }, `${r.date} · ${who.name || who.address} · ${r.subject}`)),
          el('span', { class: 'small muted att-size' }, formatSize(r.size)),
          open,
          save,
          openLink(r.messageId),
        ),
      );
    }
    if (vis.length > 500) list.append(el('div', { class: 'small muted' }, `…and ${vis.length - 500} more — use the filter to narrow down.`));
    if (!vis.length) list.append(el('div', { class: 'small muted pad' }, rows.length ? 'No attachments match the filter.' : 'These emails have no attachments.'));
    updateSummary();
  }

  const selectedVisible = () => {
    const vis = new Set(visible());
    return [...chosen].filter((r) => vis.has(r));
  };

  function updateSummary() {
    const sel = selectedVisible();
    summary.textContent = `${plural(sel.length, 'file')} selected · ${formatSize(sel.reduce((n, r) => n + r.size, 0))}`;
    zipSel.disabled = sel.length === 0;
  }

  async function saveZip(which: AttachmentRow[]) {
    if (!which.length) return;
    zipSel.disabled = true;
    const onProgress = status.working('Collecting files…');
    try {
      const names = uniqueNames(which.map((r) => `${r.date} ${r.name}`.trim()));
      const entries = [];
      for (let i = 0; i < which.length; i++) {
        const f = await attachmentFile(which[i]);
        entries.push({ name: names[i], data: new Uint8Array(await f.arrayBuffer()), date: new Date(which[i].date || Date.now()) });
        onProgress(i + 1, which.length);
      }
      const zip = makeZip(entries);
      const safe = title.replace(/^Attachments · /, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'attachments';
      download(new Blob([zip.buffer as ArrayBuffer], { type: 'application/zip' }), `mailmind-${safe}.zip`);
      status.node.replaceChildren(el('div', { class: 'notice ok' }, `✓ Saved ${plural(which.length, 'file')} (${formatSize(zip.length)}) as a zip.`));
      deps.note(`User saved ${which.length} attachments as a zip.`);
    } catch (e) {
      status.error(e);
    } finally {
      updateSummary();
    }
  }

  const zipSel = el('button', { class: 'primary' }, '⬇ Save selected (.zip)');
  zipSel.addEventListener('click', () => saveZip(selectedVisible()));
  const selAll = el('button', { class: 'small' }, 'Select all shown');
  selAll.addEventListener('click', () => {
    for (const r of visible()) chosen.add(r);
    render();
  });
  const selNone = el('button', { class: 'small' }, 'Select none');
  selNone.addEventListener('click', () => {
    chosen.clear();
    render();
  });
  filterInput.addEventListener('input', () => {
    filter = filterInput.value.trim().toLowerCase();
    render();
  });
  smallBox.addEventListener('change', () => {
    showSmall = smallBox.checked;
    if (showSmall) for (const r of rows) if (isSmallInlineImage(r)) chosen.add(r);
    render();
  });

  const real = rows.filter((r) => !isSmallInlineImage(r));
  const root = card(
    `${title} · ${plural(real.length, 'file')} (${formatSize(real.reduce((n, r) => n + r.size, 0))}) in ${plural(new Set(real.map((r) => r.messageId)).size, 'email')}`,
    rows.length ? chips : null,
    rows.length ? el('div', { class: 'row' }, filterInput, selAll, selNone) : null,
    list,
    rows.length
      ? el(
          'div',
          { class: 'card-actions' },
          el('div', { class: 'row' }, zipSel, summary),
          smallCount ? el('label', { class: 'row small muted' }, smallBox, `Show ${smallCount} small inline images (logos, signatures)`) : null,
        )
      : null,
    status.node,
  );
  render();
  return root;
}
