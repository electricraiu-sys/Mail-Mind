/**
 * Time-bound notices: emails that matter until a date and are clutter after it.
 *
 * "Your delivery is coming tomorrow" sent on 2017-09-20 was about 2017-09-21. Until then it may matter
 * (someone needs to be home); once the day has passed it's just clutter, and the older it gets the safer
 * it is to clean up. This module reads the subject, works out the date it refers to (relative to when the
 * email was sent) and says whether that date is still to come.
 *
 * Only the subject is used, so it works on headers alone and never needs the body.
 */

export type TimelyKind = 'delivery' | 'appointment' | 'offer';

export interface Timely {
  kind: TimelyKind;
  /** The day the notice is about, local "YYYY-MM-DD". */
  due: string;
  /** True while `due` is today or later. */
  upcoming: boolean;
  /** Whole days since `due` (0 while upcoming). */
  daysPast: number;
  /** Short description, e.g. "delivery expected Sat 21 Nov". */
  label: string;
}

const DAY = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\.?';
const ORD = '(?:st|nd|rd|th)?';

const PROMO = /\b(sale|offers?|deals?|discount|coupon|promo(tion)?|voucher|\d+\s?% off|free (delivery|shipping)|don'?t miss|last chance|black friday|cyber monday)\b/i;
const OFFER_END = /\b(ends?|ending|expir\w*|last (day|chance)|until|closes?|closing|final (day|hours?)|only)\b/i;

const DELIVERY_NOUN = /\b(deliver(y|ies)|parcels?|packages?|shipments?|orders?|couriers?|items?)\b/i;
const DELIVERED = /\b(has been|have been|was|were|been|successfully) delivered\b|^delivered\b|\bdelivered[:!]/i;
const ATTENTION = /\b(ready (for|to) (pick ?-?up|collect(ion)?)|awaiting (pick ?-?up|collection)|attempted|missed (your )?delivery|could not be delivered|card left)\b/i;
const TODAY_WORDS = /\b(out for delivery|arriving today|delivered today)\b/i;
const IN_TRANSIT =
  /\b(coming|arriving|arrives?|arrive|expected|scheduled|estimated|due|on (its|the|their) way|out for delivery|in transit|shipped|dispatched|will be delivered|to be delivered|delivery (date|window|time))\b/i;

const APPOINTMENT =
  /\b(appointments?|reservations?|bookings?|webinars?|events?|meetings?|flights?|check-?in|consultations?|classes|class|sessions?|interviews?|concerts?|tickets?|reminder)\b/i;

/** Local "YYYY-MM-DD". */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function pretty(d: Date): string {
  return `${WEEKDAYS[d.getDay()].slice(0, 3).replace(/^./, (c) => c.toUpperCase())} ${d.getDate()} ${MONTHS[d.getMonth()].replace(/^./, (c) => c.toUpperCase())}`;
}

/**
 * Every date the subject mentions, resolved against the day it was sent.
 * Month/day without a year is taken as the next such day on or after (roughly) the sent date.
 */
export function datesIn(subject: string, sent: Date): Date[] {
  const s = subject.toLowerCase();
  const day0 = startOfDay(sent);
  const out: Date[] = [];

  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(s)) out.push(day0);
  if (/\btomorrow\b/.test(s)) out.push(addDays(day0, 1));
  for (const m of s.matchAll(/\bin (\d{1,2}) days?\b/g)) out.push(addDays(day0, Number(m[1])));
  if (/\bthis week(end)?\b/.test(s)) out.push(addDays(day0, (7 - day0.getDay()) % 7));
  if (/\bnext week\b/.test(s)) out.push(addDays(day0, ((7 - day0.getDay()) % 7) + 7));

  for (const m of s.matchAll(/\b(next )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g)) {
    const target = WEEKDAYS.indexOf(m[2]);
    let diff = (target - day0.getDay() + 7) % 7;
    // "next Monday" sent on a Monday means a week away; otherwise take the coming one.
    if (m[1] && diff === 0) diff = 7;
    out.push(addDays(day0, diff));
  }

  const withYear = (month: number, date: number, year?: number): Date | null => {
    if (month < 0 || date < 1 || date > 31) return null;
    if (year) return new Date(year, month, date);
    let d = new Date(day0.getFullYear(), month, date);
    // "Dec 28" in an email sent 2 Jan is last year's; "Jan 3" sent 28 Dec is next year's.
    if (d.getTime() < day0.getTime() - 60 * DAY) d = new Date(day0.getFullYear() + 1, month, date);
    else if (d.getTime() > day0.getTime() + 300 * DAY) d = new Date(day0.getFullYear() - 1, month, date);
    return d;
  };
  const monthIdx = (name: string) => MONTHS.indexOf(name.slice(0, 3));
  for (const m of s.matchAll(new RegExp(`\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?\\b`, 'g'))) {
    const d = withYear(monthIdx(m[2]), Number(m[1]), m[3] ? Number(m[3]) : undefined);
    if (d) out.push(d);
  }
  for (const m of s.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})${ORD}(?:,?\\s+(\\d{4}))?\\b`, 'g'))) {
    const d = withYear(monthIdx(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined);
    if (d) out.push(d);
  }
  for (const m of s.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const d = withYear(Number(m[2]) - 1, Number(m[3]), Number(m[1]));
    if (d) out.push(d);
  }
  return out.filter((d) => !Number.isNaN(d.getTime()));
}

/**
 * Works out whether a subject is a time-bound notice and, if so, which day it's about and whether that
 * day is still to come. Returns undefined for anything else (most mail).
 */
export function timelyInfo(subject: string, sentAt: Date | string | undefined, now: number = Date.now()): Timely | undefined {
  if (!subject || !sentAt) return undefined;
  const sent = new Date(sentAt);
  if (Number.isNaN(sent.getTime())) return undefined;
  const dates = datesIn(subject, sent);
  const latest = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : undefined;
  const sentDay = startOfDay(sent);

  let kind: TimelyKind | undefined;
  let due: Date | undefined;

  if (PROMO.test(subject)) {
    // Promotions only count when they have an end: "Sale ends tonight", "Offer expires 30 Nov".
    if (OFFER_END.test(subject) || latest) {
      kind = 'offer';
      due = latest ?? (/\b(last (day|chance)|final|tonight|today)\b/i.test(subject) ? sentDay : addDays(sentDay, 3));
    }
  } else if (DELIVERY_NOUN.test(subject) || /\b(out for delivery|shipped|dispatched|in transit)\b/i.test(subject)) {
    if (DELIVERED.test(subject) && !/\b(will|to) be delivered\b/i.test(subject)) {
      kind = 'delivery';
      due = sentDay; // Already arrived: nothing left to wait for.
    } else if (ATTENTION.test(subject)) {
      kind = 'delivery';
      due = latest ?? addDays(sentDay, 7); // Usually held for about a week.
    } else if (IN_TRANSIT.test(subject)) {
      kind = 'delivery';
      due = latest ?? (TODAY_WORDS.test(subject) ? sentDay : addDays(sentDay, 7));
    }
  } else if (APPOINTMENT.test(subject) && latest) {
    kind = 'appointment';
    due = latest;
  }
  if (!kind || !due) return undefined;

  const today = startOfDay(new Date(now));
  const upcoming = due.getTime() >= today.getTime();
  const daysPast = upcoming ? 0 : Math.round((today.getTime() - due.getTime()) / DAY);
  const when = pretty(due);
  const label =
    kind === 'delivery'
      ? upcoming
        ? `delivery expected ${when}`
        : `delivery was due ${ymd(due)}`
      : kind === 'appointment'
        ? upcoming
          ? `appointment/event on ${when}`
          : `appointment/event was on ${ymd(due)}`
        : upcoming
          ? `offer ends ${when}`
          : `offer ended ${ymd(due)}`;
  return { kind, due: ymd(due), upcoming, daysPast, label };
}

/** Kinds that matter until their date (deliveries, appointments). Offers never protect a sender. */
export function protects(t: Timely | undefined): boolean {
  return !!t && t.upcoming && t.kind !== 'offer';
}

/**
 * Extra junk score for notices whose date has passed: a little straight away, growing to the full amount
 * after about three months.
 */
export function staleBump(daysPast: number): number {
  return 0.1 + 0.2 * Math.min(1, Math.max(0, daysPast) / 90);
}
