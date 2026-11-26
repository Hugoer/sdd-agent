import { randomUUID } from 'node:crypto';
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
import {
  needsHumanMarker,
  retryRefusedMarker,
} from '../src/workflow/workflow-comments.js';
import { resetDatabase } from './db.js';
import { startApp, type TestApp } from './app.js';
import { ScriptedStepHandler } from './fakes/scripted-step-handler.js';
import {
  HUMAN,
  issueCommentCreated,
  issuesLabeled,
} from './fixtures/github/payloads.js';
import {
  deliver,
  drainDueNow,
  seedIssue,
  seedWorkflow,
  store,
} from './router-helpers.js';

// Spec 5 "`/retry`" (rows 30, 31; RL6, RL13, RL20, RLW3; plan P8, P9), in the booted app.

const NOT_BUILT = 'this version of the bot has no `go-signal` step yet';

function lane(number: number, label: string) {
  return issuesLabeled({ number, label: `workflow: ${label}` });
}

function retry(number: number, commentId: number, body = '/retry') {
  return issueCommentCreated({ number, commentId, body });
}

/** The shared reads of both suites. */
function reads(t: () => TestApp) {
  return {
    run: () => t().prisma.run.findFirstOrThrow(),
    event: (id: string) =>
      t().prisma.webhookEvent.findUniqueOrThrow({ where: { id } }),
    bodies: (issue: TaskRef) =>
      t()
        .issues.commentsOf(issue)
        .map(({ body }) => body),
    labelCalls: () =>
      t()
        .issues.calls.filter(({ method }) => method === 'setStatusLabel')
        .map(({ args }) => args[1]),
  };
}

/**
 * RL20: the `/retry` gets exactly one reply, also when its job runs again after the post (a crash before the
 * row was updated: the marker is found). Returns the reply.
 */
async function expectOneReply(
  t: TestApp,
  issue: TaskRef,
  row: WebhookEvent,
  commentId: number,
): Promise<string> {
  const replies = () =>
    t.issues
      .commentsOf(issue)
      .filter(({ body }) =>
        body.startsWith(retryRefusedMarker(String(commentId))),
      );
  expect(row).toMatchObject({
    status: 'IGNORED',
    ignoreReason: 'retry-refused',
  });
  expect(replies()).toHaveLength(1);

  await t.prisma.webhookEvent.update({
    where: { id: row.id },
    data: { status: 'PENDING', processedAt: null, ignoreReason: null },
  });
  await drainDueNow(t);

  expect(
    await t.prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } }),
  ).toMatchObject({ status: 'IGNORED', ignoreReason: 'retry-refused' });
  expect(replies()).toHaveLength(1);
  return replies()[0].body;
}

describe('/retry without step handlers (spec 5, T16)', () => {
  let t: TestApp;
  const { run, event, bodies, labelCalls } = reads(() => t);

  /** Issue `number` on `code-only`, run 1 stopped at `go-signal`; returns the issue and the stop's event. */
  async function stopped(
    number: number,
  ): Promise<{ issue: TaskRef; stop: WebhookEvent }> {
    const issue = seedIssue(t, number, { labels: ['workflow: code-only'] });
    const stop = await deliver(t, lane(number, 'code-only'));
    expect(stop).toMatchObject({ status: 'FAILED', lastError: NOT_BUILT });
    t.issues.calls.length = 0;
    return { issue, stop };
  }

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

  it('a stopped run → `/retry` → DONE; `draft` shown again, then `needs-human`; a second stop comment; stops 2, retries 1, no run 2 (row 30)', async () => {
    const { issue, stop } = await stopped(71);
    const log = vi.spyOn(Logger.prototype, 'log');

    const row = await deliver(t, retry(71, 7101));

    expect(row).toMatchObject({ status: 'DONE', attempts: 1 });
    // Spec 13 (BF10, plan FP5): 🚀 on the accepted /retry, before its write and the status label.
    expect(t.issues.reactionsOf(issue, '7101')).toEqual(['rocket']);
    const methods = t.issues.calls.map(({ method }) => method);
    expect(methods.indexOf('reactWorking')).toBeLessThan(
      methods.indexOf('setStatusLabel'),
    );
    expect(log.mock.calls.map(([message]) => String(message))).toContain(
      '#71 /retry accepted: run 1 back to draft',
    );
    // The re-queued start event ran next in the same run, and stopped it again.
    expect(await event(stop.id)).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: NOT_BUILT,
    });
    expect(labelCalls()).toEqual(['draft', 'needs-human']);
    const latest = await run();
    expect(latest).toMatchObject({
      number: 1,
      stops: 2,
      retries: 1,
      stopStep: 'go-signal',
      stopEventId: stop.id,
    });
    expect(latest.stoppedAt).not.toBeNull();
    expect(await t.prisma.run.count()).toBe(1);
    const comments = bodies(issue);
    expect(comments).toHaveLength(2);
    expect(comments[0]).toContain(needsHumanMarker(latest.id, 1));
    expect(comments[1]).toContain(needsHumanMarker(latest.id, 2));
    expect(t.issues.labelsOf(issue)).toContain('status: needs-human');
  });

  it('no run → one reply "nothing to retry", also when the job runs again (RL20)', async () => {
    const issue = seedIssue(t, 72);

    const row = await deliver(t, retry(72, 7201));

    const reply = await expectOneReply(t, issue, row, 7201);
    expect(reply).toBe(
      `${retryRefusedMarker('7201')}\nThere is no run on this issue, so there is nothing to retry. To start one, add one \`workflow:\` label.`,
    );
    expect(await t.prisma.run.count()).toBe(0);
  });

  it('two `/retry` while the lease is held → the first accepted, the second "written before run 1 stopped" (RLW3)', async () => {
    const { issue, stop } = await stopped(73);
    await t.prisma.task.updateMany({
      data: {
        leaseOwner: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const first = await store(t, retry(73, 7301));
    const second = await store(t, retry(73, 7302));
    await t.worker.drainOnce();
    expect(await event(first.id)).toMatchObject({ status: 'PENDING' });
    expect(await event(second.id)).toMatchObject({ status: 'PENDING' });

    // The lease expires; the events run in the order received: first, the re-queued stop event, second.
    await t.prisma.task.updateMany({
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    await drainDueNow(t);

    expect(await event(first.id)).toMatchObject({
      status: 'DONE',
      attempts: 1,
    });
    expect(await event(stop.id)).toMatchObject({ status: 'FAILED' });
    const reply = await expectOneReply(t, issue, await event(second.id), 7302);
    expect(reply).toBe(
      `${retryRefusedMarker('7302')}\nThis \`/retry\` was written before run 1 stopped, so it didn't count. To continue run 1, comment \`/retry\` again.`,
    );
    expect(await run()).toMatchObject({ stops: 2, retries: 1 });
    expect(bodies(issue)).toHaveLength(3);
  });

  it('the label call failing after the write → the `/retry` FAILED at once, silent; the re-queued event sets the label first (plan P9, RL13)', async () => {
    const { issue, stop } = await stopped(74);
    t.issues.failNextOn(
      'setStatusLabel',
      new ProviderError('GitHub POST labels → 502', 'transient'),
    );

    const row = await deliver(t, retry(74, 7401));

    // A worker retry would have answered "isn't stopped": the transient error ends the event at once.
    expect(row).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'GitHub POST labels → 502',
    });
    // The failed label call, then the re-queued event's pending label, then its stop.
    expect(labelCalls()).toEqual(['draft', 'draft', 'needs-human']);
    // The /retry's failure stopped nothing: only the re-queued event's stop, and no reply.
    expect(await event(stop.id)).toMatchObject({ status: 'FAILED' });
    expect(await run()).toMatchObject({ stops: 2, retries: 1 });
    expect(bodies(issue)).toHaveLength(2);
    expect(
      bodies(issue).some((body) => body.includes('sdd-agent:retry-refused')),
    ).toBe(false);
  });

  it('the stop event ended `IGNORED` by a redelivery → `/retry` still re-queues it (plan P8)', async () => {
    const { stop } = await stopped(75);
    // GitHub's "Redeliver": the run is stopped, so the start event only ends `no-transition` (RL14).
    await store(t, lane(75, 'code-only'), stop.deliveryId);
    await t.worker.drainOnce();
    expect(await event(stop.id)).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'no-transition',
    });

    const row = await deliver(t, retry(75, 7501));

    expect(row).toMatchObject({ status: 'DONE' });
    expect(await event(stop.id)).toMatchObject({
      status: 'FAILED',
      ignoreReason: null,
      lastError: NOT_BUILT,
    });
    expect(await run()).toMatchObject({ stops: 2, retries: 1 });
  });
});

describe('/retry with a step handler (spec 5, T16)', () => {
  let t: TestApp;
  const grill = new ScriptedStepHandler();
  const { run, event, bodies } = reads(() => t);

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

  it('a failed Grill → `/retry` → the same run continues; the event keeps its `last_error` (RL6, RL11); a second `/retry` → "isn\'t stopped"', async () => {
    const issue = seedIssue(t, 76, { labels: ['workflow: full-sdd'] });
    grill.failNext(new ProviderError('GitHub GET issue → 502', 'permanent'));
    const stop = await deliver(t, lane(76, 'full-sdd'));
    expect(stop).toMatchObject({ status: 'FAILED' });
    expect(await run()).toMatchObject({ stopStep: 'grill', stops: 1 });

    grill.answerNext({ type: 'ASKED' });
    const row = await deliver(t, retry(76, 7601));

    expect(row).toMatchObject({ status: 'DONE' });
    expect(await event(stop.id)).toMatchObject({
      status: 'DONE',
      lastError: 'GitHub GET issue → 502',
    });
    expect(grill.calls.map(({ op, run: r }) => [op, r.number])).toEqual([
      ['start', 1],
      ['start', 1],
    ]);
    expect(await run()).toMatchObject({
      number: 1,
      stoppedAt: null,
      stops: 1,
      retries: 1,
    });
    expect(await t.prisma.task.findFirstOrThrow()).toMatchObject({
      status: 'grilling',
      shownStatus: 'grilling',
    });

    const again = await deliver(t, retry(76, 7602));

    const reply = await expectOneReply(t, issue, again, 7602);
    expect(reply).toBe(
      `${retryRefusedMarker('7602')}\nRun 1 isn't stopped (status \`grilling\`), so there is nothing to retry.`,
    );
  });

  it('a stop that is a result of the work → the restart reply; the run unchanged (RL6, RL20)', async () => {
    const issue = seedIssue(t, 77, { labels: ['workflow: full-sdd'] });
    grill.answerNext({
      type: 'LIMIT',
      body: 'The Grill stopped after 5 rounds.',
    });
    await deliver(t, lane(77, 'full-sdd'));
    const before = await run();
    expect(before).toMatchObject({ stopRetryable: false, stops: 1 });

    const row = await deliver(t, retry(77, 7701));

    const reply = await expectOneReply(t, issue, row, 7701);
    expect(reply).toMatch(
      /^<!-- sdd-agent:retry-refused:7701 -->\n`\/retry` only continues a run that stopped on a failure\. Run 1 stopped because .+, so it needs a restart: remove the `workflow: full-sdd` label and add it again\.$/,
    );
    expect(await run()).toEqual(before);
    expect(bodies(issue)).toHaveLength(2);
  });
});
