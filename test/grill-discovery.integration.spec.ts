import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ProviderError } from '../src/contracts/provider-error.js';
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import { HUMAN } from './fixtures/github/payloads.js';
import {
  botComments,
  captureLogs,
  grillAnswer,
  grillRows,
  laneAdded,
} from './grill-helpers.js';
import {
  deliver,
  drainDueNow,
  removeDiscovery,
  seedDiscovery,
  seedIssue,
} from './router-helpers.js';

// Spec 11 "Testing strategy → Integration" (plan T19, P12): Grill Me runs with discovery through prepare() and
// call(), with no change in src/grill. The fake repo holds SD9-like content (seedDiscovery).

const MONEY = '.claude/skills/money-rules';
const GRILL_SKILL = '.github-agent/skills/grill/SKILL.md';
const MODEL_LINE = 'Model: `gemini-4-hydrogen` (standard)';
const LOAD_MONEY = {
  name: 'load_skill',
  args: { name: 'money-rules', reason: 'The issue splits 1000 cents.' },
};
const LOAD_SRC = {
  name: 'load_file',
  args: { path: 'src/AGENTS.md', reason: 'The split lives in src/.' },
};

describe('Grill Me with discovery (spec 11)', () => {
  let t: TestApp;
  let logs: string[];

  const loads = () =>
    t.prisma.contextLoad.findMany({
      orderBy: [{ createdAt: 'asc' }, { turn: 'asc' }],
    });
  const readsOf = (path: string) =>
    t.repo.calls.filter(
      ({ method, args }) => method === 'readFile' && args[1] === path,
    );

  beforeAll(async () => {
    t = await startApp({ grill: 'real' });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.models.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    seedDiscovery(t.repo);
    t.repo.calls.length = 0;
    logs = captureLogs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expect(t.models.remaining).toBe(0);
    // The shared fake repo goes back to spec 5's content for the next suite.
    removeDiscovery(t.repo);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('a run start whose model loads `money-rules`, then asks → one round comment with the "Read:" line; two start rows and one loaded row', async () => {
    const issue = seedIssue(t, 61, {
      labels: ['workflow: full-sdd'],
      description: 'Split a bill between three people.',
    });
    t.models
      .reply({ toolCalls: [LOAD_MONEY] })
      .replyJson(grillAnswer({ confidence: 60, questions: 2 }));

    const row = await deliver(t, laneAdded(61));

    expect(row).toMatchObject({ status: 'DONE' });
    const comments = botComments(t, issue);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(
      `<sub>${MODEL_LINE}</sub>\n<sub>Read: skill \`money-rules\` (\`SKILL.md\`)</sub>`,
    );
    expect(comments[0].body).not.toContain('PINEAPPLE');
    const { evaluations } = await grillRows(t);
    expect(evaluations).toMatchObject([
      {
        result: 'ASKED',
        notes: [MODEL_LINE, 'Read: skill `money-rules` (`SKILL.md`)'],
      },
    ]);

    // The first request offers the tools and lists money-rules and src/AGENTS.md; the second carries the load.
    expect(t.models.calls.map(({ tools }) => tools)).toEqual([
      ['load_skill', 'load_file'],
      ['load_skill', 'load_file'],
    ]);
    const system = t.models.calls[0].messages[0].text;
    expect(system).toContain('- money-rules: How this project stores');
    expect(system).toContain('- src/AGENTS.md (');
    expect(system).toContain('Amounts are integer cents');
    expect(system).not.toContain('CLAUDE.md');

    const rows = await loads();
    const run = await t.prisma.run.findFirstOrThrow();
    expect(
      rows.map(({ turn, trigger, kind, skill, path, outcome }) => ({
        turn,
        trigger,
        kind,
        skill,
        path,
        outcome,
      })),
    ).toEqual([
      {
        turn: 0,
        trigger: 'start',
        kind: 'step-skill',
        skill: 'grill',
        path: GRILL_SKILL,
        outcome: 'loaded',
      },
      {
        turn: 0,
        trigger: 'start',
        kind: 'agents',
        skill: null,
        path: 'AGENTS.md',
        outcome: 'loaded',
      },
      {
        turn: 1,
        trigger: 'tool',
        kind: 'repo-skill',
        skill: 'money-rules',
        path: `${MONEY}/SKILL.md`,
        outcome: 'loaded',
      },
    ]);
    expect(rows[2]).toMatchObject({
      runId: run.id,
      step: 'grill',
      tool: 'load_skill',
      requested: 'money-rules',
      reason: 'The issue splits 1000 cents.',
      chars: expect.any(Number) as number,
    });

    const requests = await t.prisma.executionLog.findMany({
      orderBy: { turn: 'asc' },
    });
    expect(
      requests.map(({ callId, turn, attempt, status }) => ({
        callId,
        turn,
        attempt,
        status,
      })),
    ).toEqual([
      { callId: rows[2].callId, turn: 1, attempt: 1, status: 'SUCCESS' },
      { callId: rows[2].callId, turn: 2, attempt: 1, status: 'SUCCESS' },
    ]);
    expect(requests[0].listsChars).toBeGreaterThan(0);
    expect(requests[1].loadedChars).toBeGreaterThan(0);
    expect(logs).toContain(
      `context grill #61 turn 1: load_skill money-rules → loaded (${rows[2].bytes?.toLocaleString('en-US')} bytes)`,
    );
  });

  it('an unknown skill → the looked-for line and a not-found row; CLAUDE.md → a not-found row, never read', async () => {
    const issue = seedIssue(t, 62, { labels: ['workflow: full-sdd'] });
    t.models
      .reply({
        toolCalls: [
          { name: 'load_skill', args: { name: 'tax-rules', reason: 'tax' } },
          { name: 'load_file', args: { path: 'CLAUDE.md', reason: 'rules' } },
        ],
      })
      .replyJson(grillAnswer({ confidence: 60, questions: 1 }));

    await deliver(t, laneAdded(62));

    const comments = botComments(t, issue);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(
      "<sub>The bot looked for skill `tax-rules`, which this repo doesn't have.</sub>",
    );
    expect(comments[0].body).not.toContain('Read:');
    expect(
      (await loads())
        .filter(({ trigger }) => trigger === 'tool')
        .map(({ requested, kind, path, outcome }) => ({
          requested,
          kind,
          path,
          outcome,
        })),
    ).toEqual([
      { requested: 'tax-rules', kind: null, path: null, outcome: 'not-found' },
      { requested: 'CLAUDE.md', kind: null, path: null, outcome: 'not-found' },
    ]);
    expect(readsOf('CLAUDE.md')).toEqual([]);
  });

  it('a ProviderError while loading src/AGENTS.md → an `error` row, the event retried, then a `loaded` row and one round comment (P21)', async () => {
    const issue = seedIssue(t, 63, { labels: ['workflow: full-sdd'] });
    t.models.reply({
      toolCalls: [LOAD_SRC],
      // The next GitHub call after this answer is the loader's read of src/AGENTS.md.
      during: () => {
        t.repo.failNext(
          new ProviderError('GitHub GET contents → 503', 'transient', {
            status: 503,
          }),
        );
        return Promise.resolve();
      },
    });

    const first = await deliver(t, laneAdded(63));

    expect(first).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(botComments(t, issue)).toEqual([]);
    expect((await loads()).map(({ outcome }) => outcome)).toEqual([
      'loaded',
      'loaded',
      'error',
    ]);
    expect((await loads())[2]).toMatchObject({
      path: 'src/AGENTS.md',
      chars: null,
      tokens: null,
    });
    expect(logs).toContain(
      'context grill #63 turn 1: load_file src/AGENTS.md → error (GitHub status 503)',
    );

    t.models
      .reply({ toolCalls: [LOAD_SRC] })
      .replyJson(grillAnswer({ confidence: 60, questions: 2 }));
    await drainDueNow(t);

    expect(
      await t.prisma.webhookEvent.findUniqueOrThrow({
        where: { id: first.id },
      }),
    ).toMatchObject({ status: 'DONE' });
    const comments = botComments(t, issue);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('<sub>Read: `src/AGENTS.md`</sub>');
    const rows = await loads();
    expect(
      rows
        .filter(({ trigger }) => trigger === 'tool')
        .map(({ outcome }) => outcome),
    ).toEqual(['error', 'loaded']);
    // The retried call is a new call: its own id and start rows.
    expect(new Set(rows.map(({ callId }) => callId)).size).toBe(2);
    expect(readsOf('src/AGENTS.md')).toHaveLength(2);
  });
});
