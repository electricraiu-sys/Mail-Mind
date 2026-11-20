import { el, $ } from '../dom';
import { getSettings, saveSettings, isLocalUrl, originPattern, type Settings } from '../../core/settings';
import { LlmClient, describeLlmError } from '../../core/llm';
import { getRules, updateRule, deleteRule } from '../../core/rules';
import { getUndoLog, undo } from '../../core/actions';
import { getKeptSenders, unkeepSender } from '../../core/feedback';
import { clearEmbeddings } from '../../core/embeddings';
import { clearSavedVerdicts, getSavedVerdicts } from '../../core/junkScores';
import { getBackfillState, resetBackfill } from '../../core/backfill';
import {
  clearSmartCategories,
  deleteCategory,
  getCategories,
  getMemberships,
  getSuggestions,
  renameCategory,
  setSenderCategory,
} from '../../core/smartCategories';
import { describeRule } from '../chat/cards';
import { TAGS } from '../../core/autotag';

const TEXT_FIELDS = ['baseUrl', 'apiKey', 'model', 'embeddingModel'] as const;
const NUM_FIELDS = ['temperature', 'maxToolSteps', 'maxCharsPerMessage', 'historyCharBudget', 'followupDays', 'followupLookbackDays'] as const;
const BOOL_FIELDS = ['warnMissingAttachment', 'learnStyleFromSent', 'autoTag', 'digestEnabled', 'junkScoreNewMail', 'junkBackfill', 'smartCategories'] as const;

const input = (id: string) => $(`#${id}`) as HTMLInputElement;

function fill(s: Settings) {
  for (const f of TEXT_FIELDS) input(f).value = String(s[f] ?? '');
  for (const f of NUM_FIELDS) input(f).value = String(s[f]);
  for (const f of BOOL_FIELDS) input(f).checked = !!s[f];
  ($('#toolMode') as HTMLSelectElement).value = s.toolMode;
  input('digestTime').value = s.digestTime;
  const box = $('#tagKeys');
  box.replaceChildren(
    el('span', { class: 'muted' }, 'Tags to use:'),
    ...TAGS.map((t) =>
      el('label', { class: 'row' }, el('input', { type: 'checkbox', 'data-tag': t.key, checked: !s.autoTagKeys.length || s.autoTagKeys.includes(t.key) }), el('span', { style: { color: t.color } }, '●'), t.label),
    ),
  );
  $('#detected').textContent = s.toolMode === 'auto' && s.detectedToolMode ? `Detected: ${s.detectedToolMode === 'json' ? 'compatibility mode' : 'native'}` : '';
}

function read(): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const f of TEXT_FIELDS) (out as any)[f] = input(f).value.trim();
  for (const f of NUM_FIELDS) {
    const n = Number(input(f).value);
    if (Number.isFinite(n)) (out as any)[f] = n;
  }
  for (const f of BOOL_FIELDS) (out as any)[f] = input(f).checked;
  out.toolMode = ($('#toolMode') as HTMLSelectElement).value as Settings['toolMode'];
  if (/^\d{1,2}:\d{2}$/.test(input('digestTime').value)) out.digestTime = input('digestTime').value;
  const keys = [...document.querySelectorAll<HTMLInputElement>('#tagKeys input[data-tag]')].filter((b) => b.checked).map((b) => b.dataset.tag!);
  out.autoTagKeys = keys.length === TAGS.length ? [] : keys;
  return out;
}

async function ensurePermission(url: string): Promise<boolean> {
  const pattern = originPattern(url);
  if (!pattern) return false;
  if (await messenger.permissions.contains({ origins: [pattern] }).catch(() => false)) return true;
  return messenger.permissions.request({ origins: [pattern] }).catch(() => false);
}

async function save(): Promise<Settings> {
  const prev = await getSettings();
  const patch = read();
  // Re-detect tool support when the model or server changes.
  if (patch.model !== prev.model || patch.baseUrl !== prev.baseUrl || patch.toolMode !== prev.toolMode) patch.detectedToolMode = undefined;
  const s = await saveSettings(patch);
  fill(s);
  return s;
}

const onSave = (resultId: string) => async () => {
  const s = await save();
  const r = $(`#${resultId}`);
  if (!isLocalUrl(s.baseUrl)) {
    r.className = 'small err-text';
    r.textContent = '⚠ Saved — but this server is not on your computer/LAN. Your emails will be sent to it.';
  } else {
    r.className = 'small ok-text';
    r.textContent = '✓ Saved';
  }
  setTimeout(() => (r.textContent = ''), 4000);
};
$('#btn-save').addEventListener('click', onSave('save-result'));
$('#btn-save2').addEventListener('click', onSave('save-result2'));

$('#btn-digest-now').addEventListener('click', async () => {
  const b = $('#btn-digest-now') as HTMLButtonElement;
  const r = $('#digest-result');
  b.disabled = true;
  r.className = 'small muted';
  r.textContent = 'Building the briefing… (this can take a minute)';
  try {
    await save();
    await messenger.runtime.sendMessage({ type: 'runDigest' });
    r.className = 'small ok-text';
    r.textContent = '✓ Done. Click the notification, or open the chat.';
  } catch (e) {
    r.className = 'small err-text';
    r.textContent = (e as Error).message;
  } finally {
    b.disabled = false;
  }
});

$('#btn-test').addEventListener('click', async () => {
  const r = $('#test-result');
  const url = input('baseUrl').value.trim();
  r.className = 'small muted';
  r.textContent = 'Connecting…';
  if (!(await ensurePermission(url))) {
    r.className = 'small err-text';
    r.textContent = 'Permission to reach that server was not granted.';
    return;
  }
  const llm = new LlmClient({ baseUrl: url, apiKey: input('apiKey').value.trim(), model: input('model').value.trim() });
  try {
    const models = await llm.listModels();
    const dl = $('#models');
    dl.replaceChildren(...models.map((m) => el('option', { value: m })));
    if (!input('model').value && models.length) input('model').value = models.find((m) => !/embed/i.test(m)) ?? models[0];
    r.className = 'small ok-text';
    r.textContent = `✓ Connected — ${models.length} model${models.length === 1 ? '' : 's'} available.`;
    if (input('model').value) {
      r.textContent += ' Testing the chat model…';
      llm.config.model = input('model').value.trim();
      const reply = await llm.complete('Reply with the single word: ready', 'Are you ready?');
      r.textContent = `✓ Connected — ${models.length} models. “${llm.config.model}” replied: ${reply.trim().slice(0, 40)}`;
    }
    await save();
  } catch (e) {
    r.className = 'small err-text';
    r.textContent = describeLlmError(e, url);
  }
});

const PRESETS: Record<string, string> = {
  'preset-ollama': 'http://localhost:11434/v1',
  'preset-lmstudio': 'http://localhost:1234/v1',
  'preset-llamacpp': 'http://localhost:8080/v1',
};
for (const [id, url] of Object.entries(PRESETS)) $(`#${id}`).addEventListener('click', () => (input('baseUrl').value = url));

async function renderRules() {
  const box = $('#rules');
  const rules = await getRules();
  box.replaceChildren();
  if (!rules.length) return box.append(el('div', { class: 'muted small' }, 'No rules yet.'));
  for (const r of rules) {
    const toggle = el('input', { type: 'checkbox', checked: r.enabled, title: 'Enabled' }) as HTMLInputElement;
    toggle.addEventListener('change', () => updateRule(r.id, { enabled: toggle.checked }));
    const del = el('button', { class: 'small' }, 'Delete');
    del.addEventListener('click', async () => {
      await deleteRule(r.id);
      renderRules();
    });
    box.append(
      el(
        'div',
        { class: 'item' },
        toggle,
        el('div', { class: 'grow' }, el('strong', null, r.name), el('div', { class: 'small muted' }, `${describeRule(r)} · applied ${r.appliedCount}×`)),
        del,
      ),
    );
  }
}

async function renderKept() {
  const box = $('#kept');
  const list = await getKeptSenders();
  box.replaceChildren();
  if (!list.length) return box.append(el('div', { class: 'muted small' }, 'None yet. Use “👍 Not junk” in the clean-up review.'));
  for (const k of list.slice(0, 200)) {
    const del = el('button', { class: 'small' }, 'Remove');
    del.addEventListener('click', async () => {
      await unkeepSender(k.address);
      renderKept();
    });
    box.append(
      el(
        'div',
        { class: 'item' },
        el(
          'div',
          { class: 'grow' },
          el('strong', null, k.name || k.address),
          el('div', { class: 'small muted' }, `${k.name ? `${k.address} · ` : ''}${new Date(k.at).toLocaleDateString()}${k.sample ? ` · “${k.sample}”` : ''}`),
        ),
        del,
      ),
    );
  }
  if (list.length > 200) box.append(el('div', { class: 'muted small' }, `…and ${list.length - 200} more`));
}

async function renderUndo() {
  const box = $('#undo');
  const log = await getUndoLog();
  box.replaceChildren();
  if (!log.length) return box.append(el('div', { class: 'muted small' }, 'Nothing yet.'));
  for (const e of log.slice(0, 30)) {
    const btn = el('button', { class: 'small', disabled: !!e.undone }, e.undone ? 'Undone' : 'Undo');
    const note = el('span', { class: 'small muted' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Undoing…';
      try {
        const r = await undo(e.id);
        note.textContent = `Restored ${r.restored}${r.missing ? `, ${r.missing} not found` : ''}`;
        btn.textContent = 'Undone';
      } catch (err) {
        note.textContent = (err as Error).message;
        btn.disabled = false;
        btn.textContent = 'Undo';
      }
    });
    box.append(
      el(
        'div',
        { class: 'item' },
        el('div', { class: 'grow' }, el('div', null, e.label), el('div', { class: 'small muted' }, `${new Date(e.time).toLocaleString()}${e.source ? ` · ${e.source}` : ''}`)),
        note,
        btn,
      ),
    );
  }
}

$('#btn-clear-chat').addEventListener('click', async () => {
  await messenger.storage.local.remove('chatHistory');
  $('#data-result').textContent = '✓ Chat history cleared';
});
$('#btn-clear-emb').addEventListener('click', async () => {
  await clearEmbeddings();
  $('#data-result').textContent = '✓ Search index cleared';
});

$('#btn-clear-junk').addEventListener('click', async () => {
  await clearSavedVerdicts();
  await resetBackfill();
  $('#data-result').textContent = '✓ Saved junk scores cleared; the background scan starts again from this month';
  renderJunkStatus();
});

async function renderSmart() {
  const box = $('#smart');
  const [categories, members, suggestions] = await Promise.all([getCategories(), getMemberships(), getSuggestions()]);
  box.replaceChildren();
  if (suggestions.length) box.append(el('div', { class: 'small' }, `${suggestions.length} idea(s) waiting for you in the chat: ${suggestions.map((s) => `“${s.name}”`).join(', ')}`));
  if (!categories.length) {
    box.append(el('div', { class: 'muted small' }, 'None yet. Ask the chat “suggest some categories for my email”, or wait for the weekly suggestions.'));
    return;
  }
  for (const c of categories) {
    const senders = Object.entries(members).filter(([, m]) => m.id === c.id).map(([a, m]) => ({ a, m }));
    const name = el('input', { type: 'text', value: c.name, maxlength: '40', style: { width: 'auto' } }) as HTMLInputElement;
    const note = el('span', { class: 'small muted' });
    const save = el('button', { class: 'small' }, 'Rename');
    save.addEventListener('click', async () => {
      try {
        await renameCategory(c.id, name.value);
        note.textContent = '✓ Renamed';
      } catch (e) {
        note.textContent = e instanceof Error ? e.message : String(e);
      }
    });
    const del = el('button', { class: 'small' }, 'Delete');
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the category “${c.name}”? No emails are changed.`)) return;
      await deleteCategory(c.id);
      renderSmart();
    });
    const list = el(
      'details',
      null,
      el('summary', { class: 'small' }, `${senders.length} sender${senders.length === 1 ? '' : 's'}`),
      ...senders.slice(0, 300).map(({ a, m }) => {
        const rm = el('button', { class: 'small ghost', title: 'Take this sender out of the category' }, 'Remove');
        rm.addEventListener('click', async () => {
          await setSenderCategory(a, null);
          renderSmart();
        });
        return el('div', { class: 'item small' }, el('div', { class: 'grow' }, a, el('span', { class: 'muted' }, m.source === 'user' ? ' · added by you' : ' · sorted by AI')), rm);
      }),
    );
    box.append(el('div', { class: 'item' }, el('div', { class: 'grow' }, el('div', { class: 'row' }, name, save, del, note), el('div', { class: 'small muted' }, c.description), list)));
  }
}

$('#btn-clear-smart').addEventListener('click', async () => {
  if (!confirm('Delete all smart categories, suggestions and sender placements? No emails are changed.')) return;
  await clearSmartCategories();
  $('#data-result').textContent = '✓ Smart categories cleared';
  renderSmart();
});

async function renderJunkStatus() {
  const [saved, state] = await Promise.all([getSavedVerdicts(), getBackfillState()]);
  const n = Object.keys(saved).length;
  const month = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
  const scan = !state
    ? 'The background scan hasn’t started yet.'
    : state.finishedAt
      ? `Background scan finished on ${new Date(state.finishedAt).toLocaleDateString()}.`
      : `Background scan is working through ${month(state.month)}.`;
  $('#junk-status').textContent = `${n.toLocaleString()} sender${n === 1 ? '' : 's'} have a saved junk score. ${scan}`;
}
messenger.storage.onChanged.addListener((changes: any, area: string) => {
  if (area === 'local' && (changes.junkScores || changes.junkBackfill)) renderJunkStatus();
  if (area === 'local' && (changes.smartCategories || changes.smartSuggestions)) renderSmart();
});

(async () => {
  fill(await getSettings());
  renderJunkStatus();
  renderSmart();
  renderRules();
  renderKept();
  renderUndo();
})();
