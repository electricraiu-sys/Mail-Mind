import { describe, expect, it } from 'vitest';
import { getKeptSenders, indexKept, keepSender, keptPromptHint, unkeepSender } from '../src/core/feedback';
import { applyKept, classifyWithAi, groupBySender, isLikelyJunk, pickForAi, runJunkTriage, scoreGroups } from '../src/core/triage';
import { fakeMessenger, header } from './helpers';

const spam = (addr: string, n: number) =>
  Array.from({ length: n }, (_, i) => header({ author: `Shop <${addr}>`, subject: i % 2 ? 'FREE gift – act now!!!' : '50% off sale', read: false }));

function groups(...addrs: string[]) {
  const g = groupBySender(addrs.flatMap((a) => spam(a, 12)), ['me@home.test']);
  scoreGroups(g);
  return g;
}

describe('kept-sender store', () => {
  it('stores, de-duplicates, lower-cases and removes senders', async () => {
    fakeMessenger([]);
    await keepSender({ address: 'Deals@Shop.com', name: 'Shop', sample: 'Your order' });
    await keepSender({ address: 'deals@shop.com', name: 'Shop' });
    let list = await getKeptSenders();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ address: 'deals@shop.com', domain: 'shop.com' });
    await unkeepSender('DEALS@shop.com');
    list = await getKeptSenders();
    expect(list).toEqual([]);
  });
});

describe('applying "not junk" feedback', () => {
  it('keeps exact senders out of likely-junk and out of the AI queue', () => {
    const g = groups('deals@shop.com', 'promo@other.com');
    applyKept(g, indexKept([{ address: 'deals@shop.com', domain: 'shop.com', at: 1 }]));
    const kept = g.find((x) => x.address === 'deals@shop.com')!;
    expect(kept.userKept).toBe(true);
    expect(isLikelyJunk(kept)).toBe(false);
    expect(pickForAi(g).map((x) => x.address)).not.toContain('deals@shop.com');
  });

  it('nudges other senders on the same domain, but not on freemail domains', () => {
    const g = groups('news@shop.com', 'someone@gmail.com');
    const before = Object.fromEntries(g.map((x) => [x.address, x.score]));
    applyKept(
      g,
      indexKept([
        { address: 'deals@shop.com', domain: 'shop.com', at: 1 },
        { address: 'friend@gmail.com', domain: 'gmail.com', at: 1 },
      ]),
    );
    const shop = g.find((x) => x.address === 'news@shop.com')!;
    const gmail = g.find((x) => x.address === 'someone@gmail.com')!;
    expect(shop.score).toBeCloseTo(before['news@shop.com'] - 0.25);
    expect(shop.reason).toMatch(/kept another sender at shop\.com/);
    expect(gmail.score).toBe(before['someone@gmail.com']);
  });

  it('builds a bounded prompt hint', () => {
    expect(keptPromptHint([])).toBe('');
    const list = Array.from({ length: 40 }, (_, i) => ({ address: `a${i}@x.com`, domain: 'x.com', at: i }));
    const hint = keptPromptHint(list);
    expect(hint.match(/<a\d+@x\.com>/g)).toHaveLength(15);
  });
});

describe('classifyWithAi with user decisions mid-run', () => {
  it('passes the hint to the model and skips senders the user handled or kept while it ran', async () => {
    const g = groups('a@1.com', 'b@2.com', 'c@3.com', 'd@4.com');
    const seen: string[] = [];
    const systems: string[] = [];
    const llm = {
      completeJson: async (system: string, user: string) => {
        systems.push(system);
        const payload = JSON.parse(user);
        seen.push(...payload.map((p: any) => p.sender));
        // While batch 1 is "running", the user deletes c@ and keeps d@.
        g.find((x) => x.address === 'c@3.com')!.handled = true;
        g.find((x) => x.address === 'd@4.com')!.userKept = true;
        return payload.map((p: any) => ({ i: p.i, verdict: 'promo', confidence: 0.9, reason: 'r' }));
      },
    } as any;
    for (const x of g) x.aiPending = true;
    await classifyWithAi(llm, g, { batchSize: 2, hint: '\nHINT' });
    expect(seen.sort()).toEqual(['a@1.com', 'b@2.com']);
    expect(systems[0].endsWith('\nHINT')).toBe(true);
    expect(g.every((x) => !x.aiPending)).toBe(true);
  });
});

describe('runJunkTriage live updates', () => {
  it('shows the card before AI review and refreshes after each batch', async () => {
    fakeMessenger(['a@1.com', 'b@2.com', 'c@3.com'].flatMap((a) => spam(a, 12)));
    await keepSender({ address: 'c@3.com' });
    const events: string[] = [];
    const llm = {
      completeJson: async (_s: string, user: string) => {
        events.push(`ai:${JSON.parse(user).length}`);
        return JSON.parse(user).map((p: any) => ({ i: p.i, verdict: 'junk', confidence: 0.9, reason: 'r' }));
      },
    } as any;
    const result = await runJunkTriage(
      {},
      {
        llm,
        onReady: (r) => events.push(`ready:running=${r.aiRunning}:pending=${r.groups.filter((g) => g.aiPending).length}`),
        onUpdate: () => events.push('update'),
      },
    );
    expect(events[0]).toBe('ready:running=true:pending=2');
    expect(events).toContain('ai:2');
    expect(events.at(-1)).toBe('update');
    expect(result.aiRunning).toBe(false);
    expect(result.groups.find((g) => g.address === 'c@3.com')!.userKept).toBe(true);
  });
});
