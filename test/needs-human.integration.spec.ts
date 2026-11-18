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
import { StepHandlerRegistry } from '../src/workflow/step-handler.registry.js';
import { needsHumanMarker } from '../src/workflow/workflow-comments.js';
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

// Spec 5 "Failure → needs-human" (row 28; RL4, RL5, RLW2) and the work-result stop (plan P4), in the booted app.

const notFound = () =>
  new ProviderError('GitHub GET issue → 404: Not Found', 'permanent');

function lane(number: number, label: string) {
  return issuesLabeled({ number, label: `workflow: ${label}` });
}

function comment(number: number, commentId: number, body = 'looks fine') {
  return issueCommentCreated({ number, commentId, body });
}

describe('failure → needs-human without step handlers (spec 5, T15)', () => {
  let t: TestApp;

  const run = () => t.prisma.run.findFirstOrThrow();
  const task = () => t.prisma.task.findFirstOrThrow();
  const bodies = (issue: TaskRef) =>
    t.issues.commentsOf(issue).map(({ body }) => body);

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

  it('a lane label → run 1 stopped at `go-signal` (step-not-built), needs-human, one comment with both lines', async () => {
    const issue = seedIssue(t, 51, { labels: ['workflow: code-only'] });

    const row = await deliver(t, lane(51, 'code-only'));

    expect(row).toMatchObject({ status: 'FAILED', attempts: 1 });
    const stopped = await run();
    expect(stopped).toMatchObject({
      number: 1,
      stopStep: 'go-signal',
      stopCause: 'step-not-built',
      stopMessage: 'this version of the bot has no `go-signal` step yet',
      stopRetryable: true,
      stopEventId: row.id,
      statusBeforeStop: 'draft',
      stops: 1,
      endedAt: null,
    });
    expect(stopped.stoppedAt).toBeInstanceOf(Date);
    expect(await task()).toMatchObject({
      status: 'needs-human',
      shownStatus: 'needs-human',
    });
    expect(t.issues.labelsOf(issue)).toContain('status: needs-human');
    expect(bodies(issue)).toEqual([
      [
        needsHumanMarker(stopped.id, 1),
        '⚠️ **Run 1 stopped at step `go-signal`:** this version of the bot has no `go-signal` step yet. ' +
          '(`step-not-built`)',
        '',
        '- Fix the cause, then comment `/retry` to continue run 1 where it stopped.',
        '- Or start again from scratch: remove the `workflow: code-only` label and add it again.',
      ].join('\n'),
    ]);
    const [{ id: commentId }] = t.issues.commentsOf(issue);
    expect(stopped.stopCommentId).toBe(commentId);
  });

  it('silent: a failure with no current run → FAILED only, no comment (RLW2)', async () => {
    const issue = seedIssue(t, 52, { labels: ['workflow: code-only'] });
    t.issues.failNextOn('getTaskDetails', notFound());

    const row = await deliver(t, lane(52, 'code-only'));

    expect(row).toMatchObject({ status: 'FAILED' });
    expect(await t.prisma.run.count()).toBe(0);
    expect(bodies(issue)).toEqual([]);
    expect(await task()).toMatchObject({ status: 'draft' });
  });

  it('silent: a failure while the run is already stopped → no second comment, the stop unchanged', async () => {
    const issue = seedIssue(t, 53, { labels: ['workflow: code-only'] });
    await deliver(t, lane(53, 'code-only'));
    const before = await run();
    t.issues.failNextOn('getTaskDetails', notFound());

    const row = await deliver(t, comment(53, 1));

    expect(row).toMatchObject({ status: 'FAILED' });
    expect(await run()).toEqual(before);
    expect(bodies(issue)).toHaveLength(1);
  });

  it('GitHub down at the stop comment → stopped, comment pending; the next event posts it once (RL5)', async () => {
    const issue = seedIssue(t, 54, { labels: ['workflow: code-only'] });
    t.issues.failNextOn(
      'postComment',
      new ProviderError('GitHub POST comment → 502', 'transient'),
    );

    const row = await deliver(t, lane(54, 'code-only'));

    expect(row).toMatchObject({ status: 'FAILED' });
    expect(await run()).toMatchObject({ stops: 1, stopCommentId: null });
    expect(await task()).toMatchObject({ status: 'needs-human' });
    expect(bodies(issue)).toEqual([]);

    const next = await deliver(t, comment(54, 1));

    // The pending comment first; the comment itself does nothing in needs-human (row 27).
    expect(next).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'no-transition',
    });
    expect(bodies(issue)).toHaveLength(1);
    const stopped = await run();
    expect(bodies(issue)[0]).toContain(needsHumanMarker(stopped.id, 1));
    expect(stopped.stopCommentId).toBe(t.issues.commentsOf(issue)[0].id);

    await deliver(t, comment(54, 2));
    expect(bodies(issue)).toHaveLength(1);
  });

  it('posted but not recorded → found by its marker, never posted twice', async () => {
    const issue = seedIssue(t, 55, { labels: ['workflow: code-only'] });
    await deliver(t, lane(55, 'code-only'));
    const [posted] = t.issues.commentsOf(issue);
    await t.prisma.run.updateMany({ data: { stopCommentId: null } });
    t.issues.calls.length = 0;

    await deliver(t, comment(55, 1));

    expect(t.issues.calls.map(({ method }) => method)).not.toContain(
      'postComment',
    );
    expect(bodies(issue)).toHaveLength(1);
    expect(await run()).toMatchObject({ stopCommentId: posted.id });
  });

  it('a redelivery of the stopped start event → the pending comment, `no-transition`, no run 2 (RL14)', async () => {
    const issue = seedIssue(t, 56, { labels: ['workflow: code-only'] });
    t.issues.failNextOn(
      'postComment',
      new ProviderError('GitHub POST comment → 502', 'transient'),
    );
    const first = await deliver(t, lane(56, 'code-only'));
    expect(first).toMatchObject({ status: 'FAILED' });

    // GitHub's "Redeliver": the same delivery id; a FAILED row is queued again (spec 2, IA13).
    await store(t, lane(56, 'code-only'), first.deliveryId);
    await t.worker.drainOnce();

    expect(
      await t.prisma.webhookEvent.findUniqueOrThrow({
        where: { id: first.id },
      }),
    ).toMatchObject({ status: 'IGNORED', ignoreReason: 'no-transition' });
    expect(await t.prisma.run.count()).toBe(1);
    expect(bodies(issue)).toHaveLength(1);
    expect(await run()).toMatchObject({ stops: 1 });
  });
});

describe('failure → needs-human with a running run (spec 5, T15)', () => {
  let t: TestApp;
  const grill = new ScriptedStepHandler();

  const run = () => t.prisma.run.findFirstOrThrow();
  const bodies = (issue: TaskRef) =>
    t.issues.commentsOf(issue).map(({ body }) => body);

  /** Issue `number` on `full-sdd`, run 1 grilling (the Grill asked its questions). */
  async function grilling(number: number): Promise<TaskRef> {
    const issue = seedIssue(t, number, { labels: ['workflow: full-sdd'] });
    grill.answerNext({ type: 'ASKED' });
    expect(await deliver(t, lane(number, 'full-sdd'))).toMatchObject({
      status: 'DONE',
    });
    return issue;
  }

  beforeAll(async () => {
    t = await startApp();
    t.app.get(StepHandlerRegistry).register('grill', grill);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    seedWorkflow(t.repo);
    grill.reset();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await t.app.close();
  });

  it('a temporary ProviderError on 3 attempts → one stop, "after 3 attempts" (RL4)', async () => {
    const issue = await grilling(61);
    for (let attempt = 0; attempt < 3; attempt++)
      grill.failNext(
        new ProviderError('Google answered 503: overloaded', 'transient'),
      );

    const row = await deliver(t, comment(61, 1, 'my answers'));
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
    await drainDueNow(t);
    await drainDueNow(t);

    expect(
      await t.prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ status: 'FAILED', attempts: 3 });
    expect(grill.calls.map(({ op }) => op)).toEqual([
      'start',
      'round',
      'round',
      'round',
    ]);
    expect(await run()).toMatchObject({
      stopStep: 'grill',
      stopCause: 'provider-error',
      stopMessage: 'Google answered 503: overloaded, after 3 attempts',
      statusBeforeStop: 'grilling',
      stopEventId: row.id,
      stops: 1,
    });
    expect(bodies(issue)).toHaveLength(1);
    expect(bodies(issue)[0]).toContain(
      '⚠️ **Run 1 stopped at step `grill`:** Google answered 503: overloaded, after 3 attempts. ' +
        '(`provider-error`)',
    );
  });

  it("an unexpected error → `internal-error`: the comment names the delivery, never the error's message", async () => {
    const issue = await grilling(62);
    for (let attempt = 0; attempt < 3; attempt++)
      grill.failNext(new Error('connection to db:5432 password=hunter2'));

    const row = await deliver(t, comment(62, 1, 'my answers'));
    await drainDueNow(t);
    await drainDueNow(t);

    expect(await run()).toMatchObject({ stopCause: 'internal-error' });
    const [body] = bodies(issue);
    expect(body).toContain(
      `an unexpected error; the app log has the details (delivery \`${row.deliveryId}\`). (\`internal-error\`)`,
    );
    expect(body).not.toContain('hunter2');
  });

  it('silent: a `/retry` event that fails → FAILED only; the run keeps running (RL13)', async () => {
    const issue = await grilling(63);
    t.issues.failNextOn('getTaskDetails', notFound());

    const row = await deliver(t, comment(63, 1, '/retry'));

    expect(row).toMatchObject({ status: 'FAILED' });
    expect(await run()).toMatchObject({ stoppedAt: null, stops: 0 });
    expect(bodies(issue)).toEqual([]);
  });

  it('silent: a failure in intake → FAILED only; the run keeps running (IA9)', async () => {
    const issue = await grilling(64);
    t.issues.failNextOn(
      'getAccessLevel',
      new ProviderError('GitHub GET permission → 403', 'permanent'),
    );

    const row = await deliver(t, comment(64, 1, 'my answers'));

    expect(row).toMatchObject({ status: 'FAILED' });
    expect(await run()).toMatchObject({ stoppedAt: null, stops: 0 });
    expect(bodies(issue)).toEqual([]);
  });

  it('a step returning `LIMIT` with its body → a stop only a restart continues: the marker and the body alone (plan P4; spec 6 GM9)', async () => {
    const issue = seedIssue(t, 65, { labels: ['workflow: full-sdd'] });
    const body =
      '**The Grill stopped after 5 rounds.** Two points are still open.';
    grill.answerNext({ type: 'LIMIT', body });

    const row = await deliver(t, lane(65, 'full-sdd'));

    expect(row).toMatchObject({ status: 'DONE' });
    const stopped = await run();
    expect(stopped).toMatchObject({
      stopStep: 'grill',
      stopCause: 'grill-limit',
      stopRetryable: false,
      stops: 1,
    });
    // Spec 6 GM9: the round limit's body brings its own steps, so no generic restart line.
    expect(bodies(issue)).toEqual([
      [needsHumanMarker(stopped.id, 1), body].join('\n'),
    ]);
    expect(t.issues.labelsOf(issue)).toContain('status: needs-human');
  });
});
