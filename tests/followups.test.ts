import { describe, it, expect } from 'vitest';
import { findFollowups, snoozeFollowup } from '../src/core/followups';
import type { LlmClient } from '../src/core/llm';
import { fakeMessenger, header, SENT, INBOX } from './helpers';

const NOW = new Date('2026-11-20T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function mailbox() {
  return [
    // Sent, no reply → waiting on them
    header({ id: 1, folder: SENT, author: 'Me <me@home.test>', recipients: ['Bob <bob@x.test>'], subject: 'Invoice?', date: daysAgo(10), headerMessageId: 's1@x' }),
    // Sent, Carol replied → not waiting
    header({ id: 2, folder: SENT, author: 'me@home.test', recipients: ['carol@x.test'], subject: 'Lunch', date: daysAgo(10), headerMessageId: 's2@x' }),
    header({ id: 3, folder: INBOX, author: 'Carol <carol@x.test>', subject: 'Re: Lunch', date: daysAgo(8) }),
    // Sent to an automated address → ignored
    header({ id: 4, folder: SENT, author: 'me@home.test', recipients: ['noreply@shop.test'], subject: 'Order', date: daysAgo(10) }),
    // Sent recently → too young
    header({ id: 5, folder: SENT, author: 'me@home.test', recipients: ['bob@x.test'], subject: 'Weekend', date: daysAgo(1) }),
    // Reply with a changed subject that references the sent message → not waiting
    header({ id: 6, folder: SENT, author: 'me@home.test', recipients: ['erin@x.test'], subject: 'Contract', date: daysAgo(9), headerMessageId: 's6@x' }),
    header({ id: 7, folder: INBOX, author: 'erin@x.test', subject: 'Signed copy attached', date: daysAgo(7) }),
    // Received from a contact, unanswered → waiting on me
    header({ id: 8, folder: INBOX, author: 'Carol <carol@x.test>', subject: 'Question about Friday', date: daysAgo(3), headerMessageId: 'r8@x' }),
    // Received from a stranger → not a follow-up
    header({ id: 9, folder: INBOX, author: 'dave@x.test', subject: 'Hello', date: daysAgo(3) }),
  ];
}

const opts = { days: 4, lookbackDays: 30, llm: null, now: NOW };

describe('findFollowups', () => {
  it('finds sent mail without a reply and received mail I have not answered', async () => {
    fakeMessenger(mailbox(), undefined, { rawHeaders: { 7: { 'in-reply-to': ['<s6@x>'] } } });
    const r = await findFollowups(opts);
    expect(r.waitingOnThem.map((i) => i.header.id)).toEqual([1]);
    expect(r.waitingOnThem[0].counterpart).toBe('bob@x.test');
    expect(r.waitingOnThem[0].ageDays).toBe(10);
    const me = r.waitingOnMe.map((i) => i.header.id);
    expect(me).toContain(8);
    expect(me).not.toContain(9);
  });

  it('hides snoozed items until the snooze ends', async () => {
    fakeMessenger(mailbox());
    await snoozeFollowup('s1@x', NOW.getTime() + 86_400_000);
    await snoozeFollowup('r8@x', Infinity);
    const r = await findFollowups(opts);
    expect(r.waitingOnThem.map((i) => i.header.id)).not.toContain(1);
    expect(r.waitingOnMe.map((i) => i.header.id)).not.toContain(8);
    const later = await findFollowups({ ...opts, now: new Date(NOW.getTime() + 2 * 86_400_000) });
    expect(later.waitingOnThem.map((i) => i.header.id)).toContain(1);
  });

  it('lets the AI drop emails that do not need an answer, keeping ones it skipped', async () => {
    fakeMessenger(mailbox());
    const llm = {
      completeJson: async (system: string, user: string) => {
        const items = JSON.parse(user) as { i: number; subject: string }[];
        // Sent mail: "no reply expected" for all. Received mail: the model skips every item.
        return /SENT/.test(system) ? items.map((x) => ({ i: x.i, yes: false })) : [];
      },
    } as unknown as LlmClient;
    const r = await findFollowups({ ...opts, llm });
    expect(r.aiUsed).toBe(true);
    expect(r.waitingOnThem).toEqual([]);
    expect(r.waitingOnMe.map((i) => i.header.id)).toContain(8); // not answered by the model → kept, not hidden
  });

  it('never changes mail', async () => {
    const api = fakeMessenger(mailbox());
    await findFollowups(opts);
    expect(api.calls.filter((c) => ['move', 'delete', 'archive', 'update'].includes(c.method))).toEqual([]);
  });
});
