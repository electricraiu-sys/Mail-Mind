import { describe, it, expect } from 'vitest';
import { parseListUnsubscribe, parseMailto, bestMethod, findSubscriptions, unsubscribe, isUnsafeToUnsubscribe, getUnsubscribed } from '../src/core/unsubscribe';
import { fakeMessenger, header } from './helpers';

describe('List-Unsubscribe parsing', () => {
  it('reads https and mailto targets and the one-click flag', () => {
    const info = parseListUnsubscribe({
      'list-unsubscribe': ['<mailto:leave@news.test?subject=Unsubscribe%20me>, <https://news.test/u?id=1>'],
      'list-unsubscribe-post': ['List-Unsubscribe=One-Click'],
    });
    expect(info).toEqual({ https: 'https://news.test/u?id=1', mailto: { to: 'leave@news.test', subject: 'Unsubscribe me', body: undefined }, oneClick: true });
    expect(bestMethod(info)).toBe('one-click');
  });

  it('falls back to web or email, and ignores plain http links', () => {
    expect(bestMethod(parseListUnsubscribe({ 'list-unsubscribe': ['<https://x.test/u>'] }))).toBe('web');
    expect(bestMethod(parseListUnsubscribe({ 'list-unsubscribe': ['<mailto:u@x.test>'] }))).toBe('email');
    expect(parseListUnsubscribe({ 'list-unsubscribe': ['<http://x.test/u>'] })).toBeNull();
    expect(parseListUnsubscribe({})).toBeNull();
    // One-click needs an https link.
    expect(parseListUnsubscribe({ 'list-unsubscribe': ['<mailto:u@x.test>'], 'list-unsubscribe-post': ['List-Unsubscribe=One-Click'] })?.oneClick).toBe(false);
  });

  it('rejects malformed mailto', () => {
    expect(parseMailto('mailto:not-an-address')).toBeNull();
    expect(parseMailto('mailto:a@b.test?BODY=stop')).toEqual({ to: 'a@b.test', subject: undefined, body: 'stop' });
  });
});

describe('findSubscriptions', () => {
  it('lists mailing-list senders, most unread first, and skips people', async () => {
    const msgs = [
      ...Array.from({ length: 6 }, (_, i) => header({ id: 100 + i, author: 'Deals <deals@shop.test>', subject: `Sale ${i}`, read: false })),
      ...Array.from({ length: 3 }, (_, i) => header({ id: 200 + i, author: 'Weekly <weekly@news.test>', subject: `Issue ${i}`, read: true })),
      header({ id: 300, author: 'Friend <friend@home.test>', subject: 'Dinner?' }),
    ];
    const raw: Record<number, Record<string, string[]>> = {};
    for (const m of msgs) {
      if (m.author.includes('shop')) raw[m.id] = { 'list-unsubscribe': ['<https://shop.test/u>'], 'list-unsubscribe-post': ['List-Unsubscribe=One-Click'] };
      if (m.author.includes('news')) raw[m.id] = { 'list-id': ['<weekly.news.test>'], 'list-unsubscribe': ['<mailto:off@news.test>'] };
    }
    fakeMessenger(msgs, undefined, { rawHeaders: raw });
    const r = await findSubscriptions({}, { now: new Date('2021-06-01') });
    expect(r.subscriptions.map((s) => s.address)).toEqual(['deals@shop.test', 'weekly@news.test']);
    expect(r.subscriptions[0]).toMatchObject({ count: 6, unread: 6, openRate: 0 });
    expect(r.subscriptions[0].messageIds).toHaveLength(6);
    expect(bestMethod(r.subscriptions[1].info)).toBe('email');
  });

  it('marks spam-looking senders as unsafe to unsubscribe from', () => {
    expect(isUnsafeToUnsubscribe({ verdict: 'junk' })).toBe(true);
    expect(isUnsafeToUnsubscribe({ verdict: 'newsletter' })).toBe(false);
  });
});

describe('unsubscribe', () => {
  const sub = { address: 'deals@shop.test', info: { https: 'https://shop.test/u?x=1', oneClick: true } };

  it('asks for permission before contacting the sender, and records the result', async () => {
    const api = fakeMessenger([]) as any;
    const order: string[] = [];
    api.permissions = { request: async (p: any) => (order.push(`perm ${p.origins[0]}`), true) };
    const fetchImpl = (async (url: string, init: any) => {
      order.push(`fetch ${url}`);
      expect(init.method).toBe('POST');
      expect(init.body).toBe('List-Unsubscribe=One-Click');
      expect(init.credentials).toBe('omit');
      return { ok: true, status: 200, type: 'basic' };
    }) as unknown as typeof fetch;
    const r = await unsubscribe(sub, 'one-click', fetchImpl);
    expect(r.ok).toBe(true);
    expect(order).toEqual(['perm https://shop.test/*', 'fetch https://shop.test/u?x=1']);
    expect(Object.keys(await getUnsubscribed())).toEqual(['deals@shop.test']);
  });

  it('does not contact the sender if permission is refused', async () => {
    const api = fakeMessenger([]) as any;
    api.permissions = { request: async () => false };
    let fetched = false;
    const r = await unsubscribe(sub, 'one-click', (async () => ((fetched = true), { ok: true })) as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(fetched).toBe(false);
    expect(await getUnsubscribed()).toEqual({});
  });

  it('opens a compose window for mailto (never sends by itself)', async () => {
    const api = fakeMessenger([]) as any;
    const composed: any[] = [];
    api.compose = { beginNew: async (d: any) => composed.push(d), sendMessage: async () => { throw new Error('must not send'); } };
    const r = await unsubscribe({ address: 'w@news.test', info: { mailto: { to: 'off@news.test' }, oneClick: false } }, 'email');
    expect(r.ok).toBe(true);
    expect(composed[0]).toMatchObject({ to: ['off@news.test'], subject: 'unsubscribe' });
  });
});
