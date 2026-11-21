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
  removeDiscovery,
  seedDiscovery,
  seedIssue,
} from './router-helpers.js';
import { testEnv } from './test-env.js';

// Spec 11 SD6 and SDW1 (plan T19, P13) with `SKILL_DISCOVERY_MAX_LOADS=1`: ConfigModule reads the environment
// when app.module.js is first imported, so the setting changes before this file's imports.
vi.hoisted(() => {
  process.env.SKILL_DISCOVERY_MAX_LOADS = '1';
});

const MODEL_LINE = 'Model: `gemini-4-hydrogen` (standard)';

describe('Grill Me at the load limit (spec 11, SKILL_DISCOVERY_MAX_LOADS=1)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp({ grill: 'real' });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.models.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    seedDiscovery(t.repo);
    captureLogs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expect(t.models.remaining).toBe(0);
    removeDiscovery(t.repo);
  });
  afterAll(async () => {
    await t.app.close();
    process.env.SKILL_DISCOVERY_MAX_LOADS = testEnv.SKILL_DISCOVERY_MAX_LOADS;
  });

  it('two requests in one answer → loaded, limit-reached; the next request has no tools; the round posted with the limit line', async () => {
    const issue = seedIssue(t, 71, { labels: ['workflow: full-sdd'] });
    t.models
      .reply({
        toolCalls: [
          {
            name: 'load_skill',
            args: { name: 'money-rules', reason: 'splits' },
          },
          {
            name: 'load_file',
            args: { path: 'src/AGENTS.md', reason: 'src' },
          },
        ],
      })
      .replyJson(grillAnswer({ confidence: 60, questions: 2 }));

    const row = await deliver(t, laneAdded(71));

    expect(row).toMatchObject({ status: 'DONE' });
    expect(t.models.calls[0].messages[0].text).toContain(
      'you may call load_skill and load_file, at most 1 time and 204,800 bytes in all for this answer.',
    );
    expect(t.models.calls.map(({ tools }) => tools)).toEqual([
      ['load_skill', 'load_file'],
      [],
    ]);
    expect(t.models.calls[1].messages.at(-1)?.text).toBe(
      'Limit reached: this answer may load at most 1 file and 204,800 bytes. Answer now with what you have.',
    );
    expect(
      (
        await t.prisma.contextLoad.findMany({
          where: { trigger: 'tool' },
          orderBy: { createdAt: 'asc' },
        })
      ).map(({ requested, outcome }) => [requested, outcome]),
    ).toEqual([
      ['money-rules', 'loaded'],
      ['src/AGENTS.md', 'limit-reached'],
    ]);
    const comments = botComments(t, issue);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('**Grill Me, round 1 of 5**');
    expect(comments[0].body).toContain(
      `<sub>${MODEL_LINE}</sub>\n` +
        '<sub>Read: skill `money-rules` (`SKILL.md`)</sub>\n' +
        '<sub>The bot reached its limit of 1 file for this answer.</sub>',
    );
    expect((await grillRows(t)).evaluations).toMatchObject([
      {
        result: 'ASKED',
        notes: [
          MODEL_LINE,
          'Read: skill `money-rules` (`SKILL.md`)',
          'The bot reached its limit of 1 file for this answer.',
        ],
      },
    ]);
  });
});
