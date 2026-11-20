import { describe, expect, it } from 'vitest';
import {
  approveSuggestion,
  cleanName,
  deleteCategory,
  discoverCategories,
  dismissSuggestion,
  getCategories,
  getMemberships,
  getSuggestions,
  MEMBERSHIP_TTL_MS,
  membersOf,
  placeSenders,
  setSenderCategory,
  similarName,
} from '../src/core/smartCategories';
import { groupBySender, scoreGroups } from '../src/core/triage';
import { runBackfillStep, runDiscoveryStep } from '../src/core/backfill';
import { fakeMessenger, header } from './helpers';

const senders = (prefix: string, n: number, subject: string, date?: Date) =>
  Array.from({ length: n }, (_, i) => header({ author: `${prefix} ${i} <${prefix.toLowerCase()}${i}@x${i}.example>`, subject, read: true, ...(date ? { date } : {}) }));

function groupsOf(headers: ReturnType<typeof header>[]) {
  const g = groupBySender(headers, ['me@home.test']);
  scoreGroups(g);
  return g;
}

/** Model that groups senders by the word in their address. */
function topicLlm(reply: (payload: any[]) => unknown) {
  const calls: string[] = [];
  return {
    calls,
    llm: {
      completeJson: async (system: string, user: string) => {
        calls.push(system);
        return reply(JSON.parse(user));
      },
    } as any,
  };
}

const school = (p: any[]) => p.filter((s) => s.sender.startsWith('school')).map((s) => s.i);

describe('discovering smart categories', () => {
  it('keeps real topics with enough senders and drops built-in types, tiny groups and duplicates', async () => {
    fakeMessenger([]);
    const g = groupsOf([...senders('School', 6, 'Term newsletter'), ...senders('Car', 3, 'Service due')]);
    const { llm } = topicLlm((p) => [
      { name: "Kids' school", description: 'School and PTA mail', senders: school(p) },
      { name: 'Newsletters', description: 'Generic', senders: school(p) }, // a built-in type
      { name: 'Car', description: 'Car stuff', senders: p.filter((s) => s.sender.startsWith('car')).map((s) => s.i) }, // only 3
      { name: 'Kids school', description: 'Same again', senders: school(p) }, // duplicate name
    ]);
    const fresh = await discoverCategories(llm, g);
    expect(fresh.map((s) => s.name)).toEqual(["Kids' school"]);
    expect(fresh[0].senders).toHaveLength(6);
    expect((await getSuggestions()).map((s) => s.name)).toEqual(["Kids' school"]);
  });

  it('never re-suggests a dismissed idea or one that already exists', async () => {
    fakeMessenger([]);
    const g = groupsOf(senders('School', 6, 'Term newsletter'));
    const { llm } = topicLlm((p) => [{ name: 'School', description: 'd', senders: school(p) }]);
    const [first] = await discoverCategories(llm, g);
    await dismissSuggestion(first.id);
    expect(await discoverCategories(llm, g)).toEqual([]);
  });

  it('cleans names that come from (untrusted) email content', () => {
    expect(cleanName('  <b>Car</b> "stuff"\n')).toBe('bCar/b stuff');
    expect(cleanName('x'.repeat(80))).toHaveLength(40);
    expect(similarName('Kids school', "Kids' Schools")).toBe(true);
    expect(similarName('Car', 'Cards')).toBe(false);
  });
});

describe('approving and editing', () => {
  it('creates the category with only the senders the user ticked, under the name they chose', async () => {
    fakeMessenger([]);
    const g = groupsOf(senders('School', 6, 'Term newsletter'));
    const [s] = await discoverCategories(topicLlm((p) => [{ name: 'School', description: 'd', senders: school(p) }]).llm, g);
    const keep = s.senders.slice(0, 4).map((x) => x.address);
    const cat = await approveSuggestion(s.id, { name: "Emma's school", addresses: keep });
    expect(cat!.name).toBe("Emma's school");
    expect((await membersOf(cat!.id)).sort()).toEqual([...keep].sort());
    expect(Object.values(await getMemberships()).every((m) => m.source === 'user')).toBe(true);
    expect(await getSuggestions()).toEqual([]);

    await deleteCategory(cat!.id);
    expect(await getCategories()).toEqual([]);
    expect(await getMemberships()).toEqual({});
  });
});

describe('placing senders', () => {
  async function withCategory() {
    fakeMessenger([]);
    const g = groupsOf(senders('School', 6, 'Term newsletter'));
    const [s] = await discoverCategories(topicLlm((p) => [{ name: 'School', description: 'd', senders: school(p) }]).llm, g);
    return (await approveSuggestion(s.id, { addresses: [s.senders[0].address] }))!;
  }

  it('places new senders, remembers "none", and never overrides the user', async () => {
    const cat = await withCategory();
    await setSenderCategory('school1@x1.example', null); // user: "not school"
    const g = groupsOf([...senders('School', 4, 'Sports day'), ...senders('Shop', 2, 'Hello')]);
    const asked: string[] = [];
    const llm = {
      completeJson: async (_s: string, user: string) => {
        const p = JSON.parse(user);
        asked.push(...p.map((x: any) => x.sender));
        return p.map((x: any) => ({ i: x.i, category: x.sender.startsWith('school') ? cat.id : 'none' }));
      },
    } as any;
    const placed = await placeSenders(llm, g);
    expect(asked.sort()).toEqual(['school2@x2.example', 'school3@x3.example', 'shop0@x0.example', 'shop1@x1.example']);
    expect(placed).toBe(2);
    const m = await getMemberships();
    expect(m['school1@x1.example']).toMatchObject({ id: null, source: 'user' });
    expect(m['school0@x0.example']).toMatchObject({ id: cat.id, source: 'user' });
    expect(m['shop0@x0.example']).toMatchObject({ id: null, source: 'ai' });

    // Asked again only once the AI's answers expire.
    asked.length = 0;
    await placeSenders(llm, g);
    expect(asked).toEqual([]);
    await placeSenders(llm, g, { now: Date.now() + MEMBERSHIP_TTL_MS + 1 });
    expect(asked.sort()).toEqual(['school2@x2.example', 'school3@x3.example', 'shop0@x0.example', 'shop1@x1.example']);
  });

  it('an unusable reply leaves senders for later instead of marking them "none"', async () => {
    await withCategory();
    const g = groupsOf(senders('Shop', 2, 'Hello'));
    await placeSenders({ completeJson: async () => null } as any, g);
    expect((await getMemberships())['shop0@x0.example']).toBeUndefined();
  });

  it('does nothing (and asks nothing) before any category exists', async () => {
    fakeMessenger([]);
    const { llm, calls } = topicLlm(() => []);
    expect(await placeSenders(llm, groupsOf(senders('Shop', 2, 'Hello')))).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('background work', () => {
  const now = new Date('2021-06-15T12:00:00').getTime();
  const june = new Date('2021-06-02T10:00:00');

  it('the month scan places senders in smart categories once their junk scores are done', async () => {
    fakeMessenger(senders('School', 6, 'Term newsletter', june));
    const g = groupsOf(senders('School', 6, 'Term newsletter', june));
    const [s] = await discoverCategories(topicLlm((p) => [{ name: 'School', description: 'd', senders: school(p) }]).llm, g);
    const cat = (await approveSuggestion(s.id, { addresses: [] }))!;
    const llm = {
      completeJson: async (system: string, user: string) => {
        const p = JSON.parse(user);
        if (system.includes('topic categories')) return p.map((x: any) => ({ i: x.i, category: cat.id }));
        return p.map((x: any) => ({ i: x.i, verdict: 'newsletter', confidence: 0.8, reason: 'r' }));
      },
    } as any;
    expect(await runBackfillStep({ llm, now, placeCategories: true })).toBe('scored'); // junk scores
    expect(await runBackfillStep({ llm, now, placeCategories: true })).toBe('scored'); // categories
    expect((await membersOf(cat.id)).length).toBe(6);
    expect(await runBackfillStep({ llm, now, placeCategories: true })).toBe('advanced');
  });

  it('weekly discovery runs once, then waits a week', async () => {
    fakeMessenger(senders('School', 6, 'Term newsletter', new Date(now - 10 * 86_400_000)));
    const { llm, calls } = topicLlm((p) => [{ name: 'School', description: 'd', senders: school(p) }]);
    expect(await runDiscoveryStep({ llm, now })).toBe(1);
    expect(await runDiscoveryStep({ llm, now: now + 86_400_000 })).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
