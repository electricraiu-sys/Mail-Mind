import { describe, it, expect } from 'vitest';
import { executeAction, undo, getUndoLog, onQueueChange, pendingActions, type QueuePosition, type QueueSnapshot } from '../src/core/actions';
import { fakeMessenger, header, INBOX, RECEIPTS, TRASH } from './helpers';

describe('executeAction + undo', () => {
  it('overlapping actions queue up in order and every one lands in the undo log', async () => {
    const api = fakeMessenger([header({ id: 1 }), header({ id: 2 }), header({ id: 3 })]);
    const queued = new Set<string>();
    // Started together, as when the user clicks Delete on several senders in a row.
    const [a, b, c] = await Promise.all([
      executeAction('delete', [1], { onQueued: () => queued.add('a') }),
      executeAction('move', [2], { folderId: RECEIPTS.id, onQueued: () => queued.add('b') }),
      executeAction('delete', [3], { onQueued: () => queued.add('c') }),
    ]);
    expect([...queued].sort()).toEqual(['b', 'c']); // the first one never waits
    expect(api.calls.filter((x) => x.method === 'move').map((x) => x.args[0])).toEqual([[1], [2], [3]]);
    const log = (await getUndoLog()).map((e) => e.id);
    expect(log.slice(0, 3)).toEqual([c.entry.id, b.entry.id, a.entry.id]);
  });

  it('waiting actions learn how many actions and emails are ahead of them, and the queue reports totals', async () => {
    fakeMessenger([1, 2, 3, 4, 5, 6].map((id) => header({ id })));
    const positions: QueuePosition[] = [];
    const snaps: QueueSnapshot[] = [];
    const stop = onQueueChange((s) => snaps.push(s));
    await Promise.all([
      executeAction('mark_read', [1, 2, 3]),
      executeAction('mark_read', [4, 5]),
      executeAction('mark_read', [6], { onQueued: (p) => positions.push(p) }),
    ]);
    stop();
    expect(positions[0]).toEqual({ jobsAhead: 2, emailsAhead: 5 });
    expect(positions).toContainEqual({ jobsAhead: 1, emailsAhead: 2 });
    expect(positions.at(-1)).toEqual({ jobsAhead: 1, emailsAhead: 0 }); // the action ahead has just finished
    expect(Math.max(...snaps.map((s) => s.total))).toBe(6);
    expect(snaps.at(-1)).toMatchObject({ jobs: 0, total: 0, done: 0 });
    expect(pendingActions()).toBe(0);
  });

  it('a failed action does not block the ones queued behind it', async () => {
    fakeMessenger([header({ id: 4 })]);
    const bad = executeAction('move', [4]); // no folder → rejects
    const good = executeAction('mark_read', [4]);
    await expect(bad).rejects.toThrow(/destination/);
    expect((await good).entry.count).toBe(1);
  });

  it('delete moves to Trash (never permanent) and undo restores the original folder', async () => {
    const api = fakeMessenger([header({ id: 1 }), header({ id: 2 }), header({ id: 3, folder: TRASH })]);
    const { entry, skipped } = await executeAction('delete', [1, 2, 3]);

    expect(skipped).toBe(1); // already in Trash → skipped, not permanently deleted
    expect(api.calls.some((c) => c.method === 'delete')).toBe(false);
    expect(api.calls.find((c) => c.method === 'move')?.args[1]).toBe(TRASH.id);
    expect([...api.store.values()].filter((m) => m.folder?.id === TRASH.id)).toHaveLength(3);
    expect((await getUndoLog())[0].id).toBe(entry.id);

    const r = await undo(entry.id);
    expect(r).toEqual({ restored: 2, missing: 0 });
    const inInbox = [...api.store.values()].filter((m) => m.folder?.id === INBOX.id).map((m) => m.headerMessageId).sort();
    expect(inInbox).toEqual(['msg-1@example.com', 'msg-2@example.com']);
    expect((await getUndoLog())[0].undone).toBe(true);
  });

  it('move requires a folder and undo moves back', async () => {
    const api = fakeMessenger([header({ id: 5 })]);
    await expect(executeAction('move', [5])).rejects.toThrow(/destination/);
    const { entry } = await executeAction('move', [5], { folderId: RECEIPTS.id });
    expect([...api.store.values()][0].folder?.id).toBe(RECEIPTS.id);
    await undo(entry.id);
    expect([...api.store.values()][0].folder?.id).toBe(INBOX.id);
  });

  it('flag changes are undone by restoring previous state', async () => {
    const api = fakeMessenger([header({ id: 7, read: false, tags: ['$label1'] })]);
    const { entry } = await executeAction('tag', [7], { tag: 'later' });
    expect(api.store.get(7)!.tags).toEqual(['$label1', 'later']);
    await executeAction('mark_read', [7]);
    expect(api.store.get(7)!.read).toBe(true);
    await undo(entry.id);
    expect(api.store.get(7)!.tags).toEqual(['$label1']);
  });

  it('ignores unknown message ids', async () => {
    fakeMessenger([header({ id: 9 })]);
    const { entry, skipped } = await executeAction('mark_read', [9, 999]);
    expect(entry.count).toBe(1);
    expect(skipped).toBe(1);
  });
});
