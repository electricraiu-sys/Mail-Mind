import type { TagDef } from './autotag';

export type ToolMode = 'auto' | 'native' | 'json';

export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  embeddingModel: string;
  toolMode: ToolMode;
  /** Set automatically when "auto" discovers the model can't do native tool calls. */
  detectedToolMode?: 'native' | 'json';
  temperature: number;
  maxToolSteps: number;
  maxCharsPerMessage: number;
  historyCharBudget: number;
  warnMissingAttachment: boolean;
  learnStyleFromSent: boolean;
  /** AI-tag new mail (Needs reply, Receipt, …). Off by default. */
  autoTag: boolean;
  /** Tag keys auto-tagging may use (empty = all). */
  autoTagKeys: string[];
  /** The user's own tags (added by hand or accepted from the AI's suggestions). */
  customTags: TagDef[];
  /** Give new mail's senders a saved AI junk score as it arrives (read-only). */
  junkScoreNewMail: boolean;
  /** Slowly score older mail in the background, pausing whenever the AI is needed for anything else. */
  junkBackfill: boolean;
  /** Let the AI suggest topic categories ("Kids' school", "Car") and sort senders into the ones you approve. */
  smartCategories: boolean;
  digestEnabled: boolean;
  /** Local time "HH:MM". */
  digestTime: string;
  /** A sent email counts as "waiting" after this many days without a reply. */
  followupDays: number;
  followupLookbackDays: number;
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: 'gemma4:latest',
  embeddingModel: '',
  toolMode: 'auto',
  temperature: 0.3,
  maxToolSteps: 8,
  maxCharsPerMessage: 4000,
  historyCharBudget: 24000,
  warnMissingAttachment: true,
  learnStyleFromSent: true,
  autoTag: false,
  autoTagKeys: [],
  customTags: [],
  junkScoreNewMail: true,
  junkBackfill: true,
  smartCategories: true,
  digestEnabled: false,
  digestTime: '08:00',
  followupDays: 4,
  followupLookbackDays: 30,
};

export async function getSettings(): Promise<Settings> {
  const stored = await messenger.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored?.settings ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await messenger.storage.local.set({ settings: next });
  return next;
}

export function effectiveToolMode(s: Settings): 'native' | 'json' {
  if (s.toolMode === 'native' || s.toolMode === 'json') return s.toolMode;
  return s.detectedToolMode ?? 'native';
}

/** True when the endpoint is on this computer or a private LAN address. */
export function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.localhost')) return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

export function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}
