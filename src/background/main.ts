import '../core/aiActivity'; // report this script's AI use so the background junk scan gives way
import { getSettings, type Settings } from '../core/settings';
import { LlmClient } from '../core/llm';
import { applyRules } from '../core/rules';
import { getMyAddresses, getSentRecipients, hasUse, NON_MAIL_FOLDERS } from '../core/mail';
import { parseAddress } from '../core/text';
import { forgetSenders, scoreNewMail } from '../core/junkScores';
import { runBackfillStep, runDiscoveryStep } from '../core/backfill';
import { groupBySender, scoreGroups } from '../core/triage';
import { placeSenders } from '../core/smartCategories';
import { getAiActivity, isAiBusy, onAiActivity } from '../core/aiActivity';
import { splitComposeBody, htmlToText } from '../core/text';
import { activeTags, allTags, autoTagNew, recentForTagIdeas, suggestNewTags } from '../core/autotag';
import { buildDigest, digestNotificationText, nextOccurrence, shouldCatchUp, DIGEST_KEY, DIGEST_AT_KEY } from '../core/digest';

const CHAT_URL = 'ui/chat/chat.html';
const SPACE_NAME = 'mailmind';
let spaceId: number | undefined;

// ---------- Spaces toolbar entry (left-hand bar) ----------
async function ensureSpace(): Promise<void> {
  try {
    const existing = await messenger.spaces.query({ name: SPACE_NAME });
    if (existing?.length) {
      spaceId = existing[0].id;
      return;
    }
    const space = await messenger.spaces.create(SPACE_NAME, CHAT_URL, {
      title: 'MailMind',
      defaultIcons: 'icons/icon.svg',
    });
    spaceId = space?.id;
  } catch (e) {
    console.warn('MailMind: could not create space', e);
  }
}

async function openChat(): Promise<void> {
  if (spaceId === undefined) await ensureSpace();
  try {
    if (spaceId !== undefined) {
      await messenger.spaces.open(spaceId);
      return;
    }
  } catch {
    /* fall through */
  }
  const url = messenger.runtime.getURL(CHAT_URL);
  const tabs = await messenger.tabs.query({});
  const open = tabs.find((t: any) => t.url === url);
  if (open) await messenger.tabs.update(open.id, { active: true });
  else await messenger.tabs.create({ url });
}

ensureSpace();
messenger.action.onClicked.addListener(() => openChat());

// ---------- Context menus ----------
const MENU = {
  ask: 'mailmind-ask',
  junkSender: 'mailmind-junk-sender',
  cleanFolder: 'mailmind-clean-folder',
  fileFolder: 'mailmind-file-folder',
  followups: 'mailmind-followups',
  unsubscribe: 'mailmind-unsubscribe',
};

async function setupMenus(): Promise<void> {
  await messenger.menus.removeAll();
  messenger.menus.create({ id: MENU.ask, title: 'Ask MailMind about selected emails…', contexts: ['message_list'] });
  messenger.menus.create({ id: MENU.junkSender, title: 'MailMind: find all mail from this sender', contexts: ['message_list'] });
  messenger.menus.create({ id: MENU.unsubscribe, title: 'MailMind: unsubscribe from this sender…', contexts: ['message_list'] });
  messenger.menus.create({ id: MENU.followups, title: 'MailMind: what am I waiting on?', contexts: ['message_list', 'folder_pane'] });
  messenger.menus.create({ id: MENU.cleanFolder, title: 'MailMind: find junk in this folder', contexts: ['folder_pane'] });
  messenger.menus.create({ id: MENU.fileFolder, title: 'MailMind: suggest folders for these emails', contexts: ['folder_pane'] });
}
setupMenus().catch((e) => console.warn('MailMind menus', e));

async function selectedIds(info: any): Promise<number[]> {
  const ids: number[] = [];
  let list = info.selectedMessages;
  while (list) {
    for (const m of list.messages ?? []) ids.push(m.id);
    if (!list.id || ids.length >= 500) break;
    list = await messenger.messages.continueList(list.id);
  }
  return ids;
}

messenger.menus.onClicked.addListener(async (info: any) => {
  let context: Record<string, unknown> | null = null;
  if (info.menuItemId === MENU.ask) {
    context = { messageIds: await selectedIds(info), prompt: '' };
  } else if (info.menuItemId === MENU.junkSender) {
    const ids = await selectedIds(info);
    const first = ids.length ? await messenger.messages.get(ids[0]) : null;
    if (first) context = { prompt: `Find all emails from the sender of "${first.subject}" (${first.author}) and help me decide what to do with them.`, autoSend: true };
  } else if (info.menuItemId === MENU.unsubscribe) {
    const ids = await selectedIds(info);
    const first = ids.length ? await messenger.messages.get(ids[0]) : null;
    if (first) context = { prompt: `Help me unsubscribe from ${first.author} — find their mailing list emails and show the subscriptions card.`, autoSend: true };
  } else if (info.menuItemId === MENU.followups) {
    context = { prompt: 'What am I waiting on, and what haven’t I answered?', autoSend: true };
  } else if (info.menuItemId === MENU.cleanFolder || info.menuItemId === MENU.fileFolder) {
    const folder = info.selectedFolders?.[0] ?? info.selectedFolder;
    if (folder) {
      const fid = folder.id ?? `${folder.accountId}:/${folder.path}`;
      context =
        info.menuItemId === MENU.cleanFolder
          ? { prompt: `Find junk and promotions in the folder "${folder.name ?? folder.path}" (folderId ${fid}).`, autoSend: true }
          : { prompt: `Suggest folders to file the emails in "${folder.name ?? folder.path}" (folderId ${fid}).`, autoSend: true };
    }
  }
  if (context) {
    await messenger.storage.local.set({ pendingContext: { ...context, time: Date.now() } });
    await openChat();
  }
});

// ---------- Rules on new mail ----------
messenger.messages.onNewMailReceived.addListener(async (folder: any, messageList: any) => {
  if (hasUse(folder, ...NON_MAIL_FOLDERS)) return;
  const headers = [...(messageList?.messages ?? [])];
  let list = messageList;
  while (list?.id) {
    list = await messenger.messages.continueList(list.id);
    headers.push(...(list?.messages ?? []));
  }
  try {
    const s = await getSettings();
    const llm = s.model ? new LlmClient({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, temperature: 0 }) : null;
    // Tag first: tags travel with a message when a rule then moves it.
    if (s.autoTag && llm) {
      try {
        const tagged = await autoTagNew(headers, llm, activeTags(s), Date.now(), allTags(s).map((t) => t.key));
        if (tagged) console.info(`MailMind auto-tagged ${tagged} new message(s)`);
      } catch (e) {
        console.warn('MailMind: auto-tag failed', e);
      }
    }
    const n = await applyRules(headers, llm);
    if (n) console.info(`MailMind rules handled ${n} new message(s)`);
    // Last, and only if nothing else wants the AI: senders missed here get scored by the background scan or the next clean-up.
    if (s.junkScoreNewMail && llm && !isAiBusy(await getAiActivity())) {
      const scored = await scoreNewMail(headers, llm, { myAddresses: await getMyAddresses(), sentTo: await sentRecipients() });
      if (scored) console.info(`MailMind saved junk scores for ${scored} new sender(s)`);
    }
    if (s.smartCategories && llm && !isAiBusy(await getAiActivity())) {
      const groups = groupBySender(headers, await getMyAddresses());
      scoreGroups(groups);
      const placed = await placeSenders(llm, groups, { max: 20 });
      if (placed) console.info(`MailMind sorted ${placed} new sender(s) into smart categories`);
    }
  } catch (e) {
    console.warn('MailMind: new-mail processing failed', e);
  }
});

// ---------- Junk scores: user decisions in Thunderbird beat saved AI scores ----------
// When the user presses Junk / Not Junk in Thunderbird, the saved AI verdict for that sender is dropped,
// so the next clean-up judges the sender afresh (and sees the user's flag). It doesn't add the sender to
// the "not junk" list: Thunderbird's own spam filter changes this flag too, and only the user should do that.
messenger.messages.onUpdated?.addListener((message: any, changed: any) => {
  if (!changed || typeof changed.junk !== 'boolean') return;
  const { address } = parseAddress(message?.author ?? '');
  if (address) forgetSenders([address]).catch(() => {});
});

let sentCache: { at: number; set: Set<string> } | null = null;
async function sentRecipients(): Promise<Set<string>> {
  if (!sentCache || Date.now() - sentCache.at > 6 * 3_600_000) {
    sentCache = { at: Date.now(), set: await getSentRecipients().catch(() => new Set<string>()) };
  }
  return sentCache.set;
}

// ---------- Background junk scan of older mail ----------
const BACKFILL_ALARM = 'mailmind-junk-backfill';
let backfill: AbortController | null = null;

// Anything else that needs the AI (chat, popups, rules, auto-tag, briefing) stops the scan's current request at once.
onAiActivity(() => backfill?.abort());

async function scheduleBackfill(s?: Settings): Promise<void> {
  s ??= await getSettings();
  if ((s.junkBackfill || s.smartCategories) && s.model) {
    if (!(await messenger.alarms.get(BACKFILL_ALARM))) messenger.alarms.create(BACKFILL_ALARM, { delayInMinutes: 2, periodInMinutes: 1 });
  } else {
    await messenger.alarms.clear(BACKFILL_ALARM);
    backfill?.abort();
  }
}

async function runBackfill(): Promise<void> {
  if (backfill) return;
  const s = await getSettings();
  if (!(s.junkBackfill || s.smartCategories) || !s.model || isAiBusy(await getAiActivity())) return;
  const controller = (backfill = new AbortController());
  try {
    const llm = new LlmClient({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, temperature: 0, priority: 'background' });
    const sentTo = await sentRecipients();
    // A few quick steps per tick (months with nothing left to score are cheap); at most one AI request.
    // Weekly: look for new smart-category ideas. That's this tick's one AI request when it runs.
    if (s.smartCategories && (await runDiscoveryStep({ llm, signal: controller.signal })) !== null) return;
    for (let i = 0; i < 6 && !controller.signal.aborted; i++) {
      const outcome = await runBackfillStep({
        llm,
        sentTo,
        signal: controller.signal,
        scoreJunk: s.junkBackfill,
        placeCategories: s.smartCategories,
      });
      if (outcome !== 'advanced') break;
    }
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) console.warn('MailMind: background junk scan failed', e);
  } finally {
    backfill = null;
  }
}

// ---------- Missing-attachment check before send ----------
const allowOnce = new Set<number>();
const ATTACH_WORDS = /\b(attach(ed|ment|ments|ing)?|enclosed|i('|’)ve included the file|see the file)\b/i;

messenger.compose.onBeforeSend.addListener(async (tab: any, details: any) => {
  if (allowOnce.delete(tab.id)) return {};
  const s = await getSettings();
  if (!s.warnMissingAttachment) return {};
  const isHtml = !details.isPlainText;
  const raw = isHtml ? details.body ?? '' : details.plainTextBody ?? '';
  const own = splitComposeBody(raw, isHtml).own;
  const text = isHtml ? htmlToText(own) : own;
  if (!ATTACH_WORDS.test(text) && !ATTACH_WORDS.test(details.subject ?? '')) return {};
  const attachments = await messenger.compose.listAttachments(tab.id).catch(() => []);
  if (attachments.length) return {};
  await messenger.windows.create({
    type: 'popup',
    url: `ui/presend/presend.html?tabId=${tab.id}`,
    width: 460,
    height: 260,
  });
  return { cancel: true };
});

messenger.runtime.onMessage.addListener((msg: any) => {
  if (msg?.type === 'sendAnyway' && typeof msg.tabId === 'number') {
    allowOnce.add(msg.tabId);
    return messenger.compose.sendMessage(msg.tabId).then(
      () => ({ ok: true }),
      (e: Error) => {
        allowOnce.delete(msg.tabId);
        return { ok: false, error: e.message };
      },
    );
  }
  if (msg?.type === 'openChat') return openChat().then(() => ({ ok: true }));
  if (msg?.type === 'suggestTags') return suggestTagsForOptions().catch((e: Error) => ({ error: e.message }));
  if (msg?.type === 'runDigest') return runDigest().then(() => ({ ok: true }));
  return undefined;
});

// ---------- Tag ideas (Settings → "Suggest tags") ----------
async function suggestTagsForOptions() {
  const s = await getSettings();
  if (!s.model) return { error: 'Choose a model first.' };
  const llm = new LlmClient({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, temperature: 0.2 });
  const recent = await recentForTagIdeas();
  return { suggestions: await suggestNewTags(llm, recent, allTags(s)), scanned: recent.length };
}

// ---------- Daily digest ----------
const DIGEST_ALARM = 'mailmind-digest';
const DIGEST_NOTIFICATION = 'mailmind-digest';
let digestRunning = false;

async function scheduleDigest(): Promise<void> {
  await messenger.alarms.clear(DIGEST_ALARM);
  const s = await getSettings();
  if (!s.digestEnabled) return;
  messenger.alarms.create(DIGEST_ALARM, { when: nextOccurrence(s.digestTime).getTime() });
}

async function runDigest(): Promise<void> {
  if (digestRunning) return;
  digestRunning = true;
  try {
    const s = await getSettings();
    const stored = await messenger.storage.local.get(DIGEST_AT_KEY);
    const lastAt = Number(stored?.[DIGEST_AT_KEY]) || 0;
    const since = Math.max(lastAt, Date.now() - 24 * 3_600_000);
    const llm = s.model ? new LlmClient({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, temperature: 0.2 }) : null;
    const digest = await buildDigest(llm, s, since);
    await messenger.storage.local.set({ [DIGEST_KEY]: digest, [DIGEST_AT_KEY]: digest.createdAt });
    await messenger.notifications.create(DIGEST_NOTIFICATION, {
      type: 'basic',
      iconUrl: messenger.runtime.getURL('icons/icon.svg'),
      title: 'MailMind briefing',
      message: `${digestNotificationText(digest)}. Click to open.`,
    });
  } catch (e) {
    console.warn('MailMind: digest failed', e);
  } finally {
    digestRunning = false;
  }
}

messenger.alarms.onAlarm.addListener(async (alarm: any) => {
  if (alarm?.name === BACKFILL_ALARM) return runBackfill();
  if (alarm?.name !== DIGEST_ALARM) return;
  await runDigest();
  await scheduleDigest();
});

messenger.notifications.onClicked.addListener(async (id: string) => {
  if (id !== DIGEST_NOTIFICATION) return;
  await messenger.storage.local.set({ pendingContext: { showDigest: true, time: Date.now() } });
  await openChat();
});

messenger.storage.onChanged.addListener((changes: any, area: string) => {
  if (area !== 'local' || !changes.settings) return;
  const a = changes.settings.oldValue ?? {};
  const b = changes.settings.newValue ?? {};
  if (a.digestEnabled !== b.digestEnabled || a.digestTime !== b.digestTime) scheduleDigest();
  if (a.junkBackfill !== b.junkBackfill || a.smartCategories !== b.smartCategories || a.model !== b.model) scheduleBackfill();
});

scheduleBackfill().catch((e) => console.warn('MailMind: junk scan scheduling failed', e));

(async () => {
  try {
    const s = await getSettings();
    await scheduleDigest();
    if (!s.digestEnabled) return;
    const stored = await messenger.storage.local.get(DIGEST_AT_KEY);
    // Thunderbird was closed at digest time: run it now (after accounts have had a moment to sync).
    if (shouldCatchUp(Number(stored?.[DIGEST_AT_KEY]) || 0, s.digestTime)) setTimeout(runDigest, 60_000);
  } catch (e) {
    console.warn('MailMind: digest scheduling failed', e);
  }
})();
