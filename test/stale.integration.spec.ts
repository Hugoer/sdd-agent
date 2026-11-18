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
import type { WebhookEvent } from '../src/generated/prisma/client.js';
import { resetDatabase } from './db.js';
import { startApp, type TestApp } from './app.js';
import { ScriptedStepHandler } from './fakes/scripted-step-handler.js';
import {
  HUMAN,
  issueCommentCreated,
  issuesLabeled,
  issuesOpened,
  issuesUnlabeled,
} from './fixtures/github/payloads.js';
import {
  deliver,
  drainDueNow,
  seedIssue,
  seedWorkflow,
  store,
} from './router-helpers.js';

// Spec 5 "Stale events" (RL10, RL14; plan P2), in the booted app.

function added(number: number, lane: string) {
  return issuesLabeled({ number, label: `workflow: ${lane}` });
}

function removed(number: number, lane: string) {
  return issuesUnlabeled({ number, label: `workflow: ${lane}` });
}

function hello(number: number, commentId: number) {
  return issueCommentCreated({ number, commentId, body: 'hello' });
}

/** Stores a delivery whose processing is postponed (a worker retry waiting), so later events go first. */
async function storePostponed(
  t: TestApp,
  delivery: Parameters<typeof store>[1],
): Promise<WebhookEvent> {
  const row = await store(t, delivery);
  await t.prisma.webhookEvent.update({
    where: { id: row.id },
    data: { availableAt: new Date(Date.now() + 3_600_000) },
  });
  return row;
}

describe('stale events without step handlers (spec 5, T20)', () => {
  let t: TestApp;

  const event = (id: string) =>
    t.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
  const bodies = (issue: TaskRef) =>
    t.issues.commentsOf(issue).map(({ body }) => body);
  const methods = () => t.issues.calls.map(({ method }) => method);
  const requeue = (id: string) =>
    t.prisma.webhookEvent.update({
      where: { id },
      data: { status: 'PENDING', ignoreReason: null, processedAt: null },
    });

  beforeAll(async () => {
    t = await startApp();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    seedWorkflow(t.repo);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await t.app.close();
  });

  it('`opened` handled after its `labeled` twin started a run → `IGNORED` `stale`, no read of the issue (RL10)', async () => {
    const issue = seedIssue(t, 111, { labels: ['workflow: code-only'] });
    const opened = await storePostponed(t, issuesOpened({ number: 111 }));
    const labeled = await deliver(t, added(111, 'code-only'));
    expect(labeled).toMatchObject({ status: 'FAILED' });
    t.issues.calls.length = 0;
    const log = vi.spyOn(Logger.prototype, 'log');

    await drainDueNow(t);

    expect(await event(opened.id)).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'stale',
    });
    expect(log.mock.calls.map(([message]) => String(message))).toContain(
      '#111 ignored stale',
    );
    expect(methods()).not.toContain('getTaskDetails');
    expect(t.issues.labelsOf(issue)).not.toContain('status: draft');
    expect(await t.prisma.run.count()).toBe(1);
  });

  it('a comment postponed while a swap started a new run → `stale`; nothing posted, no read of the issue', async () => {
    const issue = seedIssue(t, 112, { labels: ['workflow: code-only'] });
    await deliver(t, added(112, 'code-only'));
    const comment = await storePostponed(t, hello(112, 11201));
    t.issues.setHumanLabels(issue, ['workflow: spec-code']);
    await deliver(t, removed(112, 'code-only'));
    const before = bodies(issue);
    t.issues.calls.length = 0;

    await drainDueNow(t);

    expect(await event(comment.id)).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'stale',
    });
    expect(methods()).not.toContain('getTaskDetails');
    expect(methods()).not.toContain('postComment');
    expect(bodies(issue)).toEqual(before);
  });

  it("the current run's own start event processed again → not stale: `no-transition`, no run 3; the older run's start event → `stale` (RL14)", async () => {
    const issue = seedIssue(t, 113, { labels: ['workflow: code-only'] });
    const first = await deliver(t, added(113, 'code-only'));
    t.issues.setHumanLabels(issue, ['workflow: spec-code']);
    const second = await deliver(t, removed(113, 'code-only'));
    expect(second).toMatchObject({ status: 'FAILED' });

    await requeue(second.id);
    await drainDueNow(t);
    expect(await event(second.id)).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'no-transition',
    });

    await requeue(first.id);
    await drainDueNow(t);
    expect(await event(first.id)).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'stale',
    });
    expect(await t.prisma.run.count()).toBe(2);
  });

  it('the event `/retry` re-queues is not stale: it runs again in the same run', async () => {
    seedIssue(t, 114, { labels: ['workflow: code-only'] });
    const stop = await deliver(t, added(114, 'code-only'));

    await deliver(
      t,
      issueCommentCreated({ number: 114, commentId: 11401, body: '/retry' }),
    );

    expect(await event(stop.id)).toMatchObject({ status: 'FAILED' });
    expect(await t.prisma.run.findFirstOrThrow()).toMatchObject({
      stops: 2,
      retries: 1,
    });
  });
});

describe('stale events with a running run (spec 5, T20, plan P2)', () => {
  let t: TestApp;
  const grill = new ScriptedStepHandler();

  const event = (id: string) =>
    t.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });

  /** Issue `number`: run 1 on `full-sdd`, a comment postponed, then a swap to `spec-code`: run 2 grilling. */
  async function swappedWithStaleComment(
    number: number,
  ): Promise<{ issue: TaskRef; comment: WebhookEvent }> {
    const issue = seedIssue(t, number, { labels: ['workflow: full-sdd'] });
    grill.answerNext({ type: 'ASKED' });
    await deliver(t, added(number, 'full-sdd'));
    const comment = await storePostponed(t, hello(number, number * 100 + 1));
    t.issues.setHumanLabels(issue, ['workflow: spec-code']);
    grill.answerNext({ type: 'ASKED' });
    expect(await deliver(t, removed(number, 'full-sdd'))).toMatchObject({
      status: 'DONE',
    });
    expect(await t.prisma.run.count({ where: { endedAt: null } })).toBe(1);
    return { issue, comment };
  }

  beforeAll(async () => {
    t = await startApp({ grill });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    seedWorkflow(t.repo);
    grill.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('the pending label is completed even for a stale event, then `stale`', async () => {
    const { issue, comment } = await swappedWithStaleComment(115);
    await t.prisma.task.updateMany({ data: { shownStatus: null } });
    t.issues.setHumanLabels(issue, ['workflow: spec-code']);
    t.issues.calls.length = 0;

    await drainDueNow(t);

    expect(await event(comment.id)).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'stale',
    });
    expect(
      t.issues.calls
        .filter(({ method }) => method === 'setStatusLabel')
        .map(({ args }) => args[1]),
    ).toEqual(['grilling']);
    expect(await t.prisma.task.findFirstOrThrow()).toMatchObject({
      shownStatus: 'grilling',
    });
  });

  it('a stale event failing there 3 times → `FAILED`; the running run is never stopped (plan P2)', async () => {
    const { issue, comment } = await swappedWithStaleComment(116);
    await t.prisma.task.updateMany({ data: { shownStatus: null } });
    const down = () =>
      t.issues.failNextOn(
        'setStatusLabel',
        new ProviderError('GitHub POST labels → 502', 'transient'),
      );
    const before = t.issues.commentsOf(issue).length;

    for (let attempt = 1; attempt <= 3; attempt++) {
      down();
      await drainDueNow(t);
    }

    expect(await event(comment.id)).toMatchObject({
      status: 'FAILED',
      attempts: 3,
    });
    const current = await t.prisma.run.findFirstOrThrow({
      where: { endedAt: null },
    });
    expect(current).toMatchObject({ number: 2, stoppedAt: null, stops: 0 });
    expect(await t.prisma.task.findFirstOrThrow()).toMatchObject({
      status: 'grilling',
    });
    expect(t.issues.commentsOf(issue)).toHaveLength(before);
  });
});
