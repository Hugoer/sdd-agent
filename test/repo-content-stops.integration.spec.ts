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
import type { TaskRef } from '../src/contracts/issue-provider.js';
import { WORKFLOW_CONFIG_PATH } from '../src/llm/workflow-config.js';
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import { HUMAN } from './fixtures/github/payloads.js';
import { skillMd } from './fixtures/skills.js';
import {
  askedRound1,
  botComments,
  commented,
  grillRows,
  laneAdded,
} from './grill-helpers.js';
import {
  deliver,
  removeDiscovery,
  seedDiscovery,
  seedIssue,
  STEP_SKILL_FOLDERS,
} from './router-helpers.js';

// Spec 11 SDW2, SDW11, SD12 and plan P1: what in the repo stops a run, at run start and at a Grill step.

const MONEY = '.claude/skills/money-rules/SKILL.md';
const NO_DESC = '.claude/skills/no-desc/SKILL.md';

describe('the run stops for the repo content (spec 11)', () => {
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
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expect(t.models.remaining).toBe(0);
    // The shared fake repo goes back to spec 5's content for the next test.
    t.repo.removeFile('main', NO_DESC);
    removeDiscovery(t.repo);
  });
  afterAll(async () => {
    await t.app.close();
  });

  /** A new issue with `workflow: full-sdd`; returns it with the processed event's row. */
  async function startRun(number: number) {
    const issue = seedIssue(t, number, { labels: ['workflow: full-sdd'] });
    const row = await deliver(t, laneAdded(number));
    return { issue, row };
  }

  /** The one bot comment, a stop before the first step naming `reason`; the issue needs a human; no model call. */
  function expectStoppedAtStart(issue: TaskRef, reason: string): void {
    const comments = botComments(t, issue);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(
      `⚠️ **Run 1 stopped before its first step:** ${reason}. (\`step-config\`)`,
    );
    expect(t.issues.labelsOf(issue)).toContain('status: needs-human');
    expect(t.models.calls).toEqual([]);
  }

  it('SDW11: a repoSkills folder not in the tree → needs-human at run start, one comment, no question', async () => {
    t.repo.seedFile(
      'main',
      WORKFLOW_CONFIG_PATH,
      JSON.stringify({
        skills: Object.fromEntries(
          Object.entries(STEP_SKILL_FOLDERS).map(([step, folder]) => [
            step,
            `.github-agent/skills/${folder}`,
          ]),
        ),
        repoSkills: ['.claude/skill'],
        models: {
          standard: { default: 'gemini-4-hydrogen' },
          max: { default: 'gemini-4-carbon' },
        },
      }),
    );

    const { issue, row } = await startRun(61);

    const reason =
      'invalid workflow.json: repoSkills folder not found: .claude/skill';
    expect(row).toMatchObject({ status: 'FAILED', lastError: reason });
    expectStoppedAtStart(issue, reason);
  });

  it('SDW2: a root AGENTS.md over the cap → the same stop, naming the size and the limit', async () => {
    t.repo.seedFile('main', 'AGENTS.md', 'x'.repeat(204_801));

    const { issue } = await startRun(62);

    expectStoppedAtStart(
      issue,
      'AGENTS.md too large (204,801 bytes, limit 204,800)',
    );
  });

  it('SD12: a repo skill without description and a step skill named not as its folder → one comment naming both', async () => {
    t.repo.seedFile(
      'main',
      '.github-agent/skills/spec/SKILL.md',
      skillMd('specs', 'Placeholder spec.'),
    );
    t.repo.seedFile(
      'main',
      NO_DESC,
      '---\nname: no-desc\n---\nNo description.',
    );

    const { issue } = await startRun(63);

    expectStoppedAtStart(
      issue,
      'invalid skills: .github-agent/skills/spec/SKILL.md: name `specs` is not the folder name `spec`; ' +
        `${NO_DESC}: no description`,
    );
  });

  it('SD12: a broken repo skill merged while Grill Me waits → nothing posted until the next answer, then the stop', async () => {
    const issue = await askedRound1(t, 64);
    expect(botComments(t, issue)).toHaveLength(1);

    // Someone merges a change that removes money-rules' description: no event reaches the bot.
    t.repo.seedFile(
      'main',
      MONEY,
      '---\nname: money-rules\n---\n# Money rules',
    );
    expect(botComments(t, issue)).toHaveLength(1);

    const row = await deliver(t, commented(64, 6401, 'Q1: yes. Q2: no.'));

    const reason = `invalid skills: ${MONEY}: no description`;
    expect(row).toMatchObject({ status: 'FAILED', lastError: reason });
    const comments = botComments(t, issue);
    expect(comments).toHaveLength(2);
    expect(comments[1].body).toContain(
      `⚠️ **Run 1 stopped at step \`grill\`:** ${reason}. (\`step-config\`)`,
    );
    expect(t.issues.labelsOf(issue)).toContain('status: needs-human');
    // One model call (round 1); no new round.
    expect(t.models.calls).toHaveLength(1);
    expect((await grillRows(t)).rounds).toHaveLength(1);
  });
});
