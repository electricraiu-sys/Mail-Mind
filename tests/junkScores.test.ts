import { afterEach, describe, expect, it } from 'vitest';
import { keepSender } from '../src/core/feedback';
import { runJunkTriage } from '../src/core/triage';
import { getSavedVerdicts, isFresh, scoreNewMail, VERDICT_TTL_MS, SCORES_VERSION, saveVerdicts, forgetSenders } from '../src/core/junkScores';
import { getBackfillState, previousMonth, runBackfillStep } from '../src/core/backfill';
import { isAiBusy, QUIET_MS } from '../src/core/aiActivity';
import { LlmClient, llmActivity } from '../src/core/llm';
import { fakeMessenger, header } from './helpers';

const spam = (addr: string, n: number, date = new Date('2021-05-01T10:00:00Z')) =>
  Array.from({ length: n }, (_, i) => header({ author: `Shop <${addr}>`, subject: i % 2 ? 'Newsletter #' + i : 'Weekly update', read: false, date }));

/** Scripted model that records which senders it was asked about. */
function scriptedLlm(verdict = 'promo') {
  const asked: string[] = [];
  const llm = {
    completeJson: async (_s: string, user: string) => {
      const payload = JSON.parse(user);
      asked.push(...payload.map((p: any) => p.sender));
      return payload.map((p: any) => ({ i: p.i, verdict, confidence: 0.9, reason: 'model says so' }));
    },
  } as any;
  return { llm, asked };
}

describe('saved junk scores', () => {
  it('a second clean-up reuses saved verdicts instead of asking the AI again', async () => {
    fakeMessenger([...spam('a@1.com', 12), ...spam('b@2.com', 12)]);
    const first = scriptedLlm('junk');
    await runJunkTriage({}, { llm: first.llm });
    expect(first.asked.sort()).toEqual(['a@1.com', 'b@2.com']);
    expect(Object.keys(await getSavedVerdicts()).sort()).toEqual(['a@1.com', 'b@2.com']);

    const second = scriptedLlm('junk');
    const r = await runJunkTriage({}, { llm: second.llm });
    expect(second.asked).toEqual([]);
    expect(r.reused).toBe(2);
    expect(r.groups.every((g) => g.verdict === 'junk' && g.source === 'ai')).toBe(true);
  });

  it('"Not junk" beats a saved junk verdict and deletes it', async () => {
    fakeMessenger(spam('a@1.com', 12));
    await runJunkTriage({}, { llm: scriptedLlm('junk').llm });
    expect((await getSavedVerdicts())['a@1.com']?.verdict).toBe('junk');

    await keepSender({ address: 'a@1.com' });
    expect(await getSavedVerdicts()).toEqual({});
    const again = scriptedLlm('junk');
    const r = await runJunkTriage({}, { llm: again.llm });
    const g = r.groups.find((x) => x.address === 'a@1.com')!;
    expect(g.userKept).toBe(true);
    expect(g.score).toBe(0);
    expect(again.asked).toEqual([]);
  });

  it('a saved verdict is ignored once the user writes to the sender', async () => {
    fakeMessenger([...spam('a@1.com', 12), header({ author: 'Me <me@home.test>', recipients: ['a@1.com'], folder: { id: 'acc1://Sent', accountId: 'acc1', path: '/Sent', name: 'Sent', specialUse: ['sent'] } })]);
    await saveVerdicts([{ address: 'a@1.com', count: 12, ai: { verdict: 'junk', confidence: 0.9, reason: 'r' } } as any]);
    const r = await runJunkTriage({}, { llm: scriptedLlm('junk').llm });
    const g = r.groups.find((x) => x.address === 'a@1.com')!;
    expect(g.youWroteTo).toBe(true);
    expect(g.cached).toBeFalsy();
    expect(g.verdict).toBe('personal');
  });

  it('goes stale with age, or when it was based on very few emails', () => {
    const now = Date.now();
    const v = { verdict: 'promo' as const, confidence: 0.8, reason: '', count: 1, at: now, v: SCORES_VERSION };
    expect(isFresh(v, 1, now)).toBe(true);
    expect(isFresh(v, 9, now)).toBe(true);
    expect(isFresh(v, 10, now)).toBe(false);
    expect(isFresh({ ...v, count: 5 }, 500, now)).toBe(true);
    expect(isFresh({ ...v, at: now - VERDICT_TTL_MS - 1 }, 1, now)).toBe(false);
    expect(isFresh(undefined, 1, now)).toBe(false);
  });

  it('forgetSenders removes only the named senders', async () => {
    fakeMessenger([]);
    await saveVerdicts(['a@1.com', 'b@2.com'].map((address) => ({ address, count: 3, ai: { verdict: 'promo', confidence: 0.8, reason: '' } }) as any));
    await forgetSenders(['A@1.com']);
    expect(Object.keys(await getSavedVerdicts())).toEqual(['b@2.com']);
  });
});

describe('scoring new mail', () => {
  it('asks only about senders that are not kept, not written to, and not already scored', async () => {
    const mail = [...spam('new@1.com', 2), ...spam('kept@2.com', 1), ...spam('friend@3.com', 1), ...spam('known@4.com', 1)];
    fakeMessenger(mail);
    await keepSender({ address: 'kept@2.com' });
    await saveVerdicts([{ address: 'known@4.com', count: 5, ai: { verdict: 'promo', confidence: 0.8, reason: '' } } as any]);
    const { llm, asked } = scriptedLlm('newsletter');
    const n = await scoreNewMail(mail, llm, { myAddresses: ['me@home.test'], sentTo: new Set(['friend@3.com']) });
    expect(n).toBe(1);
    expect(asked).toEqual(['new@1.com']);
    expect((await getSavedVerdicts())['new@1.com']).toMatchObject({ verdict: 'newsletter', count: 2 });
  });
});

describe('background scan of older mail', () => {
  const now = new Date('2021-06-15T12:00:00').getTime();

  it('walks back month by month, scoring senders it has not seen, then finishes', async () => {
    fakeMessenger([...spam('june@1.com', 3, new Date('2021-06-02T10:00:00')), ...spam('may@2.com', 3, new Date('2021-05-02T10:00:00'))]);
    const { llm, asked } = scriptedLlm('promo');
    expect(await runBackfillStep({ llm, now })).toBe('scored');
    expect(asked).toEqual(['june@1.com']);
    expect(await runBackfillStep({ llm, now })).toBe('advanced'); // June has nothing left
    expect(await runBackfillStep({ llm, now })).toBe('scored');
    expect(asked).toEqual(['june@1.com', 'may@2.com']);
    expect((await getBackfillState())!.scored).toBe(2);

    let outcome;
    for (let i = 0; i < 60 && outcome !== 'finished'; i++) outcome = await runBackfillStep({ llm, now });
    expect(outcome).toBe('finished');
    expect(await runBackfillStep({ llm, now })).toBe('idle');
    expect(asked).toHaveLength(2);
  });

  it('skips a sender the model gave no usable answer for, but retries when the server is down', async () => {
    fakeMessenger(spam('odd@1.com', 3, new Date('2021-06-02T10:00:00')));
    const down = { completeJson: async () => { throw new Error('connection refused'); } } as any;
    await expect(runBackfillStep({ llm: down, now })).rejects.toThrow('connection refused');
    expect((await getBackfillState())!.failed).toEqual([]);

    const useless = { completeJson: async () => [] } as any;
    expect(await runBackfillStep({ llm: useless, now })).toBe('scored');
    expect((await getBackfillState())!.failed).toEqual(['odd@1.com']);
    expect(await runBackfillStep({ llm: useless, now })).toBe('advanced');
    expect((await getBackfillState())!.month).toBe('2021-05');
  });

  it('stops when aborted and keeps the month', async () => {
    fakeMessenger(spam('a@1.com', 3, new Date('2021-06-02T10:00:00')));
    const controller = new AbortController();
    const llm = {
      completeJson: async () => {
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      },
    } as any;
    await expect(runBackfillStep({ llm, now, signal: controller.signal })).rejects.toThrow('Aborted');
    expect((await getBackfillState())!).toMatchObject({ month: '2021-06', failed: [] });
  });

  it('previousMonth wraps the year', () => {
    expect(previousMonth('2021-01')).toBe('2020-12');
    expect(previousMonth('2021-10')).toBe('2021-09');
  });
});

describe('AI activity', () => {
  afterEach(() => {
    llmActivity.hook = null;
  });

  it('busy while a request runs and for a quiet period after', () => {
    const now = 1_000_000;
    expect(isAiBusy({ at: now - 1000, until: now + 5000 }, now)).toBe(true);
    expect(isAiBusy({ at: now - 1000, until: now - 1000 }, now)).toBe(true);
    expect(isAiBusy({ at: now - QUIET_MS - 1, until: now - QUIET_MS - 1 }, now)).toBe(false);
  });

  it('normal requests report start and end; background-priority ones stay silent', async () => {
    const phases: string[] = [];
    llmActivity.hook = (p) => phases.push(p);
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })) as any;
    await new LlmClient({ baseUrl: 'http://x/v1', model: 'm' }, fetchImpl).complete('s', 'u');
    expect(phases).toEqual(['start', 'end']);
    await new LlmClient({ baseUrl: 'http://x/v1', model: 'm', priority: 'background' }, fetchImpl).complete('s', 'u');
    expect(phases).toEqual(['start', 'end']);
  });
});

describe('order and delivery updates', () => {
  const shipping = (addr: string, subjects: string[]) =>
    subjects.map((subject) => header({ author: `Shop <${addr}>`, subject, read: false }));

  it('delivery senders with an unsubscribe link are order updates, not newsletters', async () => {
    const { groupBySender, scoreGroups } = await import('../src/core/triage');
    const g = groupBySender(
      shipping('shipment-tracking@shop.com', ['Your package has shipped', 'Out for delivery today', 'Delivered: your parcel', 'Your order #123 has shipped']),
      ['me@home.test'],
    );
    g[0].hasUnsubscribe = true;
    scoreGroups(g);
    expect(g[0].verdict).toBe('order');
    expect(g[0].reason).toMatch(/order \/ delivery updates/);
  });

  it('recent order mail is kept out of likely junk; long-past delivery notices can still be cleaned up', async () => {
    const { groupBySender, scoreGroups, isLikelyJunk } = await import('../src/core/triage');
    const now = new Date('2021-06-01T12:00:00').getTime();
    const mk = (date: Date) =>
      ['Your order #1 has shipped', 'Your order #2 has shipped', 'Your order #3 has shipped'].map((subject) =>
        header({ author: 'Shop <shipment-tracking@shop.com>', subject, read: false, date }),
      );
    const recent = groupBySender(mk(new Date('2021-05-30T10:00:00')), [], now);
    recent[0].hasUnsubscribe = true;
    scoreGroups(recent);
    expect(recent[0].verdict).toBe('order');
    expect(isLikelyJunk(recent[0])).toBe(false);
  });

  it('a shop that mostly sends sales emails stays a promo', async () => {
    const { groupBySender, scoreGroups } = await import('../src/core/triage');
    const g = groupBySender(
      shipping('orders@shop.com', ['50% off sale!!!', 'FREE gift – act now', 'Last chance: deals', 'Your order #9 has shipped']),
      ['me@home.test'],
    );
    g[0].hasUnsubscribe = true;
    scoreGroups(g);
    expect(g[0].verdict).toBe('promo');
  });

  it('old saved scores from before the "order" category are redone', () => {
    const now = Date.now();
    expect(isFresh({ verdict: 'newsletter', confidence: 0.8, reason: '', count: 5, at: now }, 5, now)).toBe(false);
  });
});
