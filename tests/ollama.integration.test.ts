/**
 * Optional live test against a local OpenAI-compatible server.
 * Run with:  MAILMIND_IT=1 npx vitest run tests/ollama.integration.test.ts
 * (MAILMIND_URL / MAILMIND_MODEL override the defaults.)
 */
import { describe, it, expect } from 'vitest';
import { LlmClient } from '../src/core/llm';
import { runAgent } from '../src/core/agent';
import { createTools, type ToolUi, type Proposal } from '../src/core/tools';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { chatSystemPrompt } from '../src/core/prompts';
import { groupBySender, scoreGroups, classifyWithAi } from '../src/core/triage';
import { extractEvents } from '../src/core/events';
import { findFollowups } from '../src/core/followups';
import { classifyForTag } from '../src/core/autotag';
import { fakeMessenger, header, SENT, INBOX } from './helpers';

const enabled = process.env.MAILMIND_IT === '1';
const llm = new LlmClient({
  baseUrl: process.env.MAILMIND_URL ?? 'http://localhost:11434/v1',
  model: process.env.MAILMIND_MODEL ?? 'gemma4:latest',
  temperature: 0.1,
});

describe.skipIf(!enabled)('live model', () => {
  it('classifies senders via JSON', async () => {
    const groups = groupBySender([
      ...Array.from({ length: 5 }, () => header({ author: 'Prize Center <winner@lucky-prize.biz>', subject: 'Congratulations! Claim your $1000 gift card now' })),
      ...Array.from({ length: 4 }, () => header({ author: 'Mom <mom@family.net>', subject: 'Sunday lunch', read: true })),
    ]);
    scoreGroups(groups);
    await classifyWithAi(llm, groups);
    const prize = groups.find((g) => g.address === 'winner@lucky-prize.biz')!;
    const mom = groups.find((g) => g.address === 'mom@family.net')!;
    console.log('AI verdicts:', groups.map((g) => `${g.address}=${g.verdict} (${g.source}: ${g.reason})`));
    expect(['junk', 'promo']).toContain(prize.verdict);
    expect(['personal', 'important']).toContain(mom.verdict);
  }, 180_000);

  it('runs the agent: search then propose a deletion (no direct changes)', async () => {
    const api = fakeMessenger([
      header({ id: 1, author: 'Prize Center <winner@lucky-prize.biz>', subject: 'You WON', date: new Date('2021-03-02') }),
      header({ id: 2, author: 'Prize Center <winner@lucky-prize.biz>', subject: 'Claim now', date: new Date('2021-04-02') }),
      header({ id: 3, author: 'Mom <mom@family.net>', subject: 'Lunch', date: new Date('2021-04-03'), read: true }),
    ]);
    const proposals: Proposal[] = [];
    const ui: ToolUi = {
      progress: () => {},
      showSenderReview: () => {},
      showProposal: (p) => proposals.push(p),
      showFiling: () => {},
      showRuleProposal: () => {},
      showFolderProposal: () => {},
      showDraft: () => {},
    showTopicResults: () => {},
    showAttachments: () => {},
    showEvents: () => {},
    showFollowups: () => {},
    showSubscriptions: () => {},
    showDigest: () => {},
    };
    const steps: string[] = [];
    const history = [{ role: 'user' as const, content: 'Find the emails from winner@lucky-prize.biz in 2021 and propose deleting them.' }];
    const r = await runAgent({
      llm,
      system: chatSystemPrompt({ today: new Date(), myAddresses: ['me@home.test'], accountNames: ['Home'], semanticSearch: false }),
      history,
      tools: createTools({ llm, settings: DEFAULT_SETTINGS, ui }),
      mode: 'native',
      events: { onToolStart: (n, a) => steps.push(`${n} ${JSON.stringify(a)}`), onModeSwitch: (m) => steps.push(`mode→${m}`) },
    });
    console.log('Steps:', steps, '\nMode:', r.mode, '\nFinal:', r.finalText);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals[0].kind).toBe('delete');
    expect(proposals[0].messages.map((m) => m.id).sort()).toEqual([1, 2]);
    expect(api.calls.filter((c) => ['move', 'delete', 'update', 'archive'].includes(c.method))).toEqual([]);
  }, 300_000);

  it('"find all emails about my stock trading and list all the attachments"', async () => {
    fakeMessenger(
      [
        header({ id: 1, author: 'Fidelity <alerts@fidelity.com>', subject: 'Trade confirmation: BUY 10 AAPL', date: new Date('2021-02-01') }),
        header({ id: 2, author: 'Fidelity <statements@fidelity.com>', subject: 'Your March brokerage statement is ready', date: new Date('2021-03-01') }),
        header({ id: 3, author: 'Robinhood <noreply@robinhood.com>', subject: 'Your order has been executed', date: new Date('2021-04-01') }),
        header({ id: 4, author: 'Shoe Shop <deals@shoes.example>', subject: 'Good news: your size is back in stock!', date: new Date('2021-05-01') }),
        header({ id: 5, author: 'Mom <mom@family.net>', subject: 'Lunch Sunday', date: new Date('2021-05-02') }),
        header({ id: 6, author: 'Grocery Mart <news@grocery.example>', subject: 'Stock up on summer essentials', date: new Date('2021-06-02') }),
      ],
      undefined,
      {
        bodies: { 2: 'Your portfolio, positions and dividend income for March.', 3: 'Your market order to buy 5 shares of TSLA was executed.' },
        attachments: {
          1: [{ name: 'trade-confirmation-0201.pdf', size: 52_000, contentType: 'application/pdf', partName: '1.2' }],
          2: [{ name: 'statement-2021-03.pdf', size: 210_000, contentType: 'application/pdf', partName: '1.2' }],
          4: [{ name: 'new-arrivals.jpg', size: 400_000, contentType: 'image/jpeg', partName: '1.2' }],
        },
      },
    );
    const shown: { hits?: number[]; files?: string[]; plan?: unknown } = {};
    const ui: ToolUi = {
      progress: () => {},
      showSenderReview: () => {},
      showProposal: () => {},
      showFiling: () => {},
      showRuleProposal: () => {},
      showFolderProposal: () => {},
      showDraft: () => {},
      showTopicResults: (r) => {
        shown.hits = r.hits.map((h) => h.header.id).sort();
        shown.plan = r.plan;
      },
      showAttachments: (rows) => (shown.files = rows.map((r) => r.name)),
      showEvents: () => {},
      showFollowups: () => {},
      showSubscriptions: () => {},
      showDigest: () => {},
    };
    const steps: string[] = [];
    const r = await runAgent({
      llm,
      system: chatSystemPrompt({ today: new Date(), myAddresses: ['me@home.test'], accountNames: ['Home'], semanticSearch: false }),
      history: [{ role: 'user', content: 'Search my emails and find all emails about my stock trading and list all the attachments' }],
      tools: createTools({ llm, settings: DEFAULT_SETTINGS, ui }),
      mode: 'native',
      events: { onToolStart: (n, a) => steps.push(`${n} ${JSON.stringify(a)}`) },
    });
    console.log('Steps:', steps, '\nPlan:', JSON.stringify(shown.plan), '\nHits:', shown.hits, '\nFiles:', shown.files, '\nFinal:', r.finalText);
    expect(steps[0]).toMatch(/^find_emails_about/);
    expect(shown.hits).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(shown.hits).not.toContain(4);
    expect(shown.hits).not.toContain(5);
    expect(shown.files).toEqual(expect.arrayContaining(['trade-confirmation-0201.pdf', 'statement-2021-03.pdf']));
  }, 300_000);

  it('extracts a meeting and a to-do with resolved dates', async () => {
    const r = await extractEvents(
      llm,
      "From: Dana <dana@work.test>\nSubject: Kick-off\n<<<EMAIL>>>\nHi! Let's do the project kick-off next Tuesday at 14:00 in Room 4B. Please send me the budget sheet by Friday.\n<<<END EMAIL>>>",
      new Date(2026, 10, 18, 9, 0), // Wednesday 18 Nov 2026
    );
    console.log('Extracted:', JSON.stringify(r));
    expect(r.events.length).toBeGreaterThanOrEqual(1);
    expect(r.events[0].start.startsWith('2026-11-24')).toBe(true);
    expect(r.tasks.some((t) => /budget/i.test(t.title))).toBe(true);
    expect(r.tasks.find((t) => /budget/i.test(t.title))?.due?.startsWith('2026-11-20')).toBe(true);
  }, 180_000);

  it('follow-up AI filter keeps a real question and drops a thank-you', async () => {
    const now = new Date('2026-11-20T12:00:00Z');
    const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
    fakeMessenger(
      [
        header({ id: 1, folder: SENT, author: 'me@home.test', recipients: ['bob@x.test'], subject: 'Quote for the roof', date: ago(8) }),
        header({ id: 2, folder: SENT, author: 'me@home.test', recipients: ['ann@x.test'], subject: 'Thanks!', date: ago(8) }),
        header({ id: 3, folder: INBOX, author: 'ann@x.test', subject: 'Photos', date: ago(20) }),
      ],
      undefined,
      { bodies: { 1: 'Hi Bob, could you send me the quote for the roof repair and say when you could start?', 2: 'Thanks a lot for the photos, Ann. Have a great weekend!' } },
    );
    const r = await findFollowups({ days: 4, lookbackDays: 30, llm, now });
    console.log('Waiting on them:', r.waitingOnThem.map((i) => `${i.header.subject} (${i.reason})`), r.aiError);
    expect(r.waitingOnThem.map((i) => i.header.id)).toEqual([1]);
  }, 180_000);

  it('auto-tags a receipt', async () => {
    const tag = await classifyForTag(llm, header({ author: 'Shop <orders@shop.test>', subject: 'Your order #1234 receipt' }), 'Thanks for your purchase. Total paid: $42.10. Order #1234.');
    expect(tag).toBe('mailmind_receipt');
  }, 120_000);
});
