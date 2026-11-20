import { describe, it, expect } from 'vitest';
import { groupBySender, scoreGroups, applyAiVerdict, pickForAi, isLikelyJunk, classifyWithAi, importantKind, cautionsFor } from '../src/core/triage';
import { header } from './helpers';
import type { LlmClient } from '../src/core/llm';

function fixture() {
  const msgs = [
    // Spammy, never opened, high volume
    ...Array.from({ length: 25 }, (_, i) => header({ author: 'Big Prizes <junk@email.com>', subject: i % 2 ? 'You are a WINNER! Claim your prize' : 'FREE gift – act now!!!', read: false })),
    // Friend: read, user wrote to them
    ...Array.from({ length: 6 }, () => header({ author: 'Alice <alice@friends.org>', subject: 'Dinner?', read: true })),
    // Newsletter, sometimes opened
    ...Array.from({ length: 10 }, (_, i) => header({ author: 'Weekly <newsletter@news.example>', subject: `Issue #${i}`, read: i < 2 })),
    // Own mail is ignored
    header({ author: 'Me <me@home.test>', subject: 'note to self' }),
  ];
  const groups = groupBySender(msgs, ['me@home.test']);
  for (const g of groups) {
    if (g.address === 'alice@friends.org') g.youWroteTo = true;
    if (g.address === 'newsletter@news.example') g.hasUnsubscribe = true;
  }
  scoreGroups(groups);
  return groups;
}

describe('triage heuristics', () => {
  it('groups by sender and skips the user’s own address', () => {
    const groups = fixture();
    expect(groups.map((g) => g.address)).toEqual(['junk@email.com', 'newsletter@news.example', 'alice@friends.org']);
    expect(groups[0].count).toBe(25);
    expect(groups[0].unread).toBe(25);
  });

  it('ranks junk high and people the user writes to low', () => {
    const groups = fixture();
    const junk = groups.find((g) => g.address === 'junk@email.com')!;
    const alice = groups.find((g) => g.address === 'alice@friends.org')!;
    const news = groups.find((g) => g.address === 'newsletter@news.example')!;
    expect(junk.score).toBeGreaterThan(0.6);
    expect(junk.verdict).toBe('junk');
    expect(isLikelyJunk(junk)).toBe(true);
    expect(alice.score).toBeLessThan(0.1);
    expect(alice.verdict).toBe('personal');
    expect(isLikelyJunk(alice)).toBe(false);
    expect(news.verdict).toBe('newsletter');
    expect(junk.reason).toMatch(/never opened/);
  });

  it('AI verdicts blend with heuristics', () => {
    const groups = fixture();
    const news = groups.find((g) => g.address === 'newsletter@news.example')!;
    applyAiVerdict(news, 'important', 0.9, 'Bank statements');
    expect(news.verdict).toBe('important');
    expect(isLikelyJunk(news)).toBe(false);
    expect(news.source).toBe('ai');
  });

  it('never sends people the user writes to for AI review', () => {
    expect(pickForAi(fixture()).some((g) => g.youWroteTo)).toBe(false);
  });

  it('classifyWithAi maps JSON results back to the right senders', async () => {
    const groups = fixture().filter((g) => !g.youWroteTo);
    const fake = {
      completeJson: async () => [
        { i: 0, verdict: 'junk', confidence: 0.95, reason: 'Prize scam' },
        { i: 1, verdict: 'bogus', confidence: 1, reason: 'ignored' },
      ],
    } as unknown as LlmClient;
    await classifyWithAi(fake, groups);
    expect(groups[0].verdict).toBe('junk');
    expect(groups[0].reason).toBe('Prize scam');
    expect(groups[1].source).toBe('heuristic');
  });
});

describe('may-be-important detection', () => {
  it('recognises transactional subjects but not promotional look-alikes', () => {
    expect(importantKind('Order Confirmation K6MT68WR')).toBe('order confirmation');
    expect(importantKind('Your receipt from Apple')).toBe('receipt / invoice');
    expect(importantKind('Your bill is ready')).toBe('bill / statement');
    expect(importantKind('Security alert: new sign-in')).toBe('account security');
    expect(importantKind('Your parcel has shipped')).toBe('shipping / delivery');
    // Strong kinds survive promo wording; weak ones don't.
    expect(importantKind('Your order #123 — 20% off your next one')).toBe('order confirmation');
    expect(importantKind('FREE delivery on everything — last chance!')).toBeUndefined();
    expect(importantKind('Weekly digest')).toBeUndefined();
  });

  it('lowers the junk score of order/receipt senders and explains why', () => {
    const groups = groupBySender(Array.from({ length: 3 }, () => header({ author: 'Kogan <donotreply@kogan.com>', subject: 'Order Confirmation K6MT68WR' })));
    scoreGroups(groups);
    expect(groups[0].reason).toMatch(/order confirmation/);
    expect(groups[0].score).toBeLessThan(0.45);
  });

  it('cautionsFor flags only the risky selected emails', () => {
    const order = header({ author: 'Shop <noreply@shop.test>', subject: 'Order Confirmation 1' });
    const promo = header({ author: 'Shop <noreply@shop.test>', subject: 'Big SALE today' });
    const flagged = header({ author: 'Promo <deals@promo.test>', subject: 'Deals', flagged: true });
    const friend = header({ author: 'Bob <bob@x.test>', subject: 'hi' });
    const groups = groupBySender([order, promo, flagged, friend]);
    scoreGroups(groups);
    groups.find((g) => g.address === 'bob@x.test')!.youWroteTo = true;

    const c = cautionsFor(groups, [order.id, promo.id, flagged.id, friend.id]);
    const ids = c.flatMap((x) => x.ids).sort();
    expect(ids).toEqual([order.id, flagged.id, friend.id].sort());
    expect(c.find((x) => x.address === 'bob@x.test')!.reasons).toContain('you have written to this sender');
    expect(cautionsFor(groups, [promo.id])).toEqual([]);
  });

  it('cautionsFor checks emails pulled in from other years too', () => {
    const groups = groupBySender([header({ author: 'Shop <noreply@shop.test>', subject: 'Sale' })]);
    scoreGroups(groups);
    const extra = new Map([[999, { address: 'noreply@shop.test', subject: 'Your invoice #42' }]]);
    const c = cautionsFor(groups, [999], extra);
    expect(c[0].ids).toEqual([999]);
    expect(c[0].reasons).toContain('receipt / invoice');
  });
});
