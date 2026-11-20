import type { MessageHeader, MailFolder } from '../src/core/types';

export const INBOX: MailFolder = { id: 'acc1://INBOX', accountId: 'acc1', path: '/INBOX', name: 'Inbox', specialUse: ['inbox'] };
export const TRASH: MailFolder = { id: 'acc1://Trash', accountId: 'acc1', path: '/Trash', name: 'Trash', specialUse: ['trash'] };
export const SENT: MailFolder = { id: 'acc1://Sent', accountId: 'acc1', path: '/Sent', name: 'Sent', specialUse: ['sent'] };
export const RECEIPTS: MailFolder = { id: 'acc1://Receipts', accountId: 'acc1', path: '/Receipts', name: 'Receipts', specialUse: [] };

let nextId = 1;
export function header(p: Partial<MessageHeader> = {}): MessageHeader {
  const id = p.id ?? nextId++;
  return {
    id,
    date: new Date('2021-05-01T10:00:00Z'),
    author: 'Someone <someone@example.com>',
    subject: 'Hello',
    read: false,
    junk: false,
    junkScore: 0,
    flagged: false,
    tags: [],
    folder: INBOX,
    headerMessageId: `msg-${id}@example.com`,
    recipients: ['me@home.test'],
    ccList: [],
    bccList: [],
    size: 1000,
    ...p,
  };
}

/** In-memory fake of the parts of messenger.* that the core uses. */
export interface FakeAttachment {
  name: string;
  size: number;
  contentType: string;
  partName: string;
}

export function fakeMessenger(
  initial: MessageHeader[],
  folders: MailFolder[] = [INBOX, TRASH, SENT, RECEIPTS],
  extras: {
    bodies?: Record<number, string>;
    attachments?: Record<number, FakeAttachment[]>;
    rawHeaders?: Record<number, Record<string, string[]>>;
    tags?: { key: string; tag: string; color: string }[];
  } = {},
) {
  const store = new Map<number, MessageHeader>(initial.map((m) => [m.id, { ...m }]));
  const storage: Record<string, unknown> = {};
  const calls: { method: string; args: unknown[] }[] = [];
  let idCounter = 10000;
  const tagList = [...(extras.tags ?? [])];
  const log = (method: string, ...args: unknown[]) => calls.push({ method, args });

  const api = {
    calls,
    store,
    storage: {
      local: {
        get: async (key: string) => (key in storage ? { [key]: structuredClone(storage[key]) } : {}),
        set: async (obj: Record<string, unknown>) => Object.assign(storage, structuredClone(obj)),
        remove: async (key: string) => void delete storage[key],
      },
    },
    accounts: { list: async () => [{ id: 'acc1', name: 'Home', identities: [{ email: 'me@home.test' }] }] },
    folders: {
      query: async (q: any) => folders.filter((f) => (!q.accountId || f.accountId === q.accountId) && (!q.specialUse || q.specialUse.some((u: string) => f.specialUse?.includes(u)))),
    },
    messages: {
      get: async (id: number) => {
        const m = store.get(id);
        if (!m) throw new Error('not found');
        return { ...m };
      },
      query: async (q: any) => {
        const res = [...store.values()].filter((m) => {
          if (q.headerMessageId && m.headerMessageId !== q.headerMessageId) return false;
          if (q.folderId && m.folder?.id !== q.folderId) return false;
          if (q.author && !m.author.toLowerCase().includes(String(q.author).toLowerCase())) return false;
          if (q.subject && !m.subject.toLowerCase().includes(String(q.subject).toLowerCase())) return false;
          if (q.fullText) {
            const hay = `${m.subject} ${m.author} ${extras.bodies?.[m.id] ?? ''}`.toLowerCase();
            if (!hay.includes(String(q.fullText).toLowerCase())) return false;
          }
          if (q.attachment && !extras.attachments?.[m.id]?.length) return false;
          if (typeof q.read === 'boolean' && !!m.read !== q.read) return false;
          if (typeof q.flagged === 'boolean' && !!m.flagged !== q.flagged) return false;
          if (typeof q.junk === 'boolean' && !!m.junk !== q.junk) return false;
          if (q.fromDate && new Date(m.date) < q.fromDate) return false;
          if (q.toDate && new Date(m.date) > q.toDate) return false;
          return true;
        });
        return { id: null, messages: res.map((m) => ({ ...m })) };
      },
      continueList: async () => ({ id: null, messages: [] }),
      move: async (ids: number[], folderId: string) => {
        log('move', ids, folderId);
        const folder = folders.find((f) => f.id === folderId)!;
        for (const id of ids) {
          const m = store.get(id)!;
          store.delete(id);
          // Moving gives the message a new id, like real Thunderbird.
          const nid = idCounter++;
          store.set(nid, { ...m, id: nid, folder });
        }
      },
      delete: async (ids: number[], skipTrash: boolean) => log('delete', ids, skipTrash),
      archive: async (ids: number[]) => log('archive', ids),
      update: async (id: number, props: Record<string, unknown>) => {
        log('update', id, props);
        Object.assign(store.get(id)!, props);
      },
      getFull: async (id: number) => ({ headers: extras.rawHeaders?.[id] ?? {}, parts: [{ contentType: 'text/plain', body: extras.bodies?.[id] ?? '' }] }),
      listInlineTextParts: async (id: number) => [{ contentType: 'text/plain', content: extras.bodies?.[id] ?? '' }],
      tags: {
        list: async () => [...tagList],
        create: async (key: string, tag: string, color: string) => {
          log('tags.create', key, tag, color);
          tagList.push({ key, tag, color });
        },
      },
      listAttachments: async (id: number) => extras.attachments?.[id] ?? [],
      getAttachmentFile: async (id: number, partName: string) => {
        const a = extras.attachments?.[id]?.find((x) => x.partName === partName);
        if (!a) throw new Error('no attachment');
        return new Blob([`content of ${a.name}`], { type: a.contentType });
      },
    },
  };
  (globalThis as any).messenger = api;
  return api;
}
