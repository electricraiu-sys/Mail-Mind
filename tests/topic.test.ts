import { describe, it, expect } from 'vitest';
import { crc32 as nodeCrc32 } from 'node:zlib';
import { findAbout, cleanPlan, fallbackPlan } from '../src/core/topic';
import { collectAttachments, summarizeAttachments, categoryOf, isSmallInlineImage, uniqueNames } from '../src/core/attachments';
import { makeZip, crc32 } from '../src/core/zip';
import { createTools, getResultSet, type ToolUi } from '../src/core/tools';
import { runAgent } from '../src/core/agent';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import type { LlmClient, ChatMessage } from '../src/core/llm';
import { fakeMessenger, header, TRASH } from './helpers';

/** A fake model: expands the topic, and in verification drops shop "in stock" promos. */
function topicLlm() {
  return {
    completeJson: async (system: string, user: string) => {
      if (system.includes('turn a topic into email search terms')) {
        return { keywords: ['stock', 'trade confirmation', 'dividend'], senders: ['fidelity.com'] };
      }
      if (system.includes('really about a topic')) {
        const emails = JSON.parse(user.slice(user.indexOf('Emails: ') + 8));
        return { relevant: emails.filter((e: any) => !/back in stock/i.test(e.subject)).map((e: any) => e.i) };
      }
      return null;
    },
  } as unknown as LlmClient;
}

function mailbox() {
  const msgs = [
    header({ id: 1, author: 'Fidelity <alerts@fidelity.com>', subject: 'Trade confirmation: BUY 10 AAPL', date: new Date('2021-02-01') }),
    header({ id: 2, author: 'Fidelity <alerts@fidelity.com>', subject: 'Your monthly statement', date: new Date('2021-03-01') }),
    header({ id: 3, author: 'Broker Bob <bob@broker.example>', subject: 'Re: dividend question', date: new Date('2021-04-01') }),
    header({ id: 4, author: 'Shoe Shop <deals@shoes.example>', subject: 'Your size is back in stock!', date: new Date('2021-05-01') }),
    header({ id: 5, author: 'Mom <mom@family.net>', subject: 'Lunch Sunday', date: new Date('2021-05-02') }),
    header({ id: 6, author: 'Fidelity <alerts@fidelity.com>', subject: 'Old trade confirmation', folder: TRASH }),
  ];
  return fakeMessenger(msgs, undefined, {
    bodies: { 2: 'Your stock positions and dividend income', 3: 'about the dividend payout' },
    attachments: {
      1: [{ name: 'confirm_0201.pdf', size: 52_000, contentType: 'application/pdf', partName: '1.2' }],
      2: [
        { name: 'statement-march.pdf', size: 210_000, contentType: 'application/pdf', partName: '1.2' },
        { name: 'image001.png', size: 4_000, contentType: 'image/png', partName: '1.3' },
      ],
      3: [{ name: 'positions.xlsx', size: 18_000, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', partName: '1.2' }],
    },
  });
}

describe('findAbout', () => {
  it('expands the topic, searches every term, merges and drops off-topic hits', async () => {
    mailbox();
    const r = await findAbout('my stock trading', {}, { llm: topicLlm() });
    const ids = r.hits.map((h) => h.header.id).sort();
    expect(ids).toEqual([1, 2, 3]); // shoe promo removed by AI, Mom never matched, Trash excluded
    expect(r.candidates).toBe(4);
    expect(r.verified).toBe(true);
    const statement = r.hits.find((h) => h.header.id === 2)!;
    expect(statement.matched).toEqual(expect.arrayContaining(['"stock"', '"dividend"', 'from fidelity.com']));
  });

  it('works without an AI using the topic words', async () => {
    mailbox();
    const r = await findAbout('stock', {}, { llm: null });
    expect(r.verified).toBe(false);
    expect(r.hits.map((h) => h.header.id).sort()).toEqual([2, 4]);
  });

  it('handles well over 600 matches, checks them in parallel, and skips the AI for clear matches', async () => {
    const msgs = [];
    for (let i = 1; i <= 1500; i++) {
      const fromBroker = i <= 300; // from fidelity.com AND subject has "stock" → clear match
      msgs.push(
        header({
          id: i,
          author: fromBroker ? 'Fidelity <alerts@fidelity.com>' : `Shop ${i} <deals@shop${i}.example>`,
          subject: fromBroker ? `stock order ${i}` : i % 2 ? `stock update ${i}` : `Item ${i} back in stock`,
          date: new Date(2020, 0, 1 + (i % 365)),
        }),
      );
    }
    fakeMessenger(msgs);
    const base = topicLlm() as any;
    const verify = base.completeJson;
    let inFlight = 0;
    let peak = 0;
    let checked = 0;
    const llm = {
      completeJson: async (system: string, user: string, opts: any) => {
        if (!system.includes('really about a topic')) return verify(system, user, opts);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        checked += JSON.parse(user.slice(user.indexOf('Emails: ') + 8)).length;
        return verify(system, user, opts);
      },
    } as unknown as LlmClient;
    const r = await findAbout('my stock trading', {}, { llm });
    expect(r.capped).toBe(false);
    expect(r.candidates).toBe(1500);
    expect(checked).toBe(1200); // the 300 clear Fidelity matches never went to the AI
    expect(peak).toBeGreaterThan(1);
    expect(r.hits.length).toBe(300 + 600); // clear matches + odd-numbered "stock update"s
    const dates = r.hits.map((h) => new Date(h.header.date).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });

  it('cleans model plans and falls back sensibly', () => {
    expect(cleanPlan({ keywords: ['stock', 'stock', ' ', 'x'.repeat(80)], senders: 'nope' }, 'stock')).toEqual({ keywords: ['stock'], senders: [] });
    expect(fallbackPlan('my stock trading').keywords).toEqual(['my stock trading', 'stock', 'trading']);
  });
});

describe('attachments', () => {
  it('collects attachments, hides inline logos in the summary', async () => {
    mailbox();
    const rows = await collectAttachments([1, 2, 3]);
    expect(rows.map((r) => r.name)).toEqual(['positions.xlsx', 'image001.png', 'statement-march.pdf', 'confirm_0201.pdf']);
    const text = summarizeAttachments(rows);
    expect(text).toMatch(/^3 attachments .* in 3 emails; 1 small inline images\/logos hidden/);
    expect(text).toContain('statement-march.pdf');
    expect(text).not.toContain('image001.png');
  });

  it('categorises files', () => {
    expect(categoryOf('application/pdf', 'a.pdf')).toBe('pdf');
    expect(categoryOf('application/octet-stream', 'Book1.XLSX')).toBe('spreadsheet');
    expect(categoryOf('image/jpeg', 'photo.jpg')).toBe('image');
    expect(categoryOf('application/msword', 'letter.doc')).toBe('document');
    expect(isSmallInlineImage({ contentType: 'image/png', name: 'photo.png', size: 2_000_000 })).toBe(false);
    expect(isSmallInlineImage({ contentType: 'image/png', name: 'image001.png', size: 90_000 })).toBe(true);
  });

  it('makes zip file names unique', () => {
    expect(uniqueNames(['a.pdf', 'A.pdf', 'b', 'b', 'x/y.pdf'])).toEqual(['a.pdf', 'A (2).pdf', 'b', 'b (2)', 'x_y.pdf']);
  });
});

describe('makeZip', () => {
  it('writes a valid stored zip', () => {
    const data = new TextEncoder().encode('hello zip');
    expect(crc32(data)).toBe(nodeCrc32(Buffer.from(data)) >>> 0);
    const zip = Buffer.from(makeZip([{ name: 'ä.txt', data }, { name: 'b.txt', data: new Uint8Array([1, 2, 3]) }]));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const nameLen = zip.readUInt16LE(26);
    expect(zip.subarray(30, 30 + nameLen).toString('utf8')).toBe('ä.txt');
    expect(zip.subarray(30 + nameLen, 30 + nameLen + data.length).toString()).toBe('hello zip');
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(2);
  });
});

describe('the stock-trading request end to end (scripted model)', () => {
  it('one tool call finds the emails and lists their attachments; follow-ups use the result set', async () => {
    const api = mailbox();
    const shown: { topic?: number; attachments?: string[] } = {};
    const ui: ToolUi = {
      progress: () => {},
      showSenderReview: () => {},
      showProposal: () => {},
      showFiling: () => {},
      showRuleProposal: () => {},
      showFolderProposal: () => {},
      showDraft: () => {},
      showTopicResults: (r) => (shown.topic = r.hits.length),
      showAttachments: (rows) => (shown.attachments = rows.map((r) => r.name)),
      showEvents: () => {},
      showFollowups: () => {},
      showSubscriptions: () => {},
      showDigest: () => {},
    };
    const helper = topicLlm() as any;
    const script = [
      { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'find_emails_about', arguments: '{"topic":"my stock trading","listAttachments":true}' } }] },
      { content: 'I found 3 emails about your stock trading with 3 attachments.', toolCalls: [] },
    ];
    helper.chat = async () => script.shift();
    const history: ChatMessage[] = [{ role: 'user', content: 'Search my emails and find all emails about my stock trading and list all the attachments' }];
    await runAgent({ llm: helper, system: 's', history, tools: createTools({ llm: helper, settings: DEFAULT_SETTINGS, ui }), mode: 'native' });

    expect(shown.topic).toBe(3);
    expect(shown.attachments).toContain('statement-march.pdf');
    const toolResult = history.find((m) => m.role === 'tool')!.content!;
    expect(toolResult).toMatch(/Found 3 emails about "my stock trading" \(resultSetId "rs\d+"\)/);
    expect(toolResult).toContain('3 attachments');
    const rs = toolResult.match(/resultSetId "(rs\d+)"/)![1];
    expect(getResultSet(rs)!.ids.sort()).toEqual([1, 2, 3]);
    expect(api.calls).toEqual([]); // nothing modified
  });
});

describe('slow Thunderbird searches', () => {
  /** Body (fullText) queries never finish, like a huge IMAP mailbox still syncing. */
  function hangingBodySearch() {
    const api = mailbox();
    const m = (globalThis as any).messenger.messages;
    const realQuery = m.query;
    const aborted: string[] = [];
    m.query = async (q: any) => (q.fullText ? 'slow-list' : realQuery(q));
    m.continueList = (id: string) => (id === 'slow-list' ? new Promise(() => {}) : Promise.resolve({ id: null, messages: [] }));
    m.abortList = async (id: string) => void aborted.push(id);
    return { api, aborted };
  }

  it('keeps subject/sender matches when the body search hits its time budget', async () => {
    const { aborted } = hangingBodySearch();
    const r = await findAbout('my stock trading', {}, { llm: topicLlm(), bodyBudgetMs: 50 });
    expect(r.hits.map((h) => h.header.id).sort()).toEqual([1, 2, 3]); // 2 via sender, 3 via subject
    expect(r.bodySearch).toEqual({ terms: ['stock', 'trade confirmation', 'dividend'], complete: false });
    expect(aborted).toContain('slow-list');
  });

  it('Stop cancels a search that is still running', async () => {
    const { aborted } = hangingBodySearch();
    const ctl = new AbortController();
    const run = findAbout('my stock trading', {}, { llm: topicLlm(), signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toContain('slow-list');
  });
});
