import { describe, it, expect } from 'vitest';
import { timelyInfo, datesIn, ymd, staleBump } from '../src/core/timely';
import { groupBySender, scoreGroups, applyAiVerdict, isLikelyJunk, importanceOf, cautionsFor } from '../src/core/triage';
import { header } from './helpers';

// Local-time dates so the tests don't depend on the machine's time zone.
const at = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h);
const NOW = at(2026, 11, 20).getTime(); // Friday 20 Nov 2026

describe('datesIn', () => {
  const sent = at(2017, 9, 20); // a Wednesday
  it('resolves relative words against the sent date', () => {
    expect(datesIn('Coming tomorrow', sent).map(ymd)).toEqual(['2017-09-21']);
    expect(datesIn('Arriving today', sent).map(ymd)).toEqual(['2017-09-20']);
    expect(datesIn('Arrives in 3 days', sent).map(ymd)).toEqual(['2017-09-23']);
    expect(datesIn('Arriving Friday', sent).map(ymd)).toEqual(['2017-09-22']);
    expect(datesIn('Arriving Monday', sent).map(ymd)).toEqual(['2017-09-25']);
  });
  it('reads written dates and picks a sensible year', () => {
    expect(datesIn('Delivery on 25 Sep', sent).map(ymd)).toEqual(['2017-09-25']);
    expect(datesIn('Expected October 2nd', sent).map(ymd)).toEqual(['2017-10-02']);
    expect(datesIn('Arriving Jan 3', at(2017, 12, 28)).map(ymd)).toEqual(['2018-01-03']);
    expect(datesIn('Your appointment 2018-02-01', sent).map(ymd)).toEqual(['2018-02-01']);
  });
});

describe('timelyInfo', () => {
  it('treats a past "coming tomorrow" delivery as stale', () => {
    const t = timelyInfo('Your delivery from MSY Technology Pty Ltd is coming tomorrow', at(2017, 9, 20), NOW)!;
    expect(t.kind).toBe('delivery');
    expect(t.due).toBe('2017-09-21');
    expect(t.upcoming).toBe(false);
    expect(t.daysPast).toBeGreaterThan(3000);
  });

  it('treats the same email sent today as upcoming', () => {
    const t = timelyInfo('Your delivery from The Coffee Company is coming tomorrow', at(2026, 11, 20), NOW)!;
    expect(t.upcoming).toBe(true);
    expect(t.label).toBe('delivery expected Sat 21 Nov');
  });

  it('knows shipped parcels take a while and delivered ones are done', () => {
    expect(timelyInfo('Your parcel has shipped', at(2026, 11, 16), NOW)!.upcoming).toBe(true);
    expect(timelyInfo('Your parcel has shipped', at(2026, 10, 1), NOW)!.upcoming).toBe(false);
    expect(timelyInfo('Your package has been delivered', at(2026, 11, 19), NOW)!.upcoming).toBe(false);
  });

  it('handles appointments and offers', () => {
    expect(timelyInfo('Reminder: your appointment on 24 Nov', at(2026, 11, 18), NOW)!.kind).toBe('appointment');
    const offer = timelyInfo('Black Friday sale ends tonight!', at(2026, 11, 1), NOW)!;
    expect(offer.kind).toBe('offer');
    expect(offer.upcoming).toBe(false);
  });

  it('ignores mail without a dated notice', () => {
    expect(timelyInfo('Dinner tomorrow?', at(2026, 11, 19), NOW)).toBeUndefined();
    expect(timelyInfo('Order Confirmation K6MT68WR', at(2017, 1, 1), NOW)).toBeUndefined();
    expect(timelyInfo('FREE delivery on everything', at(2017, 1, 1), NOW)).toBeUndefined();
    expect(timelyInfo('Weekly digest', at(2017, 1, 1), NOW)).toBeUndefined();
  });

  it('stale bump grows with age', () => {
    expect(staleBump(1)).toBeLessThan(staleBump(30));
    expect(staleBump(30)).toBeLessThan(staleBump(90));
    expect(staleBump(90)).toBe(staleBump(4000));
  });
});

describe('time-aware junk scoring', () => {
  const courier = (date: Date) =>
    header({ author: 'Deliveries <notifications@courier.example>', subject: 'Your delivery from MSY Technology Pty Ltd is coming tomorrow', date, read: false });

  it('scores old delivery notices higher the older they are', () => {
    const score = (date: Date) => {
      const [g] = groupBySender([courier(date)], [], NOW);
      scoreGroups([g]);
      return g;
    };
    const old = score(at(2017, 9, 20));
    const recent = score(at(2026, 11, 10));
    const upcoming = score(at(2026, 11, 20));
    expect(old.score).toBeGreaterThan(recent.score);
    expect(recent.score).toBeGreaterThan(upcoming.score);
    expect(old.reason).toMatch(/already past/);
    expect(upcoming.verdict).toBe('order');
    expect(isLikelyJunk(upcoming)).toBe(false);
    expect(upcoming.reason).toMatch(/delivery expected Sat 21 Nov/);
  });

  it('a sender with only stale delivery notices counts as likely junk', () => {
    const groups = groupBySender([courier(at(2017, 9, 20)), courier(at(2017, 8, 15)), courier(at(2017, 4, 10))], [], NOW);
    scoreGroups(groups);
    expect(isLikelyJunk(groups[0])).toBe(true);
  });

  it('an upcoming delivery keeps the sender out of the junk pile even after an AI verdict', () => {
    const groups = groupBySender([courier(at(2026, 11, 20)), courier(at(2017, 9, 20))], [], NOW);
    scoreGroups(groups);
    applyAiVerdict(groups[0], 'promo', 0.9, 'Marketing');
    expect(groups[0].score).toBeLessThanOrEqual(0.3);
    expect(isLikelyJunk(groups[0])).toBe(false);
  });

  it('warns before deleting an upcoming delivery but not an old one', () => {
    const fresh = courier(at(2026, 11, 20));
    const old = courier(at(2017, 9, 20));
    const groups = groupBySender([fresh, old], [], NOW);
    scoreGroups(groups);
    expect(importanceOf(old.subject, old.date, NOW).kind).toBeUndefined();
    expect(importanceOf(fresh.subject, fresh.date, NOW).kind).toBe('delivery expected Sat 21 Nov');
    const [c] = cautionsFor(groups, [fresh.id, old.id]);
    expect(c.ids).toEqual([fresh.id]);
  });
});
