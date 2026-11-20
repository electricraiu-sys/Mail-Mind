import { el, confirmButton, plural, progressBar } from '../dom';
import type { TriageResult, SenderGroup, Caution } from '../../core/triage';
import { isLikelyJunk, markKept, markUserJunk, cautionsFor, senderCautions, importanceOf } from '../../core/triage';
import { keepSender, unkeepSender, markJunkSender, unmarkJunkSender } from '../../core/feedback';
import type { FilingResult } from '../../core/filing';
import type { Proposal, Draft, RuleDraft } from '../../core/tools';
import type { ActionKind, MailFolder } from '../../core/types';
import { ACTION_LABELS, VERDICT_LABELS } from '../../core/types';
import { executeAction, undo, onQueueChange, queueSnapshot, type UndoEntry, type QueuePosition, type QueueSnapshot } from '../../core/actions';
import { addRule, type RuleActionKind } from '../../core/rules';
import { collectMessages, folderLabel, listFolders, openMessage, hasUse, NOT_A_DESTINATION } from '../../core/mail';
import { parseAddress, formatDate } from '../../core/text';
import { openNewDraft, openReplyDraft } from '../composeHelpers';
import { allTags, ensureTags, tagLabel } from '../../core/autotag';
import { getSettings } from '../../core/settings';

export interface CardDeps {
  /** Tells the AI (on the next turn) what the user did with a card. */
  note(text: string): void;
}

let folderCache: { folder: MailFolder; label: string }[] | null = null;

async function destinationFolders(): Promise<{ folder: MailFolder; label: string }[]> {
  if (!folderCache) {
    const all = await listFolders();
    folderCache = await Promise.all(
      all.filter((f) => !hasUse(f, ...NOT_A_DESTINATION) || hasUse(f, 'inbox')).map(async (f) => ({ folder: f, label: await folderLabel(f) })),
    );
    folderCache.sort((a, b) => a.label.localeCompare(b.label));
  }
  return folderCache;
}

export function invalidateFolderCache(): void {
  folderCache = null;
}

export function folderSelect(): HTMLSelectElement {
  const sel = el('select', { title: 'Destination folder' }, el('option', { value: '' }, 'Move to folder…'));
  destinationFolders().then((list) => {
    for (const { folder, label } of list) sel.appendChild(el('option', { value: folder.id }, label));
  });
  return sel;
}

export function card(title: string, ...children: (Node | string | null | false)[]): HTMLElement {
  return el('div', { class: 'card' }, el('div', { class: 'card-title' }, title), ...children);
}

/** Status line with progress, success text and an Undo button. */
export function statusArea(deps: CardDeps) {
  const node = el('div', { class: 'card-status hidden' });
  return {
    node,
    /** Shown while the action waits for earlier ones to finish. */
    queued(label: string, pos?: QueuePosition) {
      node.classList.remove('hidden');
      const where = pos
        ? `waiting for ${pos.jobsAhead === 1 ? 'the action ahead' : `${pos.jobsAhead} actions ahead`}${pos.emailsAhead ? ` (${plural(pos.emailsAhead, 'email')} left)` : ''}`
        : 'queued, starts when the previous action finishes';
      node.replaceChildren(el('div', { class: 'small muted' }, `${label} — ${where}…`));
    },
    working(label: string) {
      node.classList.remove('hidden');
      node.replaceChildren();
      const bar = progressBar();
      const text = el('div', { class: 'small muted' }, label);
      node.append(text, bar.node);
      return (done: number, total: number) => {
        text.textContent = `${label} ${done}/${total}`;
        bar.set(total ? done / total : undefined);
      };
    },
    done(entry: UndoEntry, skipped: number, extra = '') {
      node.classList.remove('hidden');
      node.replaceChildren();
      const msg = el('span', null, `✓ ${entry.label}${skipped ? ` (${skipped} skipped)` : ''}${extra}`);
      const undoBtn = el('button', { class: 'small' }, 'Undo');
      undoBtn.addEventListener('click', async () => {
        undoBtn.disabled = true;
        undoBtn.textContent = 'Undoing…';
        try {
          const r = await undo(entry.id);
          msg.textContent = `↩ Undone: restored ${r.restored}${r.missing ? `, ${r.missing} couldn't be found` : ''}.`;
          undoBtn.remove();
          deps.note(`User clicked Undo on "${entry.label}" (restored ${r.restored}).`);
        } catch (e) {
          msg.textContent = `Undo failed: ${(e as Error).message}`;
          undoBtn.disabled = false;
          undoBtn.textContent = 'Undo';
        }
      });
      node.append(el('div', { class: 'row notice ok' }, msg, el('span', { class: 'spacer' }), entry.count ? undoBtn : null));
    },
    error(e: unknown) {
      node.classList.remove('hidden');
      node.replaceChildren(el('div', { class: 'notice error' }, `Failed: ${e instanceof Error ? e.message : String(e)}`));
    },
  };
}

/** "about 3 min left" style text, or '' when there's no estimate yet. */
export function formatEta(ms?: number): string {
  if (ms === undefined) return '';
  const s = Math.round(ms / 1000);
  if (s < 10) return 'almost done';
  if (s < 60) return 'less than a minute left';
  const m = Math.round(s / 60);
  if (m < 60) return `about ${plural(m, 'min')} left`;
  const h = Math.floor(m / 60);
  return `about ${h} h ${m % 60} min left`;
}

/** Text for the whole-queue summary, or null when there's nothing worth summarising (fewer than 2 actions). */
export function queueSummaryText(s: QueueSnapshot): string | null {
  if (s.jobs < 2) return null;
  const eta = formatEta(s.etaMs);
  return `Queue: ${plural(s.jobs, 'action')} · ${s.done.toLocaleString()} of ${plural(s.total, 'email')} done${eta ? ` · ${eta}` : ''}`;
}

/**
 * Whole-queue progress (all actions from every card), shown above the per-action rows while 2+ actions are
 * running or waiting. Stops listening once the card is removed.
 */
function queueSummary(): HTMLElement {
  const text = el('div', { class: 'small' });
  const bar = progressBar();
  const node = el('div', { class: 'queue-summary hidden' }, text, bar.node);
  const show = (s: QueueSnapshot) => {
    const t = queueSummaryText(s);
    node.classList.toggle('hidden', !t);
    if (!t) return;
    text.textContent = t;
    bar.set(s.total ? s.done / s.total : undefined);
  };
  let seen = false;
  const stop = onQueueChange((s) => {
    if (node.isConnected) seen = true;
    else if (seen) return stop();
    show(s);
  });
  show(queueSnapshot());
  return node;
}

// ---------------------------------------------------------------------------
// Sender-grouped junk review (the flagship clean-up card)
// ---------------------------------------------------------------------------

export interface SenderReviewView {
  node: HTMLElement;
  /** Re-renders after the AI updated verdicts in place (result.groups is shared and mutated). */
  refresh(): void;
}

/**
 * Shown as soon as heuristics finish; AI verdicts stream in afterwards via refresh(), so the user can
 * delete, keep or move senders while the model is still working on the rest.
 */
export function senderReviewCard(result: TriageResult, deps: CardDeps): SenderReviewView {
  const c = result.criteria;
  const range = c.fromDate || c.toDate ? `${c.fromDate ?? '…'} → ${c.toDate ?? '…'}` : 'all dates';
  const likely = () => result.groups.filter(isLikelyJunk);
  let showAll = !result.aiRunning && likely().length === 0;
  const selected = new Map<string, Set<number>>(); // address → selected message ids
  const removed = new Set<number>();
  const expanded = new Set<string>();
  /** State before "Not junk" was clicked, so it can be undone in this card. */
  const beforeKeep = new Map<string, Pick<SenderGroup, 'score' | 'verdict' | 'reason' | 'source' | 'confidence'>>();
  const headNote = el('div', { class: 'small muted' });

  const list = el('div', { class: 'sender-list' });
  const summary = el('span', { class: 'small muted' });
  const status = statusArea(deps);
  /** One status row per action, so you can start more while earlier ones (and the AI review) are still running. */
  const jobs = el('div', { class: 'card-jobs' });
  const allYears = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const futureRule = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const allYearsNote = el('span', { class: 'small muted' });
  const moveSel = folderSelect();
  const toggleAll = el('input', { type: 'checkbox', title: 'Select all shown' }) as HTMLInputElement;
  const showAllBtn = el('button', { class: 'small ghost' });

  const visible = () => (showAll ? result.groups : likely()).filter((g) => g.messages.some((m) => !removed.has(m.id))).slice(0, 300);
  const liveMessages = (g: SenderGroup) => g.messages.filter((m) => !removed.has(m.id));
  const selectedIds = () => [...selected.values()].flatMap((s) => [...s]).filter((id) => !removed.has(id));
  const selectedSenders = () => [...selected.entries()].filter(([, s]) => [...s].some((id) => !removed.has(id))).map(([a]) => a);

  function setSender(g: SenderGroup, on: boolean) {
    if (on) selected.set(g.address, new Set(liveMessages(g).map((m) => m.id)));
    else selected.delete(g.address);
  }

  function updateSummary() {
    const ids = selectedIds();
    const senders = selectedSenders();
    summary.textContent = ids.length ? `Selected: ${plural(senders.length, 'sender')}, ${plural(ids.length, 'email')}` : 'Tick senders (or individual emails) to act on them.';
    for (const b of [...actionButtons, keepBtn, teachBtn]) b.disabled = ids.length === 0;
    const vis = visible();
    const allOn = vis.length > 0 && vis.every((g) => selected.get(g.address)?.size === liveMessages(g).length);
    toggleAll.checked = allOn;
    toggleAll.indeterminate = !allOn && ids.length > 0;
    showAllBtn.textContent = showAll ? `Show only likely junk (${likely().length})` : `Show all ${result.groups.length} senders`;
    allYearsNote.textContent = '';
    // The warning describes one specific selection; drop it if the selection changed underneath.
    if (cautionKey && cautionKey !== selectionKey()) closeCaution();
  }

  function updateHeadNote() {
    const pending = result.groups.filter((g) => g.aiPending).length;
    const base = `Scanned ${plural(result.scanned, 'email')} from ${plural(result.groups.length, 'sender')}. ${likely().length} look unwanted.`;
    headNote.textContent = result.aiRunning
      ? `${base} AI is still reviewing ${plural(pending, 'sender')} — you can act on the ones listed now.`
      : `${base}${result.aiUsed ? ' AI reviewed the uncertain ones.' : result.aiError ? ` (AI unavailable — heuristics only: ${result.aiError})` : ''}`;
  }

  function render() {
    list.replaceChildren();
    const vis = visible();
    // Never act on something the user can't see (e.g. the AI just moved it out of "likely junk").
    const shown = new Set(vis.map((g) => g.address));
    for (const a of [...selected.keys()]) if (!shown.has(a)) selected.delete(a);
    if (!vis.length) {
      const empty = showAll ? 'No senders left.' : result.aiRunning ? 'Nothing flagged yet — AI is still reviewing…' : 'Nothing looks like junk in this range. 🎉';
      list.append(el('div', { class: 'muted small pad' }, empty));
    }
    for (const g of vis) list.append(senderRow(g));
    updateHeadNote();
    updateSummary();
  }

  const remember = (g: SenderGroup) => {
    // Only the state before the user's first verdict, so "Junk" then "Not junk" then undo goes back to the AI's view.
    if (!g.userKept && !g.userJunk) beforeKeep.set(g.address, { score: g.score, verdict: g.verdict, reason: g.reason, source: g.source, confidence: g.confidence });
  };

  /** "👎 Junk": teaches MailMind this sender is unwanted. Moves no email; the selection stays so it can be deleted next. */
  async function teachJunk(groups: SenderGroup[]) {
    groups = groups.filter((g) => !g.userJunk);
    for (const g of groups) {
      remember(g);
      markUserJunk(g);
      g.handled = true;
    }
    render();
    try {
      for (const g of groups) await markJunkSender({ address: g.address, name: g.name, sample: g.subjects[0] });
      const names = groups.map((g) => g.address);
      if (names.length) deps.note(`User marked ${names.slice(0, 10).join(', ')}${names.length > 10 ? '…' : ''} as JUNK. MailMind will remember this and treat similar mail as unwanted in future clean-ups.`);
    } catch (e) {
      status.error(e);
    }
  }

  async function unteachJunk(g: SenderGroup) {
    const prev = beforeKeep.get(g.address);
    await unmarkJunkSender(g.address);
    g.userJunk = false;
    if (prev) Object.assign(g, prev);
    else {
      g.score = 0.45;
      g.reason = 'No longer marked as junk';
      g.source = 'heuristic';
    }
    beforeKeep.delete(g.address);
    render();
    deps.note(`User removed ${g.address} from their junk list.`);
  }

  async function keep(groups: SenderGroup[]) {
    for (const g of groups) {
      if (g.userKept) continue;
      remember(g);
      markKept(g);
      g.handled = true;
      selected.delete(g.address);
    }
    render();
    try {
      for (const g of groups) await keepSender({ address: g.address, name: g.name, sample: g.subjects[0] });
      const names = groups.map((g) => g.address);
      deps.note(`User marked ${names.slice(0, 10).join(', ')}${names.length > 10 ? '…' : ''} as NOT junk. MailMind will remember this for future clean-ups; don't suggest deleting mail from them.`);
    } catch (e) {
      status.error(e);
    }
  }

  async function unkeep(g: SenderGroup) {
    const prev = beforeKeep.get(g.address);
    await unkeepSender(g.address);
    g.userKept = false;
    if (prev) Object.assign(g, prev);
    else {
      // Kept in an earlier session: fall back to a neutral state rather than guessing a verdict.
      g.reason = 'No longer marked as not junk';
      g.source = 'heuristic';
    }
    beforeKeep.delete(g.address);
    render();
    deps.note(`User removed ${g.address} from their not-junk list.`);
  }

  function senderRow(g: SenderGroup): HTMLElement {
    const live = liveMessages(g);
    const sel = selected.get(g.address);
    const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = !!sel && sel.size === live.length;
    box.indeterminate = !!sel && sel.size > 0 && sel.size < live.length;
    box.addEventListener('change', () => {
      setSender(g, box.checked);
      render();
    });
    const isOpen = expanded.has(g.address);
    const toggle = el('button', { class: 'small ghost', title: 'Show emails' }, isOpen ? '▾ hide' : `▸ view ${live.length}`);
    toggle.addEventListener('click', () => {
      if (isOpen) expanded.delete(g.address);
      else expanded.add(g.address);
      render();
    });
    const unread = live.filter((m) => !m.read).length;
    const keepToggle = el(
      'button',
      { class: 'small ghost', title: g.userKept ? 'Forget that this sender is not junk' : 'Not junk — remember this sender and stop suggesting it' },
      g.userKept ? 'Undo keep' : '👍 Not junk',
    );
    keepToggle.addEventListener('click', () => (g.userKept ? unkeep(g) : keep([g])));
    const junkToggle = el(
      'button',
      { class: 'small ghost', title: g.userJunk ? 'Forget that this sender is junk' : 'Junk — teach MailMind this sender is unwanted (no email is moved)' },
      g.userJunk ? 'Undo junk' : '👎 Junk',
    );
    junkToggle.addEventListener('click', () => (g.userJunk ? unteachJunk(g) : teachJunk([g])));
    const badge = g.userKept
      ? el('span', { class: 'badge personal' }, 'not junk')
      : g.userJunk
        ? el('span', { class: 'badge junk', title: 'You marked this sender as junk' }, 'junk (you)')
        : el('span', { class: `badge ${g.verdict}` }, VERDICT_LABELS[g.verdict] ?? g.verdict);
    const kinds = [...new Set(live.map((m) => (m.flagged ? 'flagged by you' : m.importantKind)).filter(Boolean))] as string[];
    const cautionText = [...senderCautions(g), ...kinds];
    const caution = cautionText.length
      ? el('div', { class: 'small caution', title: 'You will be asked to confirm before these are deleted' }, `⚠ May be important: ${cautionText.join('; ')}`)
      : null;
    const row = el(
      'div',
      { class: 'sender' },
      el(
        'div',
        { class: 'sender-head' },
        box,
        badge,
        el(
          'div',
          { class: 'sender-name' },
          el('strong', null, g.name || g.address),
          g.name ? el('span', { class: 'muted small' }, ` ${g.address}`) : null,
          el('div', { class: 'small muted' }, `${plural(live.length, 'email')} · ${unread === live.length ? 'never opened' : `${unread} unread`} · ${g.firstDate.slice(0, 10)} → ${g.lastDate.slice(0, 10)}`),
          el('div', { class: 'small reason' }, `${g.reason}${g.source === 'ai' ? ' (AI)' : ''}`, g.aiPending ? el('span', { class: 'pending' }, ' · AI reviewing…') : null),
          caution,
        ),
        el('span', { class: 'score', title: 'Likelihood this is unwanted' }, `${Math.round(g.score * 100)}%`),
        keepToggle,
        junkToggle,
        toggle,
      ),
    );
    if (isOpen) {
      const msgs = el('div', { class: 'sender-messages' });
      for (const m of live.slice(0, 200)) {
        const mbox = el('input', { type: 'checkbox' }) as HTMLInputElement;
        mbox.checked = !!sel?.has(m.id);
        mbox.addEventListener('change', () => {
          const s = selected.get(g.address) ?? new Set<number>();
          if (mbox.checked) s.add(m.id);
          else s.delete(m.id);
          if (s.size) selected.set(g.address, s);
          else selected.delete(g.address);
          render();
        });
        const open = el('a', { href: '#', class: 'small' }, 'open');
        open.addEventListener('click', (e) => {
          e.preventDefault();
          openMessage(m.id);
        });
        const why = m.flagged ? 'flagged by you' : m.importantKind;
        msgs.append(
          el(
            'label',
            { class: 'msg-row' },
            mbox,
            el('span', { class: 'small muted date' }, m.date),
            el('span', { class: `subj${m.read ? '' : ' unread'}` }, m.subject),
            why
              ? el('span', { class: 'small caution', title: `May be important: ${why}` }, `⚠ ${why}`)
              : m.expiredCode
                ? el('span', { class: 'small muted', title: 'One-time codes stop working within minutes; this one is over a week old' }, '⏱ expired login code')
                : m.timely && !m.timely.upcoming
                ? el('span', { class: 'small muted', title: 'This notice is about a date that has passed' }, `⏱ ${m.timely.label}`)
                : null,
            open,
          ),
        );
      }
      if (live.length > 200) msgs.append(el('div', { class: 'small muted' }, `…and ${live.length - 200} more (selecting the sender includes all of them)`));
      row.append(msgs);
    }
    return row;
  }

  async function idsForAction(): Promise<number[]> {
    const ids = new Set(selectedIds());
    if (!allYears.checked) return [...ids];
    // Whole-sender selections expand to every year.
    for (const address of selectedSenders()) {
      const g = result.groups.find((x) => x.address === address);
      if (!g || selected.get(address)!.size !== liveMessages(g).length) continue;
      const more = await collectMessages({ author: address }, { limit: 20000 });
      for (const m of more) {
        if (parseAddress(m.author).address !== address || hasUse(m.folder, 'trash')) continue;
        ids.add(m.id);
        extraInfo.set(m.id, { address, subject: m.subject, date: m.date, flagged: m.flagged });
      }
    }
    return [...ids];
  }
  /** Subjects of emails pulled in by "all years", so they get the same importance check. */
  const extraInfo = new Map<number, { address: string; subject: string; date?: Date | string; flagged?: boolean }>();

  // --- "These may be important" confirmation -------------------------------------------------
  const cautionNode = el('div', { class: 'caution-panel hidden' });
  let cautionKey = '';
  const selectionKey = () => `${allYears.checked}|${selectedIds().sort((a, b) => a - b).join(',')}|${futureRule.checked}`;
  function closeCaution() {
    cautionNode.classList.add('hidden');
    cautionNode.replaceChildren();
    cautionKey = '';
  }

  /** Shows which selected emails may matter; the user picks "anyway", "skip those" or cancel. */
  function showCaution(kind: 'delete' | 'mark_junk', ids: number[], cautions: Caution[]) {
    const flagged = new Set(cautions.flatMap((c) => c.ids));
    const rest = ids.filter((id) => !flagged.has(id));
    const verb = kind === 'delete' ? 'Delete' : 'Mark as junk';
    const items = cautions.slice(0, 8).map((c) =>
      el(
        'li',
        null,
        el('strong', null, c.name || c.address),
        ` · ${plural(c.ids.length, 'email')} — ${c.reasons.join('; ')}`,
        c.samples.length ? el('div', { class: 'small muted' }, c.samples.map((s) => `“${s}”`).join(', ')) : null,
      ),
    );
    if (cautions.length > 8) items.push(el('li', { class: 'muted' }, `…and ${plural(cautions.length - 8, 'more sender')}`));
    const anyway = el('button', { class: 'danger' }, `${verb} all ${ids.length} anyway`);
    anyway.addEventListener('click', () => {
      closeCaution();
      deps.note(`User was warned that ${flagged.size} selected emails may be important (${cautions.map((c) => c.reasons.join('/')).slice(0, 5).join('; ')}) and chose to ${verb.toLowerCase()} them anyway.`);
      run(kind, undefined, ids);
    });
    const skip = el('button', { class: 'primary' }, `${verb} the other ${rest.length} only`);
    skip.addEventListener('click', () => {
      closeCaution();
      // Leave the important ones selected-off so the user can see what was kept.
      for (const id of flagged) for (const s of selected.values()) s.delete(id);
      run(kind, undefined, rest);
    });
    const cancel = el('button', null, 'Cancel');
    cancel.addEventListener('click', closeCaution);
    cautionNode.replaceChildren(
      el('div', { class: 'caution-title' }, `⚠ ${plural(flagged.size, 'email')} you selected may be important`),
      el('div', { class: 'small' }, 'They look like orders, receipts, bills, account or personal mail. Check before removing them — you may need them later.'),
      el('ul', { class: 'small' }, ...items),
    );
    if (futureRule.checked) cautionNode.append(el('div', { class: 'small' }, 'Note: a rule for future emails will also be created for each sender you go ahead with.'));
    cautionNode.append(el('div', { class: 'row' }, rest.length ? skip : null, anyway, cancel));
    cautionNode.classList.remove('hidden');
    cautionKey = selectionKey();
    cautionNode.scrollIntoView({ block: 'nearest' });
  }

  /** Delete / mark-junk entry point: warn about possibly important mail, otherwise ask for a second click. */
  function guardedButton(kind: 'delete' | 'mark_junk', label: string): HTMLButtonElement {
    const btn = el('button', null, label);
    let armed: number[] | null = null;
    let timer: number | undefined;
    const disarm = () => {
      armed = null;
      window.clearTimeout(timer);
      btn.textContent = label;
      btn.className = '';
    };
    btn.addEventListener('click', async () => {
      if (armed) {
        const ids = armed;
        disarm();
        return run(kind, undefined, ids);
      }
      const ids = await idsForAction();
      if (!ids.length) return;
      const cautions = cautionsFor(result.groups, ids, extraInfo);
      if (cautions.length) return showCaution(kind, ids, cautions);
      closeCaution();
      armed = ids;
      btn.textContent = kind === 'delete' ? `Confirm: move ${plural(ids.length, 'email')} to Trash` : `Confirm: mark ${plural(ids.length, 'email')} as junk`;
      btn.className = 'danger';
      timer = window.setTimeout(disarm, 5000);
    });
    return btn;
  }

  allYears.addEventListener('change', async () => {
    if (!allYears.checked) return updateSummary();
    allYearsNote.textContent = 'Counting…';
    const ids = await idsForAction();
    allYearsNote.textContent = `→ ${plural(ids.length, 'email')} across all years`;
  });

  /**
   * Runs an action as its own job. The emails leave the list straight away and the buttons stay enabled,
   * so you can keep working on other senders. Actions run in order on a queue that is separate from the
   * AI review.
   */
  async function run(kind: ActionKind, folderId?: string, presetIds?: number[]) {
    closeCaution();
    const ids = presetIds ?? (await idsForAction());
    if (!ids.length) return;
    const senders = selectedSenders();
    const wantRule = futureRule.checked;
    const touched = senders.map((a) => result.groups.find((x) => x.address === a)).filter((g): g is SenderGroup => !!g);
    // Tell the still-running AI review to skip these; the user has decided.
    const wasHandled = touched.map((g) => g.handled);
    for (const g of touched) g.handled = true;
    // Optimistically take them out of the list and the selection, so the next action can't pick them up too.
    const newlyRemoved = ids.filter((id) => !removed.has(id));
    for (const id of newlyRemoved) removed.add(id);
    for (const a of senders) selected.delete(a);
    futureRule.checked = false;
    allYears.checked = false;

    const job = statusArea(deps);
    jobs.prepend(job.node);
    const who = senders.length === 1 ? senders[0] : plural(senders.length, 'sender');
    const label = `${ACTION_LABELS[kind]} · ${who} · ${plural(ids.length, 'email')}`;
    let onProgress: ((done: number, total: number) => void) | undefined;
    job.working(`${label}…`);
    render();
    try {
      const { entry, skipped } = await executeAction(kind, ids, {
        folderId,
        source: 'Junk review',
        onQueued: (pos) => job.queued(label, pos),
        onProgress: (d, t) => (onProgress ??= job.working(`${label}…`))(d, t),
      });
      let extra = '';
      if (wantRule && senders.length) {
        const ruleKind = kind as RuleActionKind; // delete/move/archive/mark_junk/mark_read are all valid rule actions
        const folderName = folderId ? (await destinationFolders()).find((f) => f.folder.id === folderId)?.label : undefined;
        await addRule({
          name: `${ACTION_LABELS[kind]}: ${senders.length === 1 ? senders[0] : `${senders.length} senders`}`,
          match: { fromAddresses: senders },
          action: { kind: ruleKind, folderId, folderLabel: folderName },
        });
        extra = ' · Rule created for future emails.';
      }
      job.done(entry, skipped, `${extra} (${who})`);
      deps.note(`User applied "${ACTION_LABELS[kind]}" to ${entry.count} emails from ${senders.slice(0, 10).join(', ')}${senders.length > 10 ? '…' : ''}${extra ? ' and created a rule for future mail' : ''}.`);
    } catch (e) {
      // Put them back so the user can retry.
      for (const id of newlyRemoved) removed.delete(id);
      touched.forEach((g, i) => (g.handled = wasHandled[i]));
      job.error(e);
      render();
    }
  }

  const deleteBtn = guardedButton('delete', '🗑 Delete');
  const moveBtn = el('button', null, 'Move');
  moveBtn.addEventListener('click', () => {
    if (!moveSel.value) {
      moveSel.focus();
      return;
    }
    run('move', moveSel.value);
  });
  const archiveBtn = el('button', null, 'Archive');
  archiveBtn.addEventListener('click', () => run('archive'));
  const junkBtn = guardedButton('mark_junk', 'Mark as junk');
  const readBtn = el('button', null, 'Mark read');
  readBtn.addEventListener('click', () => run('mark_read'));
  const actionButtons = [deleteBtn, moveBtn, archiveBtn, junkBtn, readBtn];
  const keepBtn = el('button', { title: 'Remember these senders as wanted mail' }, '👍 Not junk');
  keepBtn.addEventListener('click', () => keep(selectedSenders().map((a) => result.groups.find((g) => g.address === a)!).filter(Boolean)));
  const teachBtn = el('button', { title: 'Teach MailMind these senders are unwanted (no email is moved)' }, '👎 Junk');
  teachBtn.addEventListener('click', () => teachJunk(selectedSenders().map((a) => result.groups.find((g) => g.address === a)!).filter(Boolean)));

  toggleAll.addEventListener('change', () => {
    for (const g of visible()) setSender(g, toggleAll.checked);
    render();
  });
  showAllBtn.addEventListener('click', () => {
    showAll = !showAll;
    render();
  });

  const root = card(
    `Clean-up review · ${range}`,
    headNote,
    el('div', { class: 'row list-head' }, el('label', { class: 'row' }, toggleAll, 'Select all shown'), el('span', { class: 'spacer' }), showAllBtn),
    list,
    el(
      'div',
      { class: 'card-actions' },
      el('div', { class: 'row' }, summary),
      el('div', { class: 'row' }, deleteBtn, moveSel, moveBtn, archiveBtn, junkBtn, readBtn, keepBtn, teachBtn),
      cautionNode,
      el(
        'div',
        { class: 'row small' },
        el('label', { class: 'row' }, allYears, 'Include these senders’ emails from all years'),
        allYearsNote,
      ),
      el('div', { class: 'row small' }, el('label', { class: 'row' }, futureRule, 'Also do this automatically for future emails from these senders')),
      el('div', { class: 'small muted' }, 'Deleted emails go to Trash and can be restored with Undo. You’ll be warned first if any look important (orders, receipts, bills…).'),
    ),
    status.node,
    queueSummary(),
    jobs,
  );
  render();
  return { node: root, refresh: render };
}

// ---------------------------------------------------------------------------
// Generic proposal (from the AI's propose_actions tool)
// ---------------------------------------------------------------------------

export function proposalCard(p: Proposal, deps: CardDeps): HTMLElement {
  const chosen = new Set(p.messages.map((m) => m.id));
  const status = statusArea(deps);
  const title = `Proposed: ${ACTION_LABELS[p.kind]}${p.tag ? ` "${tagLabel(p.tag)}"` : ''}${p.folderLabel ? ` → ${p.folderLabel}` : ''} · ${plural(p.messages.length, 'email')}`;
  const list = el('div', { class: 'msg-list' });
  const SHOW = 100;
  const destructive = p.kind === 'delete' || p.kind === 'mark_junk';
  const whyImportant = (m: Proposal['messages'][number]) => (destructive ? (m.flagged ? 'flagged by you' : importanceOf(m.subject, m.date).kind) : undefined);
  const risky = p.messages.filter((m) => whyImportant(m));
  for (const m of p.messages.slice(0, SHOW)) {
    const why = whyImportant(m);
    const box = el('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    box.addEventListener('change', () => {
      if (box.checked) chosen.add(m.id);
      else chosen.delete(m.id);
      approve.textContent = approveLabel();
    });
    const open = el('a', { href: '#', class: 'small' }, 'open');
    open.addEventListener('click', (e) => {
      e.preventDefault();
      openMessage(m.id);
    });
    list.append(
      el(
        'label',
        { class: 'msg-row' },
        box,
        el('span', { class: 'small muted date' }, formatDate(m.date)),
        el('span', { class: 'small from' }, parseAddress(m.author).name || parseAddress(m.author).address),
        el('span', { class: 'subj' }, m.subject || '(no subject)'),
        why ? el('span', { class: 'small caution', title: `May be important: ${why}` }, `⚠ ${why}`) : null,
        open,
      ),
    );
  }
  const riskyNote = risky.length
    ? el(
        'div',
        { class: 'caution-panel' },
        el('div', { class: 'caution-title' }, `⚠ ${plural(risky.length, 'email')} here may be important`),
        el('div', { class: 'small' }, 'They look like orders, receipts, bills, account mail or ones you flagged. Untick any you want to keep.'),
      )
    : null;
  if (p.messages.length > SHOW) list.append(el('div', { class: 'small muted' }, `…and ${p.messages.length - SHOW} more (included)`));

  const approveLabel = () => `Approve (${chosen.size})`;
  const doRun = async () => {
    approve.disabled = reject.disabled = true;
    const onProgress = status.working(`${ACTION_LABELS[p.kind]}…`);
    try {
      if (p.kind === 'tag' && p.tag) await ensureTags([p.tag], allTags(await getSettings()));
      const { entry, skipped } = await executeAction(p.kind, [...chosen], { folderId: p.folderId, tag: p.tag, onProgress, source: 'Chat proposal' });
      status.done(entry, skipped);
      deps.note(`User approved: ${entry.label}.`);
    } catch (e) {
      status.error(e);
      approve.disabled = reject.disabled = false;
    }
  };
  const approve =
    p.kind === 'delete'
      ? confirmButton(approveLabel(), () => `Confirm: move ${chosen.size} to Trash`, doRun)
      : el('button', { class: 'primary', onclick: doRun }, approveLabel());
  const reject = el('button', null, 'Reject');
  reject.addEventListener('click', () => {
    approve.disabled = reject.disabled = true;
    root.classList.add('rejected');
    deps.note(`User rejected the proposal: ${title}.`);
  });
  const root = card(title, p.reason ? el('div', { class: 'small reason' }, p.reason) : null, riskyNote, list,el('div', { class: 'card-actions row' }, approve, reject), status.node);
  return root;
}

// ---------------------------------------------------------------------------
// Filing suggestions
// ---------------------------------------------------------------------------

export function filingCard(r: FilingResult, deps: CardDeps): HTMLElement {
  const chosen = new Set(r.groups.flatMap((g) => g.items.map((i) => i.messageId)));
  const status = statusArea(deps);
  const sections = r.groups.map((g) => {
    const items = g.items.map((it) => {
      const box = el('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
      box.addEventListener('change', () => (box.checked ? chosen.add(it.messageId) : chosen.delete(it.messageId)));
      return el('label', { class: 'msg-row', title: it.reason }, box, el('span', { class: 'small muted date' }, it.date), el('span', { class: 'small from' }, parseAddress(it.author).name || parseAddress(it.author).address), el('span', { class: 'subj' }, it.subject));
    });
    return el('details', { open: r.groups.length <= 4, class: 'filing-group' }, el('summary', null, el('strong', null, g.folderLabel), el('span', { class: 'muted small' }, ` · ${plural(g.items.length, 'email')}`)), ...items);
  });
  const moveAll = el('button', { class: 'primary' }, 'Move selected');
  moveAll.addEventListener('click', async () => {
    moveAll.disabled = true;
    let total = 0;
    try {
      for (const g of r.groups) {
        const ids = g.items.map((i) => i.messageId).filter((id) => chosen.has(id));
        if (!ids.length) continue;
        const onProgress = status.working(`Moving to ${g.folderLabel}…`);
        const { entry, skipped } = await executeAction('move', ids, { folderId: g.folderId, onProgress, source: 'Filing' });
        total += entry.count;
        status.done(entry, skipped);
      }
      deps.note(`User filed ${total} emails using the suggestions.`);
    } catch (e) {
      status.error(e);
      moveAll.disabled = false;
    }
  });
  if (!r.groups.length) return card(`Filing suggestions · ${r.sourceLabel}`, el('div', { class: 'muted small' }, `Looked at ${r.considered} emails; no confident suggestions.`));
  return card(
    `Filing suggestions · ${r.sourceLabel}`,
    el('div', { class: 'small muted' }, `Looked at ${plural(r.considered, 'email')}. Hover an email to see why.`),
    ...sections,
    el('div', { class: 'card-actions row' }, moveAll),
    status.node,
  );
}

// ---------------------------------------------------------------------------
// Rules, folders, drafts
// ---------------------------------------------------------------------------

export function describeRule(r: RuleDraft): string {
  const m = r.match;
  const conds = [
    m.fromAddresses?.length ? `from ${m.fromAddresses.join(', ')}` : '',
    m.fromContains ? `sender contains "${m.fromContains}"` : '',
    m.subjectContains ? `subject contains "${m.subjectContains}"` : '',
    m.hasListUnsubscribe ? 'is a mailing list' : '',
    m.aiCategory ? `AI says it's ${m.aiCategory}` : '',
  ].filter(Boolean);
  const act = r.action.kind === 'move' ? `move to ${r.action.folderLabel ?? r.action.folderId}` : r.action.kind === 'tag' ? `tag "${r.action.tag}"` : r.action.kind.replace('_', ' ');
  return `When a new email ${conds.join(' and ')} → ${act}`;
}

export function ruleCard(draft: RuleDraft, matchingNow: number[], deps: CardDeps): HTMLElement {
  const status = statusArea(deps);
  const create = el('button', { class: 'primary' }, 'Create rule');
  const createApply = el('button', null, `Create & apply to ${matchingNow.length} existing`);
  const cancel = el('button', null, 'Cancel');
  const disable = () => (create.disabled = createApply.disabled = cancel.disabled = true);
  create.addEventListener('click', async () => {
    disable();
    await addRule(draft);
    status.node.classList.remove('hidden');
    status.node.replaceChildren(el('div', { class: 'notice ok' }, '✓ Rule created. Manage rules in MailMind settings.'));
    deps.note(`User created the rule "${draft.name}".`);
  });
  createApply.addEventListener('click', async () => {
    disable();
    await addRule(draft);
    try {
      const kind = draft.action.kind as ActionKind;
      const onProgress = status.working('Applying to existing emails…');
      const { entry, skipped } = await executeAction(kind, matchingNow, { folderId: draft.action.folderId, tag: draft.action.tag, onProgress, source: `Rule: ${draft.name}` });
      status.done(entry, skipped, ' · Rule created.');
      deps.note(`User created the rule "${draft.name}" and applied it to ${entry.count} existing emails.`);
    } catch (e) {
      status.error(e);
    }
  });
  cancel.addEventListener('click', () => {
    disable();
    deps.note(`User declined the rule "${draft.name}".`);
  });
  const needsExtras = draft.match.hasListUnsubscribe || draft.match.aiCategory;
  return card(
    `Proposed rule · ${draft.name}`,
    el('div', null, describeRule(draft)),
    el('div', { class: 'small muted' }, `${matchingNow.length} existing emails match the sender/subject conditions${needsExtras ? ' (mailing-list / AI checks only run on new mail)' : ''}.`),
    el('div', { class: 'card-actions row' }, create, matchingNow.length && !needsExtras ? createApply : null, cancel),
    status.node,
  );
}

export function folderCard(p: { parentFolderId: string; parentLabel: string; name: string }, deps: CardDeps): HTMLElement {
  const status = el('div');
  const create = el('button', { class: 'primary' }, 'Create folder');
  const cancel = el('button', null, 'Cancel');
  create.addEventListener('click', async () => {
    create.disabled = cancel.disabled = true;
    try {
      await messenger.folders.create(p.parentFolderId, p.name);
      invalidateFolderCache();
      status.replaceChildren(el('div', { class: 'notice ok' }, `✓ Created "${p.name}".`));
      deps.note(`User created the folder "${p.name}" under ${p.parentLabel}.`);
    } catch (e) {
      status.replaceChildren(el('div', { class: 'notice error' }, `Failed: ${(e as Error).message}`));
      create.disabled = cancel.disabled = false;
    }
  });
  cancel.addEventListener('click', () => {
    create.disabled = cancel.disabled = true;
    deps.note(`User declined creating folder "${p.name}".`);
  });
  return card(`Create folder`, el('div', null, `“${p.name}” inside ${p.parentLabel}`), el('div', { class: 'card-actions row' }, create, cancel), status);
}

export function draftCard(d: Draft, deps: CardDeps): HTMLElement {
  const to = el('input', { type: 'text', value: (d.to ?? []).join(', '), placeholder: 'To' }) as HTMLInputElement;
  const subject = el('input', { type: 'text', value: d.subject ?? '', placeholder: 'Subject' }) as HTMLInputElement;
  const body = el('textarea', { rows: Math.min(18, Math.max(6, d.body.split('\n').length + 1)) }) as HTMLTextAreaElement;
  body.value = d.body;
  const status = el('div');
  const open = el('button', { class: 'primary' }, d.kind === 'reply' ? 'Open reply' : 'Open in compose');
  open.addEventListener('click', async () => {
    try {
      if (d.kind === 'reply' && d.replyToMessageId) await openReplyDraft(d.replyToMessageId, body.value, d.replyAll);
      else
        await openNewDraft({
          to: to.value.split(/[,;]/).map((s) => s.trim()).filter(Boolean),
          cc: d.cc,
          subject: subject.value,
          body: body.value,
        });
      deps.note('User opened the draft in a compose window.');
    } catch (e) {
      status.replaceChildren(el('div', { class: 'notice error' }, `Couldn't open compose: ${(e as Error).message}`));
    }
  });
  const copy = el('button', null, 'Copy');
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(body.value);
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy'), 1500);
  });
  return card(
    d.kind === 'reply' ? `Reply draft · ${d.replyToSubject ?? ''}` : 'Email draft',
    d.kind === 'new' ? el('div', { class: 'draft-fields' }, to, subject) : null,
    body,
    el('div', { class: 'card-actions row' }, open, copy, el('span', { class: 'small muted' }, 'Nothing is sent until you press Send in Thunderbird.')),
    status,
  );
}
