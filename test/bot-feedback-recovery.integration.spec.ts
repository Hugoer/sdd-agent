import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';

// Spec 13 (bot-feedback) after a restart: the migration's data rule (BFW11, plan FP11); T8 adds the startup sweep.

const MIGRATIONS = 'prisma/migrations';
const DATA_MARKER = '-- Data (spec 13 BFW11';

/** The migration's data statements (after its marker), as `prisma migrate` runs them. */
function dataStatements(): string[] {
  const folder = readdirSync(MIGRATIONS).find((name) =>
    name.endsWith('_bot_feedback'),
  );
  if (!folder) throw new Error('no _bot_feedback migration');
  const sql = readFileSync(`${MIGRATIONS}/${folder}/migration.sql`, 'utf8');
  const data = sql.slice(sql.indexOf(DATA_MARKER));
  if (!data.startsWith(DATA_MARKER)) throw new Error('no data marker');
  return data
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

describe('the migration of spec 13 (BFW11, plan FP11)', () => {
  let t: TestApp;
  let issue = 0;

  beforeAll(async () => {
    t = await startApp();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
  });
  afterAll(async () => {
    await t.app.close();
  });

  type Plan = 'unapproved' | 'approved' | 'unapproved-superseded-by-approved';

  /** A task with its current run in `lane`, in `status`, with the Plan rows `plan` describes. */
  async function seeded(options: {
    lane: string;
    status: string;
    statusBeforeStop?: string;
    plan?: Plan;
  }): Promise<string> {
    issue++;
    const task = await t.prisma.task.create({
      data: {
        platform: 'GITHUB',
        platformId: String(1000 + issue),
        externalRef: `o/r#${issue}`,
        status: options.status,
        shownStatus:
          options.status === 'needs-human' ? 'needs-human' : 'ready-for-dev',
      },
    });
    const run = await t.prisma.run.create({
      data: {
        taskId: task.id,
        number: 1,
        lane: options.lane,
        grillSkip: true,
        startEventId: randomUUID(),
        startEventReceivedAt: new Date(),
        statusBeforeStop: options.statusBeforeStop ?? null,
        stoppedAt: options.statusBeforeStop ? new Date() : null,
      },
    });
    await t.prisma.task.update({
      where: { id: task.id },
      data: { currentRunId: run.id },
    });
    const doc = (version: number, data: object) =>
      t.prisma.taskDocument.create({
        data: {
          taskId: task.id,
          runId: run.id,
          kind: 'plan',
          version,
          origin: 'written',
          text: `plan v${version}`,
          body: `plan v${version}`,
          postState: 'POSTED',
          ...data,
        },
      });
    const approved = { approvedAt: new Date(), approvedBy: 'bob' };
    if (options.plan === 'unapproved') await doc(1, {});
    if (options.plan === 'approved') await doc(1, approved);
    if (options.plan === 'unapproved-superseded-by-approved') {
      await doc(1, {
        supersededAt: new Date(),
        createdAt: new Date(Date.now() - 60_000),
      });
      await doc(2, approved);
    }
    return task.id;
  }

  async function migrate() {
    for (const statement of dataStatements())
      await t.prisma.$executeRawUnsafe(statement);
  }

  const read = async (taskId: string) => {
    const task = await t.prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      include: { currentRun: true },
    });
    return {
      status: task.status,
      shownStatus: task.shownStatus,
      statusBeforeStop: task.currentRun?.statusBeforeStop ?? null,
    };
  };

  it('has two data statements after its marker', () => {
    expect(dataStatements()).toHaveLength(2);
  });

  it('full-sdd in ready-for-dev with an unapproved current Plan → plan-review; shown_status untouched', async () => {
    const id = await seeded({
      lane: 'full-sdd',
      status: 'ready-for-dev',
      plan: 'unapproved',
    });

    await migrate();

    expect(await read(id)).toEqual({
      status: 'plan-review',
      shownStatus: 'ready-for-dev',
      statusBeforeStop: null,
    });
  });

  it.each<[string, Parameters<typeof seeded>[0]]>([
    [
      'an approved Plan',
      { lane: 'full-sdd', status: 'ready-for-dev', plan: 'approved' },
    ],
    [
      'an unapproved Plan superseded by an approved one',
      {
        lane: 'full-sdd',
        status: 'ready-for-dev',
        plan: 'unapproved-superseded-by-approved',
      },
    ],
    ['no Plan row', { lane: 'full-sdd', status: 'ready-for-dev' }],
    ['code-only', { lane: 'code-only', status: 'ready-for-dev' }],
    [
      'spec-code',
      { lane: 'spec-code', status: 'ready-for-dev', plan: 'unapproved' },
    ],
    [
      'full-sdd in spec-review',
      { lane: 'full-sdd', status: 'spec-review', plan: 'unapproved' },
    ],
  ])('unchanged: %s', async (_name, options) => {
    const id = await seeded(options);
    const before = await read(id);

    await migrate();

    expect(await read(id)).toEqual(before);
  });

  it('a stopped full-sdd run whose status before the stop is ready-for-dev, Plan unapproved → plan-review', async () => {
    const id = await seeded({
      lane: 'full-sdd',
      status: 'needs-human',
      statusBeforeStop: 'ready-for-dev',
      plan: 'unapproved',
    });
    const approved = await seeded({
      lane: 'full-sdd',
      status: 'needs-human',
      statusBeforeStop: 'ready-for-dev',
      plan: 'approved',
    });

    await migrate();

    expect(await read(id)).toEqual({
      status: 'needs-human',
      shownStatus: 'needs-human',
      statusBeforeStop: 'plan-review',
    });
    expect((await read(approved)).statusBeforeStop).toBe('ready-for-dev');
  });
});
