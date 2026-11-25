import { ConfigService } from '@nestjs/config';
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
import type { Env } from '../src/config/env.schema.js';
import { EventsService } from '../src/events/events.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RunService } from '../src/workflow/run.service.js';
import {
  SessionLeaseService,
  type HeldLease,
} from '../src/workflow/session-lease.service.js';
import { TaskService } from '../src/workflow/task.service.js';
import { LeaseLostError } from '../src/workflow/workflow-errors.js';
import { newDeliveryId } from './app.js';
import { resetDatabase } from './db.js';
import { testScanner } from './fakes/in-memory-context-loads.js';
import { testEnv } from './test-env.js';

// Spec 5 "Owned tables" through their only writers, under the lease (plan T10).

const OTHER_EVENT = '00000000-0000-4000-8000-0000000000ff';

/** An EventsService whose requeue writes, then fails: the /retry transaction must roll back as a whole. */
class FailingRequeue extends EventsService {
  override async requeue(
    eventId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await super.requeue(eventId, tx);
    throw new Error('requeue broke after its write');
  }
}

describe('TaskService and RunService (PostgreSQL)', () => {
  let prisma: PrismaService;
  let leases: SessionLeaseService;
  let tasks: TaskService;
  let runs: RunService;
  let lease: HeldLease;

  const ref = {
    platform: 'GITHUB' as const,
    id: '1012',
    externalRef: 'o/r#12',
  };
  const event = (data: Partial<Prisma.WebhookEventCreateInput> = {}) =>
    prisma.webhookEvent.create({
      data: {
        deliveryId: newDeliveryId(),
        eventName: 'issues',
        action: 'labeled',
        payload: {},
        ...data,
      },
    });
  const task = () =>
    prisma.task.findUniqueOrThrow({ where: { id: lease.taskId } });
  const start = async (lane: 'full-sdd' | 'code-only' = 'full-sdd') => ({
    lane,
    grillSkip: false,
    startEventId: (await event()).id,
  });

  beforeAll(async () => {
    const config = new ConfigService<Env, true>({
      DATABASE_URL: testEnv.DATABASE_URL,
      SESSION_LEASE_SECONDS: 120,
    });
    prisma = new PrismaService(config);
    await prisma.$connect();
    leases = new SessionLeaseService(prisma, config);
    tasks = new TaskService(prisma, leases);
    runs = new RunService(
      prisma,
      leases,
      new EventsService(prisma, testScanner()),
    );
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    const row = await tasks.findOrCreate(ref);
    const holder = await event();
    lease = { taskId: row.id, eventId: holder.id };
    expect(await leases.claim(lease)).toBe(true);
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('findOrCreate: one row per issue, draft with no label; a second call finds it', async () => {
    const again = await tasks.findOrCreate(ref);

    expect(again.id).toBe(lease.taskId);
    expect(again).toMatchObject({ status: 'draft', shownStatus: null });
    expect(await prisma.task.count()).toBe(1);
  });

  it('run numbers go 1, 2, 3; a restart leaves exactly one run not ended', async () => {
    const run1 = await runs.create(lease, await start());
    await runs.cancel(lease, run1, lease.eventId);
    const run2 = await runs.create(lease, await start());
    const run3 = await runs.restart(lease, run2, await start('code-only'));

    expect([run1.number, run2.number, run3.number]).toEqual([1, 2, 3]);
    expect(await prisma.run.count({ where: { endedAt: null } })).toBe(1);
    expect(await task()).toMatchObject({ currentRunId: run3.id, runCount: 3 });
    expect(
      await prisma.run.findMany({
        orderBy: { number: 'asc' },
        select: { number: true, endReason: true },
      }),
    ).toEqual([
      { number: 1, endReason: 'cancelled' },
      { number: 2, endReason: 'restarted' },
      { number: 3, endReason: null },
    ]);
  });

  it('create beside a current run throws and writes nothing (plan P15)', async () => {
    const run1 = await runs.create(lease, await start());

    await expect(runs.create(lease, await start())).rejects.toThrow(
      'already has a current run',
    );
    expect(await prisma.run.count()).toBe(1);
    expect(await task()).toMatchObject({ currentRunId: run1.id, runCount: 1 });
  });

  it('a cancel sends the issue back to draft with no current run, saves the event that ended it and closes the lane conflict', async () => {
    const run1 = await runs.create(lease, await start());
    await tasks.setStatus(lease, 'grilling');
    await prisma.task.update({
      where: { id: lease.taskId },
      data: { laneConflictLanes: ['full-sdd', 'code-only'] },
    });

    await runs.cancel(lease, run1, lease.eventId);

    expect(await task()).toMatchObject({
      status: 'draft',
      currentRunId: null,
      laneConflictLanes: [],
    });
    expect(
      await prisma.run.findUniqueOrThrow({ where: { id: run1.id } }),
    ).toMatchObject({ endReason: 'cancelled', endEventId: lease.eventId });
  });

  it('a stop records step, cause, message, the event, the status before; stops + 1; needs-human', async () => {
    const run1 = await runs.create(lease, await start());
    await tasks.setStatus(lease, 'spec-review');
    const failed = await event();

    const stopped = await runs.stop(lease, run1, {
      step: 'plan',
      cause: 'credits-exhausted',
      message: 'Google says the credits are used up',
      retryable: true,
      eventId: failed.id,
    });

    expect(stopped).toMatchObject({
      stopStep: 'plan',
      stopCause: 'credits-exhausted',
      stopMessage: 'Google says the credits are used up',
      stopRetryable: true,
      stopEventId: failed.id,
      statusBeforeStop: 'spec-review',
      stopCommentId: null,
      stops: 1,
      stoppedAt: expect.any(Date) as Date,
    });
    expect((await task()).status).toBe('needs-human');
  });

  it('ending a stopped run keeps its stop fields and stopped_at (RLW1)', async () => {
    const run1 = await runs.create(lease, await start());
    const stopped = await runs.stop(lease, run1, {
      step: 'run-start',
      cause: 'step-not-built',
      message: 'this version of the bot has no `grill` step yet',
      retryable: true,
      eventId: run1.startEventId,
    });

    await runs.cancel(lease, stopped, lease.eventId);

    expect(
      await prisma.run.findUniqueOrThrow({ where: { id: run1.id } }),
    ).toMatchObject({
      endReason: 'cancelled',
      stoppedAt: stopped.stoppedAt,
      stopCause: 'step-not-built',
      stopStep: 'run-start',
      stops: 1,
    });
  });

  it('a write with the wrong lease owner throws LeaseLostError and changes nothing, runs included', async () => {
    const wrong = { taskId: lease.taskId, eventId: OTHER_EVENT };

    await expect(runs.create(wrong, await start())).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await expect(tasks.setStatus(wrong, 'grilling')).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    expect(await prisma.run.count()).toBe(0);
    expect(await task()).toMatchObject({ status: 'draft', runCount: 0 });
  });

  it('accepting a /retry restores the status, clears the stop, re-queues the stop event, in one transaction (plan P8)', async () => {
    const run1 = await runs.create(lease, await start());
    await tasks.setStatus(lease, 'spec-review');
    const failed = await event({
      status: 'FAILED',
      attempts: 1,
      lastError: 'credits',
      processedAt: new Date(),
    });
    const stopped = await runs.stop(lease, run1, {
      step: 'plan',
      cause: 'credits-exhausted',
      message: 'm',
      retryable: true,
      eventId: failed.id,
    });

    await expect(runs.acceptRetry(lease, stopped)).resolves.toBe('spec-review');

    expect((await task()).status).toBe('spec-review');
    expect(
      await prisma.run.findUniqueOrThrow({ where: { id: run1.id } }),
    ).toMatchObject({
      stoppedAt: null,
      retries: 1,
      stopCause: 'credits-exhausted',
      stops: 1,
    });
    expect(
      await prisma.webhookEvent.findUniqueOrThrow({ where: { id: failed.id } }),
    ).toMatchObject({ status: 'PENDING', attempts: 0, lastError: 'credits' });
  });

  it('a failure inside the /retry transaction rolls back the status, the stop and the re-queue', async () => {
    const failing = new RunService(
      prisma,
      leases,
      new FailingRequeue(prisma, testScanner()),
    );
    const run1 = await runs.create(lease, await start());
    await tasks.setStatus(lease, 'spec-review');
    const failed = await event({ status: 'FAILED', attempts: 1 });
    const stopped = await runs.stop(lease, run1, {
      step: 'plan',
      cause: 'credits-exhausted',
      message: 'm',
      retryable: true,
      eventId: failed.id,
    });

    await expect(failing.acceptRetry(lease, stopped)).rejects.toThrow(
      'requeue broke',
    );

    expect((await task()).status).toBe('needs-human');
    expect(
      await prisma.run.findUniqueOrThrow({ where: { id: run1.id } }),
    ).toMatchObject({ stoppedAt: stopped.stoppedAt, retries: 0 });
    expect(
      (
        await prisma.webhookEvent.findUniqueOrThrow({
          where: { id: failed.id },
        })
      ).status,
    ).toBe('FAILED');
  });

  it('stoppedAt and startEventReceivedAt come from PostgreSQL, not Node (plan P7)', async () => {
    const startEvent = await event();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 2 * 3_600_000));

    const run1 = await runs.create(lease, {
      lane: 'full-sdd',
      grillSkip: false,
      startEventId: startEvent.id,
    });
    const stopped = await runs.stop(lease, run1, {
      step: 'run-start',
      cause: 'step-config',
      message: 'm',
      retryable: true,
      eventId: startEvent.id,
    });
    vi.useRealTimers();

    const [{ now }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now()`;
    expect(run1.startEventReceivedAt).toEqual(startEvent.receivedAt);
    expect(Math.abs(stopped.stoppedAt!.getTime() - now.getTime())).toBeLessThan(
      60_000,
    );
  });

  it('the comment ids are recorded; the lane-conflict fields list the lanes and close (plan Q3)', async () => {
    const run1 = await runs.create(lease, await start());
    await runs.recordStopComment(lease, run1.id, '91');
    await runs.recordEndComment(lease, run1.id, '92');
    await tasks.recordLaneConflict(lease, 1, ['full-sdd', 'code-only']);
    expect(await task()).toMatchObject({
      laneConflictLanes: ['full-sdd', 'code-only'],
      laneConflicts: 1,
    });
    await tasks.closeLaneConflict(lease);
    await tasks.setShownStatus(lease, 'draft');
    await tasks.refreshExternalRef(lease, 'o/r#13');

    expect(
      await prisma.run.findUniqueOrThrow({ where: { id: run1.id } }),
    ).toMatchObject({ stopCommentId: '91', endCommentId: '92' });
    expect(await task()).toMatchObject({
      laneConflictLanes: [],
      laneConflicts: 1,
      shownStatus: 'draft',
      externalRef: 'o/r#13',
    });
  });

  it('latest() finds the newest run, current or ended', async () => {
    const run1 = await runs.create(lease, await start());
    await runs.cancel(lease, run1, lease.eventId);

    expect((await runs.latest(lease.taskId))?.id).toBe(run1.id);
    expect(await runs.current(await task())).toBeNull();
  });
});
