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
import {
  approveRefusedMarker,
  refusedMarker,
} from '../src/documents/document-comments.js';
import { needsHumanMarker } from '../src/workflow/workflow-comments.js';
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import {
  PLAN_TEXT,
  actionRows,
  commentNow,
  documentRows,
  specWritten,
  withMarker,
  yours,
} from './documents-helpers.js';
import { HUMAN, issueCommentCreated } from './fixtures/github/payloads.js';
import { captureLogs } from './grill-helpers.js';
import { deliver, seedWorkflow } from './router-helpers.js';

// Spec 13 (bot-feedback): the statuses (`plan-review`, `ready-for-dev` after every approval) and the working sign,
// through the router and the real handlers (plan FP20).

const OTHER = 'carol';

function approveBy(number: number, commentId: number, sender: string = HUMAN) {
  return issueCommentCreated({
    number,
    commentId,
    body: '/approve',
    sender,
    createdAt: new Date().toISOString(),
  });
}

describe('bot feedback: the statuses (spec 13)', () => {
  let t: TestApp;

  const task = () => t.prisma.task.findFirstOrThrow();
  const replies = (issue: TaskRef, commentId: number) =>
    withMarker(t, issue, approveRefusedMarker(String(commentId)));

  beforeAll(async () => {
    t = await startApp({ grill: 'real', documents: 'real' });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.models.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    t.issues.setAccessLevel(OTHER, 'approver');
    seedWorkflow(t.repo);
    captureLogs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expect(t.models.remaining).toBe(0);
  });
  afterAll(async () => {
    await t.app.close();
  });

  const statusLabels = () =>
    t.issues.calls
      .filter(({ method }) => method === 'setStatusLabel')
      .map(({ args }) => args[1]);
  const run = async () =>
    t.prisma.run.findUniqueOrThrow({
      where: { id: (await task()).currentRunId! },
    });

  /** `full-sdd`: Spec v1 approved, Plan v1 written (one scripted model reply). */
  async function planWritten(number: number) {
    const issue = await specWritten(t, number);
    t.models.reply({ answer: PLAN_TEXT });
    await deliver(t, approveBy(number, number * 100 + 1));
    return issue;
  }

  /** Every approval in, the `workspace` stop cleared by SQL: `ready-for-dev` with no stop (BFW6's state). */
  async function readyWithoutStop() {
    await t.prisma.run.update({
      where: { id: (await task()).currentRunId! },
      data: { stoppedAt: null, statusBeforeStop: null },
    });
    await t.prisma.task.updateMany({
      data: { status: 'ready-for-dev', shownStatus: 'ready-for-dev' },
    });
  }

  it("full-sdd: the Spec's /approve → Plan v1 under plan-review (row 17)", async () => {
    await planWritten(41);

    expect(await task()).toMatchObject({
      status: 'plan-review',
      shownStatus: 'plan-review',
    });
    expect(statusLabels()).toContain('plan-review');
    expect(statusLabels()).not.toContain('ready-for-dev');
  });

  it("full-sdd: the Plan's /approve → ready-for-dev, then the workspace stop (before it ready-for-dev); /retry → the /approve again as done → the same stop, NO reply", async () => {
    const issue = await planWritten(42);
    t.issues.calls.length = 0;

    const approve = await deliver(t, approveBy(42, 4202));

    // The `workspace` step isn't built (spec 8): `step-not-built`, a failure, so the event ends FAILED.
    expect(approve).toMatchObject({ status: 'FAILED' });
    expect(statusLabels()).toEqual(['ready-for-dev', 'needs-human']);
    expect(await run()).toMatchObject({
      stopStep: 'workspace',
      statusBeforeStop: 'ready-for-dev',
    });
    const { id: runId } = await run();
    expect(withMarker(t, issue, needsHumanMarker(runId, 1))).toHaveLength(1);
    t.issues.calls.length = 0;

    await deliver(t, commentNow(42, 4203, '/retry'));

    expect(statusLabels()).toEqual(['ready-for-dev', 'needs-human']);
    expect(await run()).toMatchObject({
      stopStep: 'workspace',
      statusBeforeStop: 'ready-for-dev',
      stops: 2,
    });
    expect(replies(issue, 4202)).toEqual([]);
    expect(await actionRows(t)).toEqual([]);
  });

  it('spec-code: /approve → ready-for-dev, then the workspace stop; NO Plan (row 18)', async () => {
    await specWritten(t, 43, { lane: 'spec-code' });
    t.issues.calls.length = 0;

    await deliver(t, approveBy(43, 4301));

    expect(statusLabels()).toEqual(['ready-for-dev', 'needs-human']);
    expect(await run()).toMatchObject({
      stopStep: 'workspace',
      statusBeforeStop: 'ready-for-dev',
    });
    expect((await documentRows(t)).map(({ kind }) => kind)).toEqual(['spec']);
  });

  it('ready-for-dev, every approval in: /approve by another person → "already approved" naming the Plan (full-sdd) (plan FP12)', async () => {
    const issue = await planWritten(44);
    await deliver(t, approveBy(44, 4402));
    await readyWithoutStop();

    const event = await deliver(t, approveBy(44, 4403, OTHER));

    expect(event).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'approve-refused',
    });
    expect(replies(issue, 4403)).toEqual([
      expect.objectContaining({
        body: expect.stringContaining(
          `${yours('`/approve`', 44, 4403)} changes nothing: Plan v1 is already approved (by \`${HUMAN}\`).`,
        ) as string,
      }),
    ]);
  });

  it('ready-for-dev, every approval in: /approve by another person → "already approved" naming the Spec (spec-code) (plan FP12)', async () => {
    const issue = await specWritten(t, 45, { lane: 'spec-code' });
    await deliver(t, approveBy(45, 4501));
    await readyWithoutStop();

    const event = await deliver(t, approveBy(45, 4502, OTHER));

    expect(event).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'approve-refused',
    });
    expect(replies(issue, 4502)).toEqual([
      expect.objectContaining({
        body: expect.stringContaining(
          `${yours('`/approve`', 45, 4502)} changes nothing: Spec v1 is already approved (by \`${HUMAN}\`).`,
        ) as string,
      }),
    ]);
    expect(await actionRows(t)).toMatchObject([
      { action: 'approve-refused', result: 'already-approved' },
    ]);
  });

  it("ready-for-dev, every approval in: /refresh, /restore → FP1's replies; a near-miss /approve → nothing (row 35)", async () => {
    const issue = await planWritten(46);
    await deliver(t, approveBy(46, 4602));
    await readyWithoutStop();
    const calls = t.models.calls.length;

    const refresh = await deliver(t, commentNow(46, 4603, '/refresh'));
    const restore = await deliver(t, commentNow(46, 4604, '/restore'));
    const nearMiss = await deliver(t, commentNow(46, 4605, '/approve please'));

    expect(refresh).toMatchObject({ ignoreReason: 'refresh-refused' });
    expect(restore).toMatchObject({ ignoreReason: 'restore-refused' });
    expect(nearMiss).toMatchObject({ ignoreReason: 'no-transition' });
    expect(
      withMarker(t, issue, refusedMarker('refresh', '4603'))[0].body,
    ).toContain(
      `${yours('`/refresh`', 46, 4603)} comes too late: every approval of run 1 is in, and the bot codes from the approved texts.`,
    );
    expect(
      withMarker(t, issue, refusedMarker('restore', '4604'))[0].body,
    ).toContain(
      `${yours('`/restore`', 46, 4604)} has nothing to restore: every approval of run 1 is in, and the bot keeps the approved texts.`,
    );
    expect(t.models.calls).toHaveLength(calls);
    expect(await task()).toMatchObject({ status: 'ready-for-dev' });
  });
});
