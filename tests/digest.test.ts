import { describe, it, expect } from 'vitest';
import { nextOccurrence, shouldCatchUp, buildDigest, digestNotificationText } from '../src/core/digest';
import type { LlmClient } from '../src/core/llm';
import { fakeMessenger, header, SENT, INBOX } from './helpers';

describe('digest scheduling', () => {
  it('schedules later today, or tomorrow once the time has passed', () => {
    const morning = new Date(2026, 10, 20, 7, 0);
    expect(nextOccurrence('08:00', morning)).toEqual(new Date(2026, 10, 20, 8, 0));
    const evening = new Date(2026, 10, 20, 21, 0);
    expect(nextOccurrence('08:00', evening)).toEqual(new Date(2026, 10, 21, 8, 0));
    expect(nextOccurrence('08:00', new Date(2026, 10, 20, 8, 0))).toEqual(new Date(2026, 10, 21, 8, 0));
    // Month/year rollover
    expect(nextOccurrence('06:30', new Date(2026, 11, 31, 23, 0))).toEqual(new Date(2027, 0, 1, 6, 30));
  });

  it('keeps local wall-clock time across a DST change', () => {
    // Whatever the test machine's zone, the result is built from calendar fields, so the hour stays 8.
    for (const d of [new Date(2026, 2, 28, 20, 0), new Date(2026, 9, 24, 20, 0)]) {
      const n = nextOccurrence('08:00', d);
      expect(n.getHours()).toBe(8);
      expect(n.getDate()).toBe(d.getDate() + 1);
    }
  });

  it('catches up once when Thunderbird was closed at digest time', () => {
    const now = new Date(2026, 10, 20, 10, 0);
    expect(shouldCatchUp(undefined, '08:00', now)).toBe(true);
    expect(shouldCatchUp(new Date(2026, 10, 19, 8, 0).getTime(), '08:00', now)).toBe(true);
    expect(shouldCatchUp(new Date(2026, 10, 20, 8, 1).getTime(), '08:00', now)).toBe(false);
    expect(shouldCatchUp(undefined, '11:00', now)).toBe(false);
  });
});

describe('buildDigest', () => {
  it('counts unread inbox mail, picks important mail and adds AI summaries', async () => {
    const now = new Date('2026-11-20T08:00:00Z');
    const recent = new Date('2026-11-19T20:00:00Z');
    fakeMessenger([
      header({ id: 1, folder: INBOX, author: 'Boss <boss@work.test>', subject: 'Budget', date: recent, flagged: true }),
      header({ id: 2, folder: INBOX, author: 'Shop <deals@shop.test>', subject: 'Sale', date: recent, tags: ['mailmind_newsletter'] }),
      header({ id: 3, folder: INBOX, author: 'Carol <carol@x.test>', subject: 'Dinner', date: recent }),
      header({ id: 4, folder: INBOX, author: 'Old <old@x.test>', subject: 'Old', date: new Date('2026-11-01T08:00:00Z') }),
      header({ id: 5, folder: INBOX, author: 'Read <read@x.test>', subject: 'Already read', date: recent, read: true }),
      header({ id: 6, folder: SENT, author: 'me@home.test', recipients: ['carol@x.test'], subject: 'Hi', date: new Date('2026-10-01T08:00:00Z') }),
    ]);
    const llm = {
      completeJson: async (system: string, user: string) => {
        if (/one-line summary/.test(system)) return JSON.parse(user).map((x: any) => ({ i: x.i, summary: `About ${x.subject}` }));
        return [];
      },
    } as unknown as LlmClient;
    const d = await buildDigest(llm, { followupDays: 4, followupLookbackDays: 30 }, now.getTime() - 24 * 3_600_000, now);
    expect(d.unread).toBe(3);
    expect(d.byTag).toEqual([{ label: 'Newsletter', count: 1 }]);
    expect(d.important.map((i) => [i.id, i.why])).toEqual([
      [1, 'flagged'],
      [3, 'from someone you write to'],
    ]);
    expect(d.important[0].summary).toBe('About Budget');
    expect(digestNotificationText(d)).toMatch(/^3 unread · 2 important/);
  });

  it('still works without an AI', async () => {
    fakeMessenger([header({ id: 1, folder: INBOX, flagged: true, date: new Date() })]);
    const d = await buildDigest(null, { followupDays: 4, followupLookbackDays: 30 }, Date.now() - 86_400_000);
    expect(d.important[0].summary).toBeUndefined();
    expect(d.aiError).toBeUndefined();
  });
});
