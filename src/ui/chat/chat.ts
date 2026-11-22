import '../../core/aiActivity'; // lets the background junk scan pause while this page uses the AI
import { el, $, progressBar } from '../dom';
import { getSettings, saveSettings, effectiveToolMode, isLocalUrl, originPattern, type Settings } from '../../core/settings';
import { LlmClient, describeLlmError, type ChatMessage } from '../../core/llm';
import { runAgent } from '../../core/agent';
import { createTools, type ToolUi } from '../../core/tools';
import { chatSystemPrompt, CARD_CLAIM_GUARD } from '../../core/prompts';
import { getAccountNames, getMyAddresses, getHeaders, headerLine } from '../../core/mail';
import { renderMarkdown, stripThinking } from '../../core/text';
import { senderReviewCard, proposalCard, filingCard, ruleCard, folderCard, draftCard, type CardDeps } from './cards';
import { topicCard, attachmentsCard } from './topicCards';
import { eventsCard, followupsCard, subscriptionsCard, digestCard, categorySuggestionCard } from './featureCards';
import { getSuggestions, type CategorySuggestion } from '../../core/smartCategories';
import type { Digest } from '../../core/digest';
import { settleBlock, mergeBlock } from '../../core/turns';
import {
  newConversation, loadConversation, saveConversation, listConversations, deleteConversation,
  getCurrentId, setCurrentId, visibleMessages, visibleUserText, type Conversation,
} from '../../core/conversations';

const log = $('#log');
const input = $('#input') as HTMLTextAreaElement;
const sendBtn = $('#btn-send') as HTMLButtonElement;
const banner = $('#banner');
const empty = $('#empty');
const attachedBox = $('#attached');
const app = $('#app');
const actionList = $('#action-list');
const actionsCount = $('#actions-count');

const historyPanel = $('#history');
const historyList = $('#history-list');
const historyFilter = $('#history-filter') as HTMLInputElement;

let settings: Settings;
/** The conversation on screen. Requests keep a reference to theirs, so they save to the right one even after switching. */
let current: Conversation = newConversation();
/** Requests that are running right now. You can send a new one while others are still working. */
interface Task {
  id: number;
  text: string;
  controller: AbortController;
}
const tasks = new Map<number, Task>();
let taskCounter = 0;
/** More than this would just queue up on a single local GPU, so a further send waits until one finishes. */
const MAX_PARALLEL = 3;
let pendingNotes: string[] = [];
let attachedIds: number[] = [];

const TOOL_LABELS: Record<string, string> = {
  list_folders: 'Looking at your folders',
  search_messages: 'Searching emails',
  get_message: 'Reading an email',
  group_by_sender: 'Counting emails by sender',
  find_junk_candidates: 'Reviewing senders for junk',
  propose_actions: 'Preparing a proposal',
  suggest_filing: 'Working out where emails belong',
  create_folder: 'Preparing a new folder',
  propose_rule: 'Preparing a filter rule',
  list_rules: 'Checking your rules',
  draft_email: 'Writing a draft',
  draft_reply: 'Writing a reply',
  summarize_messages: 'Reading emails',
  semantic_search: 'Searching by meaning',
  find_emails_about: 'Finding emails about that topic',
  list_attachments: 'Listing attachments',
  summarize_thread: 'Reading the whole conversation',
  extract_events: 'Looking for dates and to-dos',
  find_followups: 'Checking what needs a follow-up',
  find_subscriptions: 'Finding newsletters and mailing lists',
  suggest_tags: 'Tagging emails',
  daily_digest: 'Building your briefing',
};

const SUGGESTIONS = [
  'Find junk in my 2021 emails and help me delete it',
  'Summarise my unread emails from this week',
  'Find all emails about my stock trading and list the attachments',
  'What am I waiting on, and what haven’t I answered?',
  'Which newsletters should I unsubscribe from?',
  'Give me my daily briefing',
  'Who sends me the most email?',
  'Help me file the emails in my inbox',
  'Create a rule to move newsletters to a "Reading" folder',
  'Draft an email to my landlord asking about the repair',
];

const cardDeps: CardDeps = {
  note(text) {
    pendingNotes.push(text);
    appendToLog(el('div', { class: 'msg note' }, text));
  },
};

/** True when the chat log is scrolled to (or very near) the bottom. */
function nearBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}

/** Scroll the chat to the bottom. Without `force`, only if the user hasn't scrolled up to read. */
function scrollDown(force = false) {
  const stick = force || nearBottom();
  requestAnimationFrame(() => {
    if (stick) log.scrollTop = log.scrollHeight;
  });
}

/** Append to the chat log (or one request's section of it), following along only if the user was already at the bottom. */
function appendToLog(node: HTMLElement, force = false, parent: HTMLElement = log) {
  const stick = force || nearBottom();
  parent.append(node);
  if (stick) requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
}

function updateActionsCount() {
  const n = actionList.children.length;
  app.classList.toggle('has-actions', n > 0);
  actionsCount.textContent = n ? `${n} card${n === 1 ? '' : 's'}` : '';
}

function flashCard(card: HTMLElement) {
  card.scrollIntoView({ block: 'start', behavior: 'smooth' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1200);
}

/**
 * Show a review card in the Actions pane (newest at the top) and leave a clickable
 * pointer to it in the chat. The card stays put while you work in it.
 */
function showCard(card: HTMLElement, parent: HTMLElement = log) {
  hideEmpty();
  actionList.prepend(card);
  updateActionsCount();
  actionList.scrollTop = 0;
  const title = card.querySelector('.card-title')?.textContent?.trim() || 'Review card';
  const link = el('div', { class: 'msg note card-link', title: 'Show this card' }, `📋 ${title} — opened in Actions`);
  link.addEventListener('click', () => {
    if (card.isConnected) flashCard(card);
    else link.textContent = `📋 ${title} — closed`;
  });
  appendToLog(link, false, parent);
}

function clearActions() {
  actionList.replaceChildren();
  updateActionsCount();
}

const DEFAULT_PLACEHOLDER = input.placeholder;

/** The Send button stays a Send button; each running request has its own Stop. */
function updateComposer() {
  const full = tasks.size >= MAX_PARALLEL;
  sendBtn.disabled = full;
  sendBtn.title = full ? `${MAX_PARALLEL} requests are already running. Wait for one to finish, or stop one.` : '';
  input.placeholder = tasks.size ? 'Ask something else while I work… (Esc stops the newest request)' : DEFAULT_PLACEHOLDER;
}

function hideEmpty() {
  empty.classList.add('hidden');
}

function addUserBubble(text: string) {
  hideEmpty();
  appendToLog(el('div', { class: 'msg user' }, text), true);
}

function addAssistantBubble(text = '', parent: HTMLElement = log): { node: HTMLElement; set(t: string): void } {
  hideEmpty();
  const node = el('div', { class: 'msg assistant md' });
  let pending = false;
  let latest = text;
  const paint = () => {
    pending = false;
    node.innerHTML = renderMarkdown(stripThinking(latest));
  };
  appendToLog(node, false, parent);
  if (text) paint();
  return {
    node,
    set(t: string) {
      latest = t;
      if (!pending) {
        pending = true;
        const stick = nearBottom();
        requestAnimationFrame(() => {
          paint();
          if (stick) log.scrollTop = log.scrollHeight;
        });
      }
    },
  };
}

function addError(text: string, withSettings = true, parent: HTMLElement = log) {
  const n = el('div', { class: 'msg error notice error' }, text);
  if (withSettings) {
    const b = el('button', { class: 'small', style: { marginLeft: '8px' } }, 'Open settings');
    b.addEventListener('click', () => messenger.runtime.openOptionsPage());
    n.append(b);
  }
  appendToLog(n, false, parent);
}

function renderAttached() {
  attachedBox.replaceChildren();
  if (!attachedIds.length) return attachedBox.classList.add('hidden');
  attachedBox.classList.remove('hidden');
  const clear = el('button', { class: 'small ghost', title: 'Remove' }, '✕');
  clear.addEventListener('click', () => {
    attachedIds = [];
    renderAttached();
  });
  attachedBox.append(el('span', { class: 'badge' }, `📎 ${attachedIds.length} selected email${attachedIds.length === 1 ? '' : 's'} attached`), clear);
}

async function checkConnection() {
  banner.classList.add('hidden');
  banner.replaceChildren();
  $('#model').textContent = settings.model || 'no model';
  const pattern = originPattern(settings.baseUrl);
  if (!isLocalUrl(settings.baseUrl)) {
    showBanner(`⚠ The AI endpoint ${settings.baseUrl} is not on this computer or your local network — your emails would be sent there.`, 'error');
  }
  if (pattern && !/^https?:\/\/(localhost|127\.0\.0\.1)\//.test(pattern)) {
    const has = await messenger.permissions.contains({ origins: [pattern] }).catch(() => true);
    if (!has) {
      const b = el('button', { class: 'small primary' }, 'Allow access');
      b.addEventListener('click', async () => {
        const ok = await messenger.permissions.request({ origins: [pattern] }).catch(() => false);
        if (ok) checkConnection();
      });
      showBanner(`MailMind needs permission to talk to ${new URL(settings.baseUrl).host}.`, 'warn', b);
      return;
    }
  }
  try {
    const models = await new LlmClient(settings).listModels();
    if (settings.model && models.length && !models.includes(settings.model)) {
      showBanner(`Model "${settings.model}" wasn't found on the server. Available: ${models.slice(0, 8).join(', ')}`, 'warn', settingsButton());
    }
  } catch (e) {
    showBanner(describeLlmError(e, settings.baseUrl), 'error', settingsButton());
  }
}

function settingsButton() {
  const b = el('button', { class: 'small' }, 'Settings');
  b.addEventListener('click', () => messenger.runtime.openOptionsPage());
  return b;
}

function showBanner(text: string, kind: 'warn' | 'error', ...extra: HTMLElement[]) {
  banner.classList.remove('hidden');
  banner.append(el('div', { class: `notice ${kind === 'error' ? 'error' : ''}` }, el('span', null, text), ...extra));
}

async function buildUserContent(text: string): Promise<string> {
  const parts: string[] = [];
  if (tasks.size) {
    const others = [...tasks.values()].map((t) => `"${t.text.slice(0, 120)}"`).join(', ');
    parts.push(`[Still being worked on in parallel: ${others}. Don't redo that work; focus on this new request.]`);
  }
  if (pendingNotes.length) {
    parts.push(`[Since my last message: ${pendingNotes.join(' ')}]`);
    pendingNotes = [];
  }
  if (attachedIds.length) {
    const headers = await getHeaders(attachedIds.slice(0, 50));
    parts.push(`[I have selected these emails in Thunderbird:\n${headers.map(headerLine).join('\n')}${attachedIds.length > 50 ? `\n…and ${attachedIds.length - 50} more` : ''}]`);
    attachedIds = [];
    renderAttached();
  }
  parts.push(text);
  return parts.join('\n\n');
}

async function send(text: string) {
  text = text.trim();
  if (!text || tasks.size >= MAX_PARALLEL) return;
  input.value = '';
  settings = await getSettings();
  addUserBubble(text);
  const userMsg: ChatMessage = { role: 'user', content: await buildUserContent(text) };

  const task: Task = { id: ++taskCounter, text, controller: new AbortController() };
  tasks.set(task.id, task);
  updateComposer();

  // Everything this request shows goes in its own section under the question, even while other requests write below it.
  const turn = el('div', { class: 'turn' });
  appendToLog(turn, true);
  const stopBtn = el('button', { class: 'small ghost', title: 'Stop this request' }, 'Stop');
  stopBtn.addEventListener('click', () => task.controller.abort());
  const statusText = el('span', null, 'Working');
  const turnHead = el('div', { class: 'turn-head' }, el('span', { class: 'spinner' }), statusText, stopBtn);
  turn.append(turnHead);
  const toLog = (node: HTMLElement) => appendToLog(node, false, turn);

  // Runs on its own copy of the conversation; merged back as one block when it ends (see core/turns.ts).
  const conv = current;
  const baseLen = conv.messages.length;
  const own: ChatMessage[] = [...conv.messages, userMsg];
  const llm = new LlmClient(settings);

  let bubble: ReturnType<typeof addAssistantBubble> | null = null;
  let streamed = '';
  let toolLine: { node: HTMLElement; bar: ReturnType<typeof progressBar>; label: HTMLElement } | null = null;
  const typing = el('div', { class: 'typing' }, 'Thinking');
  const appendCard = (card: HTMLElement) => showCard(card, turn);

  const ui: ToolUi = {
    progress(label, fraction) {
      if (!toolLine) return;
      toolLine.label.textContent = label;
      toolLine.bar.set(fraction);
      scrollDown();
    },
    showSenderReview: (r) => {
      const view = senderReviewCard(r, cardDeps);
      appendCard(view.node);
      return view;
    },
    showProposal: (p) => appendCard(proposalCard(p, cardDeps)),
    showFiling: (r) => appendCard(filingCard(r, cardDeps)),
    showRuleProposal: (r, ids) => appendCard(ruleCard(r, ids, cardDeps)),
    showFolderProposal: (p) => appendCard(folderCard(p, cardDeps)),
    showDraft: (d) => appendCard(draftCard(d, cardDeps)),
    showTopicResults: (r, rs) => appendCard(topicCard(r, rs, cardDeps, appendCard)),
    showAttachments: (rows, title) => appendCard(attachmentsCard(rows, title, cardDeps)),
    showEvents: (found, title) => appendCard(eventsCard(found, title, cardDeps)),
    showFollowups: (r) => appendCard(followupsCard(r, cardDeps)),
    showSubscriptions: (r) => appendCard(subscriptionsCard(r, cardDeps, appendCard)),
    showDigest: (d) => appendCard(digestCard(d, cardDeps)),
    showCategorySuggestions: (list) => {
      for (const s of list) if (!shownSuggestions.has(s.id)) {
        shownSuggestions.add(s.id);
        appendCard(categorySuggestionCard(s, cardDeps));
      }
    },
  };

  let endNote = '(Stopped.)';
  try {
    const [names, mine] = await Promise.all([getAccountNames(), getMyAddresses()]);
    const system = chatSystemPrompt({
      today: new Date(),
      accountNames: [...names.values()],
      myAddresses: mine,
      semanticSearch: !!settings.embeddingModel,
    });
    toLog(typing);
    const result = await runAgent({
      llm,
      system,
      history: own,
      tools: createTools({ llm, settings, ui }),
      mode: effectiveToolMode(settings),
      maxSteps: settings.maxToolSteps,
      historyCharBudget: settings.historyCharBudget,
      signal: task.controller.signal,
      claimGuard: CARD_CLAIM_GUARD,
      events: {
        onRetract() {
          bubble?.node.remove();
          bubble = null;
          streamed = '';
          statusText.textContent = 'Preparing a proposal';
          toLog(typing);
        },
        onAssistantStart() {
          streamed = '';
          bubble = null;
          statusText.textContent = 'Thinking';
          toLog(typing);
        },
        onDelta(t) {
          typing.remove();
          if (!bubble) bubble = addAssistantBubble('', turn);
          streamed += t;
          bubble.set(streamed);
        },
        onAssistantEnd() {
          typing.remove();
        },
        onToolStart(name) {
          typing.remove();
          statusText.textContent = TOOL_LABELS[name] ?? name;
          const label = el('span', null, `🔧 ${TOOL_LABELS[name] ?? name}…`);
          const bar = progressBar();
          const node = el('div', { class: 'tool-line' }, label, bar.node);
          toolLine = { node, bar, label };
          toLog(node);
        },
        onToolEnd(name, _result, isError) {
          if (toolLine) {
            toolLine.node.classList.add(isError ? 'error' : 'done');
            toolLine.label.textContent = `${isError ? '⚠' : '✓'} ${TOOL_LABELS[name] ?? name}${isError ? ' — ' + _result.replace(/^ERROR:\s*/, '').slice(0, 160) : ''}`;
          }
          toolLine = null;
        },
        onModeSwitch(mode) {
          if (settings.toolMode === 'auto') saveSettings({ detectedToolMode: mode });
          toLog(el('div', { class: 'msg note' }, 'This model doesn’t support native tool calling — switched to compatibility mode.'));
        },
      },
    });
    if (result.mode !== effectiveToolMode(settings) && settings.toolMode === 'auto') await saveSettings({ detectedToolMode: result.mode });
  } catch (e) {
    typing.remove();
    if (e instanceof DOMException && e.name === 'AbortError') {
      toLog(el('div', { class: 'msg note' }, 'Stopped.'));
    } else {
      endNote = '(That request failed.)';
      addError(describeLlmError(e, settings.baseUrl), true, turn);
    }
  } finally {
    typing.remove();
    turnHead.remove();
    tasks.delete(task.id);
    updateComposer();
    // Merged into the conversation it was asked in, even if another one is on screen now.
    mergeBlock(conv.messages, settleBlock(own.slice(baseLen), endNote));
    await saveConversation(conv);
    if (conv === current) await setCurrentId(conv.id);
    if (!historyPanel.classList.contains('hidden')) renderHistoryList();
    if (!tasks.size) input.focus();
  }
}

/** Shows a saved conversation's questions and answers in the log. */
function renderConversation(conv: Conversation) {
  log.replaceChildren(empty);
  const visible = visibleMessages(conv.messages);
  if (!visible.length) {
    empty.classList.remove('hidden');
    return;
  }
  hideEmpty();
  log.append(el('div', { class: 'msg note' }, 'Earlier conversation (review cards aren’t kept after closing)'));
  for (const m of visible.slice(-30)) {
    if (m.role === 'user') addUserBubble(visibleUserText(m.content));
    else addAssistantBubble(m.content ?? '');
  }
  scrollDown(true);
}

/**
 * Leaves the conversation on screen (it stays saved) and shows another one, or a fresh one.
 * Running requests are stopped; what they got done is still saved to their own conversation.
 */
async function switchTo(conv: Conversation) {
  for (const t of tasks.values()) t.controller.abort();
  current = conv;
  pendingNotes = [];
  attachedIds = [];
  renderAttached();
  clearActions();
  await setCurrentId(conv.messages.length ? conv.id : null);
  renderConversation(conv);
  input.focus();
}

async function newChat() {
  closeHistory();
  if (!current.messages.length && !tasks.size) return input.focus();
  await switchTo(newConversation());
}

// ---------- conversation history ----------
function relativeTime(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days <= 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

async function renderHistoryList() {
  const q = historyFilter.value.trim().toLowerCase();
  const all = await listConversations();
  const list = q ? all.filter((c) => c.title.toLowerCase().includes(q)) : all;
  historyList.replaceChildren();
  if (!list.length) {
    historyList.append(el('div', { class: 'small muted history-empty' }, all.length ? 'No conversations match.' : 'No saved conversations yet.'));
    return;
  }
  for (const c of list) {
    const del = el('button', { class: 'ghost small history-del', title: 'Delete this conversation' }, '✕');
    let armed = false;
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        del.textContent = 'Delete?';
        del.classList.add('danger');
        setTimeout(() => {
          armed = false;
          del.textContent = '✕';
          del.classList.remove('danger');
        }, 4000);
        return;
      }
      await deleteConversation(c.id);
      if (c.id === current.id) await switchTo(newConversation());
      renderHistoryList();
    });
    const item = el(
      'div',
      { class: `history-item${c.id === current.id ? ' current' : ''}`, tabindex: '0', role: 'button', title: c.title },
      el('div', { class: 'history-main' }, el('div', { class: 'history-title' }, c.title), el('div', { class: 'small muted' }, `${relativeTime(c.updated)} · ${c.count} message${c.count === 1 ? '' : 's'}`)),
      del,
    );
    const open = async () => {
      closeHistory();
      if (c.id === current.id) return;
      const conv = await loadConversation(c.id);
      if (conv) await switchTo(conv);
    };
    item.addEventListener('click', open);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    historyList.append(item);
  }
}

function openHistory() {
  historyPanel.classList.remove('hidden');
  $('#btn-history').classList.add('active');
  historyFilter.value = '';
  renderHistoryList();
  historyFilter.focus();
}

function closeHistory() {
  historyPanel.classList.add('hidden');
  $('#btn-history').classList.remove('active');
}

/** Smart-category ideas already shown in this page, so each appears once. */
const shownSuggestions = new Set<string>();

/** Shows category ideas the background scan found (they wait in storage until the user decides). */
async function showPendingSuggestions(list?: CategorySuggestion[]) {
  for (const s of list ?? (await getSuggestions().catch(() => []))) {
    if (shownSuggestions.has(s.id)) continue;
    shownSuggestions.add(s.id);
    showCard(categorySuggestionCard(s, cardDeps));
  }
}

async function consumePendingContext() {
  const s = await messenger.storage.local.get('pendingContext');
  const ctx = s?.pendingContext;
  if (!ctx || Date.now() - (ctx.time ?? 0) > 5 * 60_000) return;
  await messenger.storage.local.remove('pendingContext');
  if (ctx.showDigest) {
    const d = (await messenger.storage.local.get('lastDigest'))?.lastDigest as Digest | undefined;
    if (d) showCard(digestCard(d, cardDeps));
    return;
  }
  if (Array.isArray(ctx.messageIds) && ctx.messageIds.length) {
    attachedIds = ctx.messageIds;
    renderAttached();
  }
  if (ctx.prompt && ctx.autoSend) send(ctx.prompt);
  else {
    if (ctx.prompt) input.value = ctx.prompt;
    input.focus();
  }
}

// ---------- wiring ----------
for (const sgg of SUGGESTIONS) {
  const b = el('button', null, sgg);
  b.addEventListener('click', () => send(sgg));
  $('#suggestions').append(b);
}

sendBtn.addEventListener('click', () => send(input.value));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(input.value);
  } else if (e.key === 'Escape' && tasks.size) {
    e.preventDefault();
    [...tasks.values()].pop()!.controller.abort();
  }
});
$('#btn-new').addEventListener('click', newChat);
$('#btn-history').addEventListener('click', () => (historyPanel.classList.contains('hidden') ? openHistory() : closeHistory()));
historyFilter.addEventListener('input', () => renderHistoryList());
historyPanel.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeHistory();
    input.focus();
  }
});
document.addEventListener('click', (e) => {
  const t = e.target as Node;
  if (!historyPanel.classList.contains('hidden') && !historyPanel.contains(t) && !$('#btn-history').contains(t)) closeHistory();
});
$('#btn-clear-actions').addEventListener('click', clearActions);
$('#btn-settings').addEventListener('click', () => messenger.runtime.openOptionsPage());
$('#btn-popout').addEventListener('click', async () => {
  await messenger.windows.create({ type: 'popup', url: messenger.runtime.getURL('ui/chat/chat.html'), width: 520, height: 820 });
});
if (new URLSearchParams(location.search).has('popout')) $('#btn-popout').classList.add('hidden');

messenger.storage.onChanged.addListener((changes: any, area: string) => {
  if (area !== 'local') return;
  if (changes.pendingContext?.newValue) consumePendingContext();
  if (changes.smartSuggestions?.newValue) showPendingSuggestions(changes.smartSuggestions.newValue);
  if (changes.settings) getSettings().then((s) => {
    const changed = s.baseUrl !== settings.baseUrl || s.model !== settings.model;
    settings = s;
    if (changed) checkConnection();
  });
});

(async () => {
  settings = await getSettings();
  await listConversations(); // moves a conversation saved by an older version into the list
  const id = await getCurrentId();
  const saved = id ? await loadConversation(id) : null;
  if (saved) {
    current = saved;
    renderConversation(saved);
  }
  checkConnection();
  consumePendingContext();
  showPendingSuggestions();
  input.focus();
})();
