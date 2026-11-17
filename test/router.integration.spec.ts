import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
import type { EventProcessor } from '../src/events/event-processor.js';
import { routerMarkOf } from '../src/workflow/router-error-mark.js';
import { WorkflowEventProcessor } from '../src/workflow/workflow-event.processor.js';
import { resetDatabase } from './db.js';
import { startApp, type TestApp } from './app.js';
import {
  HUMAN,
  TARGET_REPO,
  issueCommentCreated,
  issuesOpened,
  pullRequestSynchronize,
} from './fixtures/github/payloads.js';
import {
  deliver,
  drainDueNow,
  fixtureIssueId,
  seedIssue,
  store,
} from './router-helpers.js';

// Spec 5: the router in the booted app (real PostgreSQL, the app's own processor, fake ports).

describe('the router: processor, task row and lease (spec 5, T12)', () => {
  let t: TestApp;
  let startupLines: string[];

  beforeAll(async () => {
    // The harness boots with `logger: false`: the startup line is read from the Logger itself.
    const log = vi.spyOn(Logger.prototype, 'log');
    t = await startApp();
    startupLines = log.mock.calls.map(([message]) => String(message));
    log.mockRestore();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await t.app.close();
  });

  it("the app's processor is WorkflowEventProcessor (spec 2's placeholder is gone)", () => {
    expect(startupLines).toContain('event processor: WorkflowEventProcessor');
    expect(startupLines.join('\n')).not.toContain('IntakeEventProcessor');
  });

  it('PR_UPDATED (a bot PR) → IGNORED no-task, no Task row (RLW6)', async () => {
    const row = await deliver(t, pullRequestSynchronize({ number: 41 }));

    expect(row).toMatchObject({ status: 'IGNORED', ignoreReason: 'no-task' });
    expect(await t.prisma.task.count()).toBe(0);
  });

  it('an accepted issue event creates its Task in draft, with no label (RLW5)', async () => {
    seedIssue(t, 21);

    const row = await deliver(t, issueCommentCreated({ number: 21 }));

    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'no-transition',
    });
    expect(await t.prisma.task.findMany()).toEqual([
      expect.objectContaining({
        platform: 'GITHUB',
        platformId: fixtureIssueId(21),
        externalRef: `${TARGET_REPO}#21`,
        status: 'draft',
        shownStatus: null,
        leaseOwner: null,
      }),
    ]);
    expect(t.issues.calls.map(({ method }) => method)).not.toContain(
      'setStatusLabel',
    );
  });

  it('the lease held by another event → PENDING again in 5 s, the attempt not counted (RLW11)', async () => {
    seedIssue(t, 22);
    const other = randomUUID();
    await t.prisma.task.create({
      data: {
        platform: 'GITHUB',
        platformId: fixtureIssueId(22),
        externalRef: `${TARGET_REPO}#22`,
        leaseOwner: other,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const log = vi.spyOn(Logger.prototype, 'log');
    const before = Date.now();

    const row = await deliver(t, issueCommentCreated({ number: 22 }));

    expect(row).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      lastError: null,
    });
    expect(row.availableAt.getTime()).toBeGreaterThanOrEqual(before + 4_000);
    expect(log.mock.calls.map(([message]) => String(message))).toContain(
      '#22 lease taken, waiting 5 s',
    );
    expect(await t.prisma.task.findFirstOrThrow()).toMatchObject({
      leaseOwner: other,
    });
  });

  it('the same event retakes its own lease (a crash left it held) and is processed', async () => {
    seedIssue(t, 23);
    const event = await store(t, issueCommentCreated({ number: 23 }));
    await t.prisma.task.create({
      data: {
        platform: 'GITHUB',
        platformId: fixtureIssueId(23),
        externalRef: `${TARGET_REPO}#23`,
        leaseOwner: event.id,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    await t.worker.drainOnce();

    expect(
      await t.prisma.webhookEvent.findUniqueOrThrow({
        where: { id: event.id },
      }),
    ).toMatchObject({ status: 'IGNORED', ignoreReason: 'no-transition' });
    // Released at the end of the job.
    expect(await t.prisma.task.findFirstOrThrow()).toMatchObject({
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });
});

describe('the router: read, decide and the status label (spec 5, T13)', () => {
  let t: TestApp;

  const methods = () => t.issues.calls.map(({ method }) => method);
  const taskRow = () => t.prisma.task.findFirstOrThrow();

  beforeAll(async () => {
    t = await startApp();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await t.app.close();
  });

  it('issues.opened → `status: draft`, shownStatus draft, DONE (row 1)', async () => {
    const issue = seedIssue(t, 31);

    const row = await deliver(t, issuesOpened({ number: 31 }));

    expect(row).toMatchObject({ status: 'DONE', attempts: 1 });
    expect(t.issues.labelsOf(issue)).toEqual(['status: draft']);
    expect(await taskRow()).toMatchObject({
      status: 'draft',
      shownStatus: 'draft',
      runCount: 0,
    });
  });

  it('a pending label is set first, also when the event then does nothing (RL5)', async () => {
    const issue = seedIssue(t, 32, { labels: ['status: draft'] });
    await t.prisma.task.create({
      data: {
        platform: 'GITHUB',
        platformId: fixtureIssueId(32),
        externalRef: `${TARGET_REPO}#32`,
        status: 'grilling',
        shownStatus: 'draft',
      },
    });

    const row = await deliver(t, issueCommentCreated({ number: 32 }));

    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'no-transition',
    });
    // Intake's lookup, then the label before the issue is read.
    expect(methods()).toEqual([
      'getAccessLevel',
      'setStatusLabel',
      'getTaskDetails',
    ]);
    expect(t.issues.labelsOf(issue)).toEqual(['status: grilling']);
    expect(await taskRow()).toMatchObject({ shownStatus: 'grilling' });
  });

  it('`setStatusLabel` failing on `opened` → retried → the label set once (plan P6)', async () => {
    const issue = seedIssue(t, 33);
    t.issues.failNextOn(
      'setStatusLabel',
      new ProviderError('GitHub POST labels → 502', 'transient'),
    );

    const first = await deliver(t, issuesOpened({ number: 33 }));
    expect(first).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(await taskRow()).toMatchObject({ shownStatus: null });

    await drainDueNow(t);

    expect(
      await t.prisma.webhookEvent.findUniqueOrThrow({
        where: { id: first.id },
      }),
    ).toMatchObject({ status: 'DONE', attempts: 2 });
    expect(t.issues.labelsOf(issue)).toEqual(['status: draft']);
    expect(await taskRow()).toMatchObject({ shownStatus: 'draft' });
  });

  it('exactly one getTaskDetails per routed issue event', async () => {
    seedIssue(t, 34);

    await deliver(t, issuesOpened({ number: 34 }));
    await deliver(t, issueCommentCreated({ number: 34, commentId: 1 }));
    await deliver(t, issueCommentCreated({ number: 34, commentId: 2 }));

    expect(
      methods().filter((method) => method === 'getTaskDetails'),
    ).toHaveLength(3);
  });

  it('an error after the claim reaches failed() with the mark: task, step, /retry flag (plan P2)', async () => {
    seedIssue(t, 35);
    const failed = vi.spyOn(
      WorkflowEventProcessor.prototype as EventProcessor,
      'failed',
    );
    t.issues.failNextOn(
      'getTaskDetails',
      new ProviderError('GitHub GET issue → 404: Not Found', 'permanent'),
    );

    const row = await deliver(
      t,
      issueCommentCreated({ number: 35, body: '/retry' }),
    );

    expect(row).toMatchObject({ status: 'FAILED' });
    const task = await taskRow();
    expect(failed).toHaveBeenCalledOnce();
    const [, error] = failed.mock.calls[0];
    expect(error).toBeInstanceOf(ProviderError);
    expect(routerMarkOf(error)).toEqual({
      taskId: task.id,
      step: 'run-start',
      retry: true,
      stale: false,
    });
  });

  it('an error in intake reaches failed() without a mark (a silent FAILED, IA9)', async () => {
    seedIssue(t, 36);
    const failed = vi.spyOn(
      WorkflowEventProcessor.prototype as EventProcessor,
      'failed',
    );
    t.issues.failNextOn(
      'getAccessLevel',
      new ProviderError('GitHub GET permission → 403', 'permanent'),
    );

    const row = await deliver(t, issueCommentCreated({ number: 36 }));

    expect(row).toMatchObject({ status: 'FAILED' });
    expect(failed).toHaveBeenCalledOnce();
    expect(routerMarkOf(failed.mock.calls[0][1])).toBeNull();
    expect(await t.prisma.task.count()).toBe(0);
  });
});
