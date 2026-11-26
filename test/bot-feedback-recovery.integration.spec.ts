import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
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
import { ProviderError } from '../src/contracts/provider-error.js';
import { StartupSweepService } from '../src/workflow/startup-sweep.service.js';
import {
  newDeliveryId,
  postWebhook,
  startApp,
  waitFor,
  type TestApp,
} from './app.js';
import { resetDatabase } from './db.js';
import { InMemoryIssueProvider } from './fakes/in-memory-issue-provider.js';
import { testEnv } from './test-env.js';

// Spec 13 (bot-feedback) after a restart: the migration's data rule (BFW11, plan FP11) and the startup sweep (BFW10,
// plan FP9, FP10, FP13, FP23).

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

describe('the startup sweep (spec 13 BFW10)', () => {
  let seed: TestApp;
  let issues: InMemoryIssueProvider;
  let number = 0;
  let logs: string[];

  beforeAll(async () => {
    seed = await startApp();
  });
  beforeEach(async () => {
    await resetDatabase(seed.prisma);
    issues = new InMemoryIssueProvider(testEnv.TARGET_REPO);
    logs = [];
    for (const method of ['log', 'error'] as const)
      vi.spyOn(Logger.prototype, method).mockImplementation((line) => {
        logs.push(String(line));
      });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await seed.app.close();
  });

  /** A task and its issue in the fake, with these labels; `status`, `shownStatus` and the mark as given. */
  async function task(options: {
    status?: string;
    shownStatus?: string | null;
    workingEventId?: string | null;
    labels?: string[];
    leaseOwner?: string;
  }): Promise<{ id: string; ref: TaskRef; tag: string }> {
    number++;
    const ref = issues.seedIssue({ number, labels: options.labels ?? [] });
    const row = await seed.prisma.task.create({
      data: {
        platform: 'GITHUB',
        platformId: ref.id,
        externalRef: ref.externalRef,
        status: options.status ?? 'spec-review',
        shownStatus:
          options.shownStatus === undefined
            ? (options.status ?? 'spec-review')
            : options.shownStatus,
        workingEventId: options.workingEventId ?? null,
        leaseOwner: options.leaseOwner ?? null,
        leaseExpiresAt: options.leaseOwner
          ? new Date(Date.now() + 60_000)
          : null,
      },
    });
    return { id: row.id, ref, tag: `#${number}` };
  }

  async function event(status: 'DONE' | 'FAILED' | 'PENDING' | 'PROCESSING') {
    return seed.prisma.webhookEvent.create({
      data: {
        deliveryId: newDeliveryId(),
        eventName: 'issue_comment',
        action: 'created',
        payload: {},
        status,
        // Not due: the manual worker never claims it here.
        availableAt: new Date(Date.now() + 3_600_000),
      },
    });
  }

  /** Boots the app on the seeded rows: the manual worker awaits the recovery hook (the sweep). */
  async function restart() {
    const t = await startApp({ keepData: true, issues });
    await t.app.close();
  }

  const markOf = async (id: string) =>
    (await seed.prisma.task.findUniqueOrThrow({ where: { id } }))
      .workingEventId;
  const summary = () =>
    logs.filter((line) => line.startsWith('startup sweep:'));

  it.each(['DONE', 'FAILED', 'gone'] as const)(
    'a mark on a %s event → bot: working removed, the mark cleared',
    async (status) => {
      const id = status === 'gone' ? randomUUID() : (await event(status)).id;
      const { id: taskId, ref } = await task({
        workingEventId: id,
        labels: ['status: spec-review', 'bot: working'],
      });

      await restart();

      expect(issues.labelsOf(ref)).toEqual(['status: spec-review']);
      expect(await markOf(taskId)).toBeNull();
      expect(summary()).toEqual([
        'startup sweep: 1 working label removed, 0 left for its event, 0 status labels repaired, 0 skipped (lease held), 0 failed',
      ]);
    },
  );

  it('a mark on a PENDING event → left (it runs again and ends it), one line', async () => {
    const pending = await event('PENDING');
    const { id, ref, tag } = await task({
      workingEventId: pending.id,
      labels: ['status: spec-review', 'bot: working'],
    });

    await restart();

    expect(issues.labelsOf(ref)).toContain('bot: working');
    expect(await markOf(id)).toBe(pending.id);
    expect(logs).toContain(
      `${tag} working label left for event ${pending.deliveryId} (pending)`,
    );
    expect(summary()[0]).toContain(
      '0 working labels removed, 1 left for its event',
    );
  });

  it('a status that differs from the label → the label set, shown_status updated; draft with no label → nothing', async () => {
    const { id, ref } = await task({
      status: 'plan-review',
      shownStatus: 'ready-for-dev',
      labels: ['status: ready-for-dev'],
    });
    const draft = await task({ status: 'draft', shownStatus: null });

    await restart();

    expect(issues.labelsOf(ref)).toEqual(['status: plan-review']);
    expect(
      (await seed.prisma.task.findUniqueOrThrow({ where: { id } })).shownStatus,
    ).toBe('plan-review');
    expect(issues.labelsOf(draft.ref)).toEqual([]);
    expect(issues.calls.filter(({ args }) => args[0] === draft.ref)).toEqual(
      [],
    );
    expect(summary()).toEqual([
      'startup sweep: 0 working labels removed, 0 left for its event, 1 status label repaired, 0 skipped (lease held), 0 failed',
    ]);
  });

  it('a lease held by a PROCESSING event (a live job) → skipped; one held by a PENDING event (after kill -9) → taken', async () => {
    // Booted first (nothing to sweep yet), then called directly: at boot the worker resets every PROCESSING row.
    const t = await startApp({ keepData: true, issues });
    const live = await event('PROCESSING');
    const dead = await event('PENDING');
    const held = await task({
      status: 'plan-review',
      shownStatus: 'ready-for-dev',
      labels: ['status: ready-for-dev'],
      leaseOwner: live.id,
    });
    const free = await task({
      status: 'plan-review',
      shownStatus: 'ready-for-dev',
      labels: ['status: ready-for-dev'],
      leaseOwner: dead.id,
    });

    logs.length = 0;
    try {
      await t.app.get(StartupSweepService).sweep();
    } finally {
      await t.app.close();
    }

    expect(issues.labelsOf(held.ref)).toEqual(['status: ready-for-dev']);
    expect(issues.labelsOf(free.ref)).toEqual(['status: plan-review']);
    expect(logs).toContain(
      `${held.tag} skipped by the startup sweep (lease held)`,
    );
    expect(summary()).toEqual([
      'startup sweep: 0 working labels removed, 0 left for its event, 1 status label repaired, 1 skipped (lease held), 0 failed',
    ]);
    const lease = await seed.prisma.task.findUniqueOrThrow({
      where: { id: free.id },
    });
    expect(lease).toMatchObject({ leaseOwner: null, leaseExpiresAt: null });
  });

  it('setWorkingLabel failing for one task → one line, the mark stays, the other task still done', async () => {
    const done = await event('DONE');
    const first = await task({
      workingEventId: done.id,
      labels: ['status: spec-review', 'bot: working'],
    });
    const second = await task({
      workingEventId: done.id,
      labels: ['status: spec-review', 'bot: working'],
    });
    issues.failNextOn(
      'setWorkingLabel',
      new ProviderError('GitHub unreachable', 'transient'),
    );

    await restart();

    expect(await markOf(first.id)).toBe(done.id);
    expect(issues.labelsOf(first.ref)).toContain('bot: working');
    expect(await markOf(second.id)).toBeNull();
    expect(issues.labelsOf(second.ref)).toEqual(['status: spec-review']);
    expect(logs).toContain(
      `${first.tag} startup sweep failed: GitHub unreachable`,
    );
    expect(summary()).toEqual([
      'startup sweep: 1 working label removed, 0 left for its event, 0 status labels repaired, 0 skipped (lease held), 1 failed',
    ]);
  });

  it('with the polling worker (FP23): the webhook endpoint answers while the sweep runs; the stored event is claimed only after it', async () => {
    const { ref } = await task({
      status: 'plan-review',
      shownStatus: 'ready-for-dev',
      labels: ['status: ready-for-dev'],
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const setStatusLabel = issues.setStatusLabel.bind(issues);
    vi.spyOn(issues, 'setStatusLabel').mockImplementation(async (...args) => {
      await held;
      return setStatusLabel(...args);
    });

    const t = await startApp({ keepData: true, issues, pollingWorker: true });
    try {
      const deliveryId = newDeliveryId();
      const res = await postWebhook(t.baseUrl, '{"zen":"Hi"}', {
        'x-github-event': 'ping',
        'x-github-delivery': deliveryId,
      });
      expect(res.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(
        await t.prisma.webhookEvent.findUniqueOrThrow({
          where: { deliveryId },
        }),
      ).toMatchObject({ status: 'PENDING', attempts: 0 });

      release();
      await waitFor(() =>
        t.prisma.webhookEvent.findFirst({
          where: { deliveryId, status: { not: 'PENDING' } },
        }),
      );
      expect(issues.labelsOf(ref)).toEqual(['status: plan-review']);
      const sweepEnd = logs.findIndex((line) =>
        line.startsWith('startup sweep:'),
      );
      const claimed = logs.findIndex(
        (line) =>
          line.includes(`delivery=${deliveryId} event=ping`) &&
          /(DONE|IGNORED)/.test(line),
      );
      expect(sweepEnd).toBeGreaterThanOrEqual(0);
      expect(claimed).toBeGreaterThan(sweepEnd);
    } finally {
      release();
      await t.app.close();
    }
  });
});
