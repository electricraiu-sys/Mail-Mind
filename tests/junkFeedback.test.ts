import { describe, expect, it } from 'vitest';
import { emailPromptHint, getEmailFeedback, getJunkSenders, getKeptSenders, indexEmailFeedback, indexKept, junkPromptHint, keepSender, markJunkSender, setEmailFeedback, unmarkJunkSender } from '../src/core/feedback';
import {
  applyAiVerdict,
  applyEmailFeedback,
  cautionsFor,
  messageCaution,
  applyJunk,
  applyKept,
  groupBySender,
  importanceOf,
  isLikelyJunk,
  isOneTimeCode,
  pickForAi,
  runJunkTriage,
  scoreGroups,
} from '../src/core/triage';
import { fakeMessenger, header } from './helpers';

const NOW = new Date('2026-11-20T12:00:00Z').getTime();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000);

const loginCodes = (addr: string, age: number, n = 3) =>
  Array.from({ length: n }, () => header({ author: `Spotify <${addr}>`, subject: '435134 - Your Spotify login code', date: daysAgo(age), read: false }));

describe('junk-sender store', () => {
  it('stores, de-duplicates and removes senders, and is the opposite of "not junk"', async () => {
    fakeMessenger([]);
    await keepSender({ address: 'news@shop.com' });
    await markJunkSender({ address: 'News@Shop.com', name: 'Shop', sample: 'Big sale' });
    await markJunkSender({ address: 'news@shop.com' });
    expect(await getJunkSenders()).toHaveLength(1);
    expect(await getKeptSenders()).toEqual([]);
    // And back again: "Not junk" takes it off the junk list.
    await keepSender({ address: 'news@shop.com' });
    expect(await getJunkSenders()).toEqual([]);
    await markJunkSender({ address: 'x@y.com' });
    await unmarkJunkSender('X@Y.com');
    expect(await getJunkSenders()).toEqual([]);
  });

  it('builds a prompt hint of unwanted senders', () => {
    expect(junkPromptHint([])).toBe('');
    expect(junkPromptHint([{ address: 'a@x.com', domain: 'x.com', sample: 'Win big', at: 1 }])).toMatch(/ARE junk[\s\S]*<a@x\.com> e\.g\. "Win big"/);
  });
});

describe('applying "junk" feedback', () => {
  const groups = () => {
    const g = groupBySender(
      [
        ...Array.from({ length: 4 }, () => header({ author: 'A <hello@friendly.com>', subject: 'Our news', read: true })),
        ...Array.from({ length: 4 }, () => header({ author: 'B <other@friendly.com>', subject: 'Our news', read: true })),
      ],
      ['me@home.test'],
    );
    scoreGroups(g);
    return g;
  };

  it('makes exact senders junk and keeps them away from the AI', () => {
    const g = groups();
    applyJunk(g, indexKept([{ address: 'hello@friendly.com', domain: 'friendly.com', at: 1 }]));
    const j = g.find((x) => x.address === 'hello@friendly.com')!;
    expect(j).toMatchObject({ userJunk: true, verdict: 'junk', score: 1, source: 'user' });
    expect(isLikelyJunk(j)).toBe(true);
    expect(pickForAi(g).map((x) => x.address)).not.toContain('hello@friendly.com');
  });

  it('nudges same-domain senders up, but never a sender the user kept', () => {
    const g = groups();
    const before = g.find((x) => x.address === 'other@friendly.com')!.score;
    applyJunk(g, indexKept([{ address: 'hello@friendly.com', domain: 'friendly.com', at: 1 }]));
    expect(g.find((x) => x.address === 'other@friendly.com')!.score).toBeCloseTo(before + 0.2);

    const g2 = groups();
    applyKept(g2, indexKept([{ address: 'other@friendly.com', domain: 'friendly.com', at: 1 }]));
    applyJunk(g2, indexKept([{ address: 'hello@friendly.com', domain: 'friendly.com', at: 1 }]));
    expect(g2.find((x) => x.address === 'other@friendly.com')!.score).toBe(0);
  });

  it('runJunkTriage applies the junk list and passes it to the model', async () => {
    const spam = (a: string) => Array.from({ length: 12 }, () => header({ author: `S <${a}>`, subject: '50% off sale', read: false }));
    fakeMessenger([...spam('a@1.com'), ...spam('b@2.com')]);
    await markJunkSender({ address: 'b@2.com', sample: '50% off sale' });
    const systems: string[] = [];
    const llm = {
      completeJson: async (system: string, user: string) => {
        systems.push(system);
        return JSON.parse(user).map((p: any) => ({ i: p.i, verdict: 'promo', confidence: 0.9, reason: 'r' }));
      },
    } as any;
    const r = await runJunkTriage({}, { llm });
    expect(r.groups.find((g) => g.address === 'b@2.com')).toMatchObject({ userJunk: true, verdict: 'junk' });
    expect(systems.join()).toMatch(/ARE junk[\s\S]*<b@2\.com>/);
    expect(systems.join()).not.toMatch(/"sender":"b@2\.com"/);
  });
});

describe('one-time login codes', () => {
  it('recognises login codes but not promo codes', () => {
    for (const s of ['435134 - Your Spotify login code', '123456 is your Instagram code', 'Your verification code', 'Your one-time passcode', 'Sign-in code for Steam'])
      expect(isOneTimeCode(s)).toBe(true);
    for (const s of ['Use promo code SAVE20', 'Your discount code inside', 'Code of conduct update', 'Your booking confirmation code ABC123'])
      expect(isOneTimeCode(s)).toBe(false);
  });

  it('a code from today may still be needed; one over 7 days old is not', () => {
    expect(importanceOf('435134 - Your Spotify login code', daysAgo(1), NOW).kind).toBe('account security');
    expect(importanceOf('435134 - Your Spotify login code', daysAgo(9), NOW).kind).toBeUndefined();
  });

  it('a sender of expired login codes is likely junk, even if the AI calls it "security"', () => {
    const [old] = groupBySender(loginCodes('no-reply@alerts.spotify.com', 9), [], NOW);
    scoreGroups([old], NOW);
    expect(old.messages.every((m) => m.expiredCode)).toBe(true);
    expect(old.reason).toMatch(/expired one-time login codes/);
    expect(isLikelyJunk(old)).toBe(true);
    applyAiVerdict(old, 'security', 0.9, 'login codes');
    expect(isLikelyJunk(old)).toBe(true);
  });

  it('recent codes are protected', () => {
    const [recent] = groupBySender(loginCodes('no-reply@alerts.spotify.com', 2), [], NOW);
    scoreGroups([recent], NOW);
    expect(isLikelyJunk(recent)).toBe(false);
    // One fresh code among old ones: the sender still has a code that may be in use.
    const [mixed] = groupBySender([...loginCodes('no-reply@alerts.spotify.com', 30), ...loginCodes('no-reply@alerts.spotify.com', 0, 1)], [], NOW);
    scoreGroups([mixed], NOW);
    expect(mixed.reason).not.toMatch(/expired one-time/);
  });
});

describe('feedback on single emails', () => {
  const shop = () =>
    groupBySender(
      [
        header({ id: 1, author: 'Shop <support@shop.com>', subject: 'What do you think of your dishwasher?', read: false }),
        header({ id: 2, author: 'Shop <support@shop.com>', subject: 'What do you think of your dishwasher?', read: false }),
        header({ id: 3, author: 'Shop <support@shop.com>', subject: 'Tax invoice - SI033', read: false }),
        header({ id: 4, author: 'Shop <support@shop.com>', subject: 'Thanks for your purchase', read: false }),
      ],
      [],
    );

  it('stores verdicts, matches copies by subject, and the latest answer wins', async () => {
    fakeMessenger([]);
    await setEmailFeedback([{ id: 1, address: 'Support@Shop.com', subject: 'What do you think of your dishwasher?' }], 'junk');
    await setEmailFeedback([{ id: 3, address: 'support@shop.com', subject: 'Tax invoice - SI033' }], 'keep');
    const idx = indexEmailFeedback(await getEmailFeedback());
    expect(idx.verdictOf({ id: 2, subject: 'What do you think of your dishwasher?' }, 'support@shop.com')).toBe('junk');
    expect(idx.verdictOf({ id: 99, subject: 'Tax invoice - SI033' }, 'support@shop.com')).toBe('keep');
    expect(idx.verdictOf({ id: 4, subject: 'Thanks for your purchase' }, 'support@shop.com')).toBeUndefined();

    await setEmailFeedback([{ id: 1, address: 'support@shop.com', subject: 'What do you think of your dishwasher?' }], 'keep');
    expect(await getEmailFeedback()).toHaveLength(2);
    await setEmailFeedback([{ id: 1, address: 'support@shop.com', subject: 'What do you think of your dishwasher?' }], null);
    expect((await getEmailFeedback()).map((f) => f.id)).toEqual([3]);
  });

  it('nudges the sender, protects kept emails and clears the warning on junked ones', () => {
    const g = shop();
    scoreGroups(g);
    const before = g[0].score;
    applyEmailFeedback(
      g,
      indexEmailFeedback([
        { id: 1, address: 'support@shop.com', subject: 'What do you think of your dishwasher?', verdict: 'junk', at: 2 },
        { id: 4, address: 'support@shop.com', subject: 'Thanks for your purchase', verdict: 'keep', at: 1 },
      ]),
    );
    expect(g[0].score).toBeGreaterThan(before);
    expect(g[0].reason).toMatch(/You marked 2 emails from this sender as junk/);
    const byId = (id: number) => g[0].messages.find((m) => m.id === id)!;
    expect(messageCaution(byId(4))).toBe('you marked it not junk');
    expect(messageCaution(byId(3))).toBe('receipt / invoice');
    const c = cautionsFor(g, [1, 2, 4]);
    expect(c[0].ids).toEqual([4]);
  });

  it('leaves a sender the user judged as a whole alone, and feeds examples to the model', () => {
    const g = shop();
    scoreGroups(g);
    applyKept(g, indexKept([{ address: 'support@shop.com', domain: 'shop.com', at: 1 }]));
    applyEmailFeedback(g, indexEmailFeedback([{ id: 1, address: 'support@shop.com', subject: 'What do you think of your dishwasher?', verdict: 'junk', at: 1 }]));
    expect(g[0].score).toBe(0);
    expect(g[0].messages.find((m) => m.id === 1)!.userVerdict).toBe('junk');
    expect(emailPromptHint([{ id: 1, address: 'a@x.com', subject: 'Rate us', verdict: 'junk', at: 1 }])).toMatch(/JUNK[\s\S]*<a@x\.com> "Rate us"/);
    expect(emailPromptHint([])).toBe('');
  });
});
