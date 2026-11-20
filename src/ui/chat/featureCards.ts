import { el, confirmButton, plural, download } from '../dom';
import { card, statusArea, ruleCard, type CardDeps } from './cards';
import { executeAction } from '../../core/actions';
import { openMessage, getBodyText, getStyleSamples } from '../../core/mail';
import { formatDate, stripQuotedText, stripThinking, truncate } from '../../core/text';
import { getSettings } from '../../core/settings';
import { LlmClient, describeLlmError } from '../../core/llm';
import { NUDGE_SYSTEM, replySystem } from '../../core/prompts';
import { openReplyDraft } from '../composeHelpers';
import { toIcs, describeWhen, type Extracted } from '../../core/events';
import { snoozeFollowup, type FollowupItem, type FollowupResult } from '../../core/followups';
import {
  bestMethod,
  describeMethod,
  isUnsafeToUnsubscribe,
  unsubscribe,
  type Subscription,
  type SubscriptionResult,
} from '../../core/unsubscribe';
import type { Digest, DigestFollowup } from '../../core/digest';
import { approveSuggestion, dismissSuggestion, type CategorySuggestion } from '../../core/smartCategories';
import type { MessageHeader } from '../../core/types';

const openLink = (id: number, label = 'open') => {
  const a = el('a', { href: '#', class: 'small' }, label);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    openMessage(id);
  });
  return a;
};

// ---------------------------------------------------------------------------
// Events & to-dos
// ---------------------------------------------------------------------------

export function eventsCard(found: Extracted, title: string, deps: CardDeps): HTMLElement {
  if (!found.events.length && !found.tasks.length) return card(`Dates & to-dos · ${title}`, el('div', { class: 'small muted' }, 'Nothing found in this email.'));
  const evBoxes = found.events.map(() => el('input', { type: 'checkbox', checked: true }) as HTMLInputElement);
  const taskBoxes = found.tasks.map(() => el('input', { type: 'checkbox', checked: true }) as HTMLInputElement);
  const save = el('button', { class: 'primary' }, 'Save .ics');
  save.addEventListener('click', () => {
    const ev = found.events.filter((_, i) => evBoxes[i].checked);
    const tk = found.tasks.filter((_, i) => taskBoxes[i].checked);
    if (!ev.length && !tk.length) return;
    const name = title.replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'events';
    download(new Blob([toIcs(ev, tk)], { type: 'text/calendar' }), `${name}.ics`);
    deps.note(`User saved ${ev.length} events and ${tk.length} to-dos as an .ics file.`);
  });
  return card(
    `Dates & to-dos · ${title}`,
    found.events.length ? el('div', { class: 'small muted' }, 'Events') : null,
    ...found.events.map((e, i) =>
      el('label', { class: 'msg-row' }, evBoxes[i], el('span', { class: 'subj' }, e.title), el('span', { class: 'small muted' }, describeWhen(e), e.location ? ` · ${e.location}` : '')),
    ),
    found.tasks.length ? el('div', { class: 'small muted' }, 'To-dos') : null,
    ...found.tasks.map((t, i) =>
      el('label', { class: 'msg-row' }, taskBoxes[i], el('span', { class: 'subj' }, t.title), t.due ? el('span', { class: 'small muted' }, `due ${t.due.replace('T', ' ')}`) : null),
    ),
    el(
      'div',
      { class: 'card-actions row' },
      save,
      el('span', { class: 'small muted' }, 'Then in Thunderbird: Calendar → File → Open → Calendar File.'),
    ),
  );
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

async function writeDraft(h: MessageHeader, kind: 'nudge' | 'reply', signal?: AbortSignal): Promise<string> {
  const s = await getSettings();
  const llm = new LlmClient(s);
  const original = truncate(stripQuotedText(await getBodyText(h.id).catch(() => '')), s.maxCharsPerMessage);
  if (kind === 'nudge') {
    const days = Math.floor((Date.now() - new Date(h.date).getTime()) / 86_400_000);
    return stripThinking(
      await llm.complete(NUDGE_SYSTEM, `I sent this ${days} days ago to ${(h.recipients ?? []).join(', ')} and got no reply.\nSubject: ${h.subject}\n<<<EMAIL>>>\n${original}\n<<<END EMAIL>>>`, { signal }),
    ).trim();
  }
  const samples = s.learnStyleFromSent ? await getStyleSamples(3).catch(() => []) : [];
  return stripThinking(
    await llm.complete(replySystem(samples), `Write a sensible, polite reply.\n\nEmail I'm replying to:\nFrom: ${h.author}\nSubject: ${h.subject}\n<<<EMAIL>>>\n${original}\n<<<END EMAIL>>>`, { signal }),
  ).trim();
}

function followupRow(it: FollowupItem, kind: 'nudge' | 'reply', deps: CardDeps): HTMLElement {
  const h = it.header;
  const status = statusArea(deps);
  const info = el('div', { class: 'small muted' });
  const draftBtn = el('button', { class: 'small primary' }, kind === 'nudge' ? 'Draft nudge' : 'Draft reply');
  draftBtn.addEventListener('click', async () => {
    draftBtn.disabled = true;
    draftBtn.textContent = 'Writing…';
    try {
      const text = await writeDraft(h, kind);
      await openReplyDraft(h.id, text, false);
      info.textContent = 'Opened in a compose window. Nothing is sent until you press Send.';
      deps.note(`User opened a ${kind === 'nudge' ? 'follow-up nudge' : 'reply'} draft for "${h.subject}".`);
    } catch (e) {
      const s = await getSettings();
      info.textContent = describeLlmError(e, s.baseUrl);
    } finally {
      draftBtn.disabled = false;
      draftBtn.textContent = kind === 'nudge' ? 'Draft nudge' : 'Draft reply';
    }
  });
  const flagBtn = el('button', { class: 'small' }, h.flagged ? 'Flagged' : 'Flag');
  flagBtn.disabled = !!h.flagged;
  flagBtn.addEventListener('click', async () => {
    flagBtn.disabled = true;
    try {
      const { entry, skipped } = await executeAction('flag', [h.id], { source: 'Follow-ups' });
      status.done(entry, skipped);
    } catch (e) {
      status.error(e);
      flagBtn.disabled = false;
    }
  });
  const row = el('div', { class: 'sender' });
  const hide = (label: string, until: number) => {
    const b = el('button', { class: 'small ghost' }, label);
    b.addEventListener('click', async () => {
      await snoozeFollowup(h.headerMessageId, until);
      row.classList.add('rejected');
      row.replaceChildren(el('div', { class: 'small muted' }, `${label}: ${h.subject || '(no subject)'}`));
    });
    return b;
  };
  row.append(
    el(
      'div',
      { class: 'sender-head' },
      el(
        'div',
        { class: 'sender-name' },
        el('div', null, el('strong', null, h.subject || '(no subject)')),
        el('div', { class: 'small muted' }, `${kind === 'nudge' ? 'to' : 'from'} ${it.counterpart} · ${formatDate(h.date)} · ${plural(it.ageDays, 'day')} ago`),
        it.reason ? el('div', { class: 'small reason' }, it.reason) : null,
      ),
      openLink(h.id),
    ),
    el('div', { class: 'row', style: { marginTop: '4px' } }, draftBtn, flagBtn, hide('Snooze 3 days', Date.now() + 3 * 86_400_000), hide('Dismiss', Infinity)),
    info,
    status.node,
  );
  return row;
}

export function followupsCard(r: FollowupResult, deps: CardDeps): HTMLElement {
  const section = (title: string, items: FollowupItem[], kind: 'nudge' | 'reply', empty: string) =>
    el(
      'div',
      null,
      el('div', { class: 'list-head small' }, el('strong', null, `${title} (${items.length})`)),
      items.length ? el('div', { class: 'sender-list' }, ...items.map((it) => followupRow(it, kind, deps))) : el('div', { class: 'small muted pad' }, empty),
    );
  return card(
    'Follow-ups',
    el('div', { class: 'small muted' }, `Checked ${plural(r.scannedSent, 'sent email')} and ${plural(r.scannedReceived, 'received email')}${r.aiUsed ? ', AI filtered out FYIs and thank-yous' : ''}.`),
    r.aiError ? el('div', { class: 'notice small' }, `AI check failed, showing everything: ${r.aiError}`) : null,
    section('Waiting on them — no reply yet', r.waitingOnThem, 'nudge', 'Everyone has replied.'),
    section('Waiting on you', r.waitingOnMe, 'reply', 'You’re all caught up.'),
  );
}

// ---------------------------------------------------------------------------
// Subscriptions / unsubscribe
// ---------------------------------------------------------------------------

function subscriptionRow(s: Subscription, deps: CardDeps, appendCard: (n: HTMLElement) => void): HTMLElement {
  const status = statusArea(deps);
  const info = el('div', { class: 'small' });
  const method = bestMethod(s.info);
  const spam = isUnsafeToUnsubscribe(s);
  const buttons: HTMLElement[] = [];

  if (spam) {
    const junk = el('button', { class: 'small' }, `Mark ${s.count} as junk`);
    junk.addEventListener('click', async () => {
      junk.disabled = true;
      try {
        const { entry, skipped } = await executeAction('mark_junk', s.messageIds, { source: 'Subscriptions', onProgress: status.working('Marking as junk…') });
        status.done(entry, skipped);
        deps.note(`User marked ${entry.count} emails from ${s.address} as junk.`);
      } catch (e) {
        status.error(e);
        junk.disabled = false;
      }
    });
    buttons.push(junk);
  } else if (method) {
    const label = method === 'one-click' ? 'Unsubscribe' : method === 'web' ? 'Unsubscribe (opens browser)' : 'Unsubscribe (by email)';
    const unsub = el('button', { class: 'small primary' }, label);
    unsub.addEventListener('click', () => {
      unsub.disabled = true;
      // Called synchronously from the click so the permission prompt is allowed.
      unsubscribe(s, method).then(
        (r) => {
          info.className = r.ok ? 'small ok-text' : 'small err-text';
          info.textContent = r.ok ? `✓ ${r.message}` : r.message;
          if (!r.ok) unsub.disabled = false;
          else unsub.textContent = 'Unsubscribed';
          deps.note(r.ok ? `User unsubscribed from ${s.address} (${describeMethod(method)}).` : `Unsubscribing from ${s.address} failed: ${r.message}`);
        },
        (e) => {
          info.className = 'small err-text';
          info.textContent = (e as Error).message;
          unsub.disabled = false;
        },
      );
    });
    if (s.unsubscribedAt && !s.sinceUnsubscribe) unsub.textContent = 'Unsubscribe again';
    buttons.push(unsub);
  }

  buttons.push(
    confirmButton(
      `Move ${s.count} to Trash`,
      () => `Confirm: move ${s.count} to Trash`,
      async () => {
        try {
          const { entry, skipped } = await executeAction('delete', s.messageIds, { source: 'Subscriptions', onProgress: status.working('Moving to Trash…') });
          status.done(entry, skipped);
          deps.note(`User moved ${entry.count} emails from ${s.address} to Trash.`);
        } catch (e) {
          status.error(e);
        }
      },
    ),
  );
  const ruleBtn = el('button', { class: 'small' }, 'Rule for future mail…');
  ruleBtn.addEventListener('click', () => {
    ruleBtn.disabled = true;
    appendCard(ruleCard({ name: `Trash mail from ${s.address}`, match: { fromAddresses: [s.address] }, action: { kind: 'delete' } }, [], deps));
  });
  buttons.push(ruleBtn);

  const stats = `${plural(s.count, 'email')} · ~${s.perMonth}/month · opened ${Math.round(s.openRate * 100)}% · last ${s.lastDate}`;
  return el(
    'div',
    { class: 'sender' },
    el(
      'div',
      { class: 'sender-head' },
      el(
        'div',
        { class: 'sender-name' },
        el('div', null, el('strong', null, s.name || s.address), s.name ? el('span', { class: 'small muted' }, ` <${s.address}>`) : null),
        el('div', { class: 'small muted' }, stats),
        spam ? el('div', { class: 'small reason' }, 'Looks like spam: unsubscribing would confirm your address is real. Mark it as junk instead.') : null,
        s.sinceUnsubscribe ? el('div', { class: 'small err-text' }, `Still sent ${plural(s.sinceUnsubscribe, 'email')} after you unsubscribed. A rule may help.`) : null,
      ),
      el('span', { class: `badge ${spam ? 'junk' : 'newsletter'}` }, spam ? 'spam?' : describeMethod(method)),
    ),
    el('div', { class: 'row', style: { marginTop: '4px' } }, ...buttons),
    info,
    status.node,
  );
}

export function subscriptionsCard(r: SubscriptionResult, deps: CardDeps, appendCard: (n: HTMLElement) => void): HTMLElement {
  const SHOW = 40;
  return card(
    `Subscriptions · ${plural(r.subscriptions.length, 'mailing list')}`,
    el(
      'div',
      { class: 'small muted' },
      `From ${plural(r.scanned, 'email')}. Most unread mail first. Unsubscribing contacts that sender (only when you click). Moving to Trash can be undone.`,
    ),
    r.subscriptions.length
      ? el('div', { class: 'sender-list' }, ...r.subscriptions.slice(0, SHOW).map((s) => subscriptionRow(s, deps, appendCard)))
      : el('div', { class: 'small muted pad' }, 'No newsletters or mailing lists found.'),
    r.subscriptions.length > SHOW ? el('div', { class: 'small muted' }, `…and ${r.subscriptions.length - SHOW} more with less mail.`) : null,
  );
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

export function digestCard(d: Digest, deps: CardDeps): HTMLElement {
  const fu = (title: string, list: DigestFollowup[]) =>
    list.length
      ? el(
          'div',
          null,
          el('div', { class: 'list-head small' }, el('strong', null, title)),
          ...list.map((f) => el('div', { class: 'msg-row' }, el('span', { class: 'small from' }, f.person), el('span', { class: 'subj' }, f.subject || '(no subject)'), el('span', { class: 'small muted' }, `${f.ageDays}d`), openLink(f.id))),
        )
      : null;
  const more = el('button', { class: 'small' }, 'Open follow-ups');
  more.addEventListener('click', () => {
    more.disabled = true;
    deps.note('User asked to see all follow-ups.');
    messenger.storage.local.set({ pendingContext: { prompt: 'What am I waiting on, and what haven’t I answered?', autoSend: true, time: Date.now() } });
  });
  return card(
    `Briefing · ${new Date(d.createdAt).toLocaleString(undefined, { weekday: 'long', hour: '2-digit', minute: '2-digit' })}`,
    el(
      'div',
      { class: 'row' },
      el('span', { class: 'badge' }, `${d.unread} unread`),
      ...d.byTag.map((t) => el('span', { class: 'badge' }, `${t.label} ${t.count}`)),
    ),
    d.aiError ? el('div', { class: 'notice small' }, `Some AI steps failed: ${d.aiError}`) : null,
    d.important.length
      ? el(
          'div',
          null,
          el('div', { class: 'list-head small' }, el('strong', null, 'Important')),
          ...d.important.map((i) =>
            el(
              'div',
              { class: 'sender' },
              el('div', { class: 'sender-head' }, el('div', { class: 'sender-name' }, el('strong', null, i.subject), el('div', { class: 'small muted' }, `${i.from} · ${i.why}`), i.summary ? el('div', { class: 'small' }, i.summary) : null), openLink(i.id)),
            ),
          ),
        )
      : el('div', { class: 'small muted' }, 'No important unread mail.'),
    fu('Waiting on replies', d.waitingOnThem),
    fu('Waiting on you', d.waitingOnMe),
    d.waitingOnThem.length || d.waitingOnMe.length ? el('div', { class: 'card-actions row' }, more) : null,
  );
}

// ---------------------------------------------------------------------------
// Smart-category suggestions
// ---------------------------------------------------------------------------

/** One AI category idea: the user can rename it, untick senders, then Create or dismiss it. */
export function categorySuggestionCard(s: CategorySuggestion, deps: CardDeps): HTMLElement {
  const name = el('input', { type: 'text', value: s.name, maxlength: '40', style: { width: 'auto', minWidth: '12em' } }) as HTMLInputElement;
  const boxes = s.senders.map((x) => {
    const box = el('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    return {
      x,
      box,
      row: el(
        'label',
        { class: 'row small' },
        box,
        el('span', null, x.name ? `${x.name} <${x.address}>` : x.address),
        x.sample ? el('span', { class: 'muted' }, ` · “${x.sample}”`) : null,
      ),
    };
  });
  const status = el('div', { class: 'small' });
  const create = el('button', { class: 'primary small' }, 'Create category');
  const dismiss = el('button', { class: 'small ghost', title: 'Don’t suggest this again' }, 'Not useful');
  const buttons = el('div', { class: 'row' }, create, dismiss);
  const done = (text: string) => {
    buttons.remove();
    name.disabled = true;
    for (const b of boxes) b.box.disabled = true;
    status.textContent = text;
  };
  create.addEventListener('click', async () => {
    const addresses = boxes.filter((b) => b.box.checked).map((b) => b.x.address);
    if (!addresses.length) {
      status.textContent = 'Tick at least one sender.';
      return;
    }
    create.disabled = dismiss.disabled = true;
    try {
      const cat = await approveSuggestion(s.id, { name: name.value, addresses });
      if (!cat) return done('This suggestion was already handled.');
      done(`✓ Created “${cat.name}” with ${plural(addresses.length, 'sender')}. New mail from them is sorted in automatically.`);
      deps.note(`User created the smart category "${cat.name}" with ${addresses.length} senders.`);
    } catch (e) {
      create.disabled = dismiss.disabled = false;
      status.textContent = e instanceof Error ? e.message : String(e);
    }
  });
  dismiss.addEventListener('click', async () => {
    await dismissSuggestion(s.id);
    done('Dismissed. MailMind won’t suggest this again.');
    deps.note(`User dismissed the smart category idea "${s.name}".`);
  });
  return card(
    `Category idea · ${s.name}`,
    el('div', { class: 'small muted' }, `${s.description}. The AI noticed ${plural(s.senders.length, 'sender')} about this. Untick any that don’t belong. Nothing about your emails changes.`),
    el('div', { class: 'row small' }, el('span', null, 'Name:'), name),
    el('div', { class: 'sender-list' }, ...boxes.map((b) => b.row)),
    buttons,
    status,
  );
}
