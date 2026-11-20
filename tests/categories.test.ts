import { describe, expect, it } from 'vitest';
import { cautionsFor, groupBySender, isLikelyJunk, scoreGroups } from '../src/core/triage';
import { header } from './helpers';

const NOW = new Date('2026-11-20T12:00:00').getTime();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000);
const mail = (author: string, subjects: string[], date = daysAgo(400), extra: Record<string, unknown> = {}) =>
  subjects.map((subject) => header({ author, subject, date, read: false, ...extra }));

function one(headers: ReturnType<typeof header>[], unsubscribe = true) {
  const [g] = groupBySender(headers, ['me@home.test'], NOW);
  g.hasUnsubscribe = unsubscribe;
  scoreGroups([g], NOW);
  return g;
}

describe('built-in categories', () => {
  it('bills and statements are finance, never likely junk, and always warn before deleting', () => {
    const g = one(mail('Power Co <billing@power.example>', ['Your bill is ready', 'Your bill is ready', 'Payment due reminder']));
    expect(g.verdict).toBe('finance');
    expect(isLikelyJunk(g)).toBe(false);
    const [c] = cautionsFor([g], g.messages.map((m) => m.id));
    expect(c.reasons).toContain('bills / finance mail');
  });

  it('recent security codes are kept; old ones become clean-up candidates without a warning', () => {
    const subjects = ['Your verification code', 'New sign-in to your account', 'Your verification code'];
    const recent = one(mail('Acme <security@acme.example>', subjects, daysAgo(3)));
    expect(recent.verdict).toBe('security');
    expect(recent.reason).toMatch(/recent security codes/);
    expect(isLikelyJunk(recent)).toBe(false);

    const old = one(mail('Acme <security@acme.example>', subjects, daysAgo(200)));
    expect(old.verdict).toBe('security');
    expect(old.reason).toMatch(/old security codes/);
    expect(old.score).toBeGreaterThan(recent.score);
    expect(cautionsFor([old], old.messages.map((m) => m.id))).toEqual([]);
  });

  it('bookings and tickets are travel', () => {
    const g = one(mail('Air <bookings@air.example>', ['Booking confirmation ABC123', 'Your e-ticket', 'Booking reference XYZ']));
    expect(g.verdict).toBe('travel');
  });

  it('social network mail is social, matched on the domain', () => {
    const g = one(mail('Facebook <notification@facebookmail.com>', ['Alex commented on your post', 'You have 3 new notifications']));
    expect(g.verdict).toBe('social');
    expect(g.reason).toMatch(/social network/);
    const sub = one(mail('LinkedIn <messages-noreply@e.linkedin.com>', ['Sam viewed your profile']));
    expect(sub.verdict).toBe('social');
  });

  it('the biggest share wins when a sender sends several kinds', () => {
    const g = one(mail('Shop <orders@shop.example>', ['Your order #1 has shipped', 'Your order #2 has shipped', 'Your bill is ready']));
    expect(g.verdict).toBe('order');
  });
});
