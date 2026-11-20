import { describe, it, expect } from 'vitest';
import { toIcs, foldLine, icsEscape, parseLocal, validateExtracted, extractEvents, calendarHint } from '../src/core/events';
import type { LlmClient } from '../src/core/llm';

describe('events: parsing and validation', () => {
  it('parses local dates and date-times, rejects impossible ones', () => {
    expect(parseLocal('2026-11-24')).toMatchObject({ allDay: true });
    expect(parseLocal('2026-11-24T15:30')?.date.getHours()).toBe(15);
    expect(parseLocal('2026-02-30')).toBeNull();
    expect(parseLocal('next tuesday')).toBeNull();
    expect(parseLocal(42)).toBeNull();
  });

  it('drops events without a title, with bad dates, and ignores an end before the start', () => {
    const r = validateExtracted({
      events: [
        { title: 'Dentist', start: '2026-11-24T09:00', end: '2026-11-24T08:00' },
        { title: '', start: '2026-11-24' },
        { title: 'Party', start: 'soon' },
      ],
      tasks: [{ title: 'Send forms', due: 'whenever' }, { title: '' }],
    });
    expect(r.events).toHaveLength(1);
    expect(r.events[0].end).toBeUndefined();
    expect(r.tasks).toEqual([{ title: 'Send forms', due: undefined }]);
  });

  it('labels the lookup calendar with this week / next week (weeks start Monday)', () => {
    const rows = calendarHint(new Date(2026, 10, 18), 14).split('\n'); // Wednesday
    expect(rows[0]).toBe('Wednesday 2026-11-18 — reference date');
    expect(rows[1]).toBe('Thursday 2026-11-19 — tomorrow');
    expect(rows[4]).toBe('Sunday 2026-11-22 — this week');
    expect(rows[5]).toBe('Monday 2026-11-23 — next week');
    expect(rows[6]).toBe('Tuesday 2026-11-24 — next week');
    expect(rows[12]).toBe('Monday 2026-11-30 — the week after');
  });

  it('extractEvents validates what the model returns', async () => {
    const llm = {
      completeJson: async (_s: string, user: string) => {
        expect(user).toContain('Reference date');
        return { events: [{ title: 'Call', start: '2026-11-25T10:00', allDay: false }, { title: 'Bad', start: '2026-13-01' }], tasks: [] };
      },
    } as unknown as LlmClient;
    const r = await extractEvents(llm, 'Let’s talk Wednesday 10am', new Date('2026-11-20T12:00:00Z'));
    expect(r.events.map((e) => e.title)).toEqual(['Call']);
  });
});

describe('events: iCalendar output', () => {
  it('escapes special characters', () => {
    expect(icsEscape('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });

  it('folds long lines at 75 octets without splitting multi-byte characters', () => {
    const line = 'SUMMARY:' + 'é'.repeat(60);
    const folded = foldLine(line);
    const enc = new TextEncoder();
    for (const part of folded.split('\r\n')) expect(enc.encode(part).length).toBeLessThanOrEqual(75);
    expect(folded.split('\r\n').map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(line);
  });

  it('writes timed events in UTC, all-day events as dates with an exclusive end, and to-dos', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    const ics = toIcs(
      [
        { title: 'Meeting, room 2', start: '2026-11-24T15:00', allDay: false, location: 'Office' },
        { title: 'Holiday', start: '2026-12-24', end: '2026-12-26', allDay: true },
      ],
      [{ title: 'Pay invoice', due: '2026-11-30' }],
      now,
    );
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    const start = new Date(2026, 10, 24, 15, 0);
    const utc = start.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    expect(ics).toContain(`DTSTART:${utc}`);
    expect(ics).toContain('SUMMARY:Meeting\\, room 2');
    expect(ics).toContain('LOCATION:Office');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261224');
    expect(ics).toContain('DTEND;VALUE=DATE:20261227');
    expect(ics).toContain('BEGIN:VTODO');
    expect(ics).toContain('DUE;VALUE=DATE:20261130');
    expect(ics.match(/UID:/g)).toHaveLength(3);
  });
});
