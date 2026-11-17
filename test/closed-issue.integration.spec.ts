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
import type { Run, WebhookEvent } from '../src/generated/prisma/client.js';
import {
  issueClosedMarker,
  runEndedMarker,
} from '../src/workflow/workflow-comments.js';
import { resetDatabase } from './db.js';
import { startApp, type TestApp } from './app.js';
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
} from './router-helpers.js';

// Spec 5 "Closed issues" (RL9, RL19; plan P5, P15), in the booted app, no step handler.

function added(number: number, label: string) {
  return issuesLabeled({ number, label });
}

function removed(number: number, label: string) {
  return issuesUnlabeled({ number, label });
}

function comment(number: number, commentId: number, body: string) {
  return issueCommentCreated({ number, commentId, body });
}

describe('closed issues (spec 5, T19)', () => {
  let t: TestApp;

  const run = () => t.prisma.run.findFirstOrThrow();
  const bodies = (issue: TaskRef) =>
    t.issues.commentsOf(issue).map(({ body }) => body);

  /** Issue `number` with run 1 on `code-only` stopped at `go-signal`, then closed. */
  async function stoppedThenClosed(
    number: number,
  ): Promise<{ issue: TaskRef; stop: WebhookEvent; frozen: Run }> {
    const issue = seedIssue(t, number, { labels: ['workflow: code-only'] });
    const stop = await deliver(t, added(number, 'workflow: code-only'));
    expect(stop).toMatchObject({ status: 'FAILED' });
    t.issues.setOpen(issue, false);
    return { issue, stop, frozen: await run() };
  }

  /** The event ends `IGNORED` `issue-closed`. */
  async function expectClosed(delivery: Parameters<typeof deliver>[1]) {
    const row = await deliver(t, delivery);
    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'issue-closed',
    });
    return row;
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

  it("the run's own lane removed, one other lane left → cancelled, NO new run; `DONE`; the cancel comment; `status: draft` (RL19)", async () => {
    const { issue } = await stoppedThenClosed(101);
    t.issues.setHumanLabels(issue, ['workflow: spec-code']);

    const row = await deliver(t, removed(101, 'workflow: code-only'));

    expect(row).toMatchObject({ status: 'DONE' });
    expect(await t.prisma.run.count()).toBe(1);
    const ended = await run();
    expect(ended).toMatchObject({ endReason: 'cancelled', endEventId: row.id });
    expect(await t.prisma.task.findFirstOrThrow()).toMatchObject({
      status: 'draft',
      currentRunId: null,
    });
    expect(t.issues.labelsOf(issue)).toContain('status: draft');
    expect(bodies(issue)).toHaveLength(2);
    expect(bodies(issue)[1]).toContain(runEndedMarker(ended.id));
  });

  it('a lane label added → ONE reply, also when its job runs again; no run, no reminder; removed again → silent', async () => {
    const { issue, frozen } = await stoppedThenClosed(102);
    t.issues.setHumanLabels(issue, [
      'workflow: code-only',
      'workflow: full-sdd',
    ]);

    const row = await expectClosed(added(102, 'workflow: full-sdd'));

    const reply = `${issueClosedMarker(row.deliveryId)}\nThis issue is closed, so the bot did nothing with \`workflow: full-sdd\`. To start a run, reopen the issue, then remove the label and add it again.`;
    expect(bodies(issue)).toEqual([bodies(issue)[0], reply]);
    // The job runs again after the post (a crash before the row was updated): the marker is found.
    await t.prisma.webhookEvent.update({
      where: { id: row.id },
      data: { status: 'PENDING', ignoreReason: null, processedAt: null },
    });
    await drainDueNow(t);
    expect(bodies(issue)).toHaveLength(2);

    t.issues.setHumanLabels(issue, ['workflow: code-only']);
    await expectClosed(removed(102, 'workflow: full-sdd'));

    expect(bodies(issue)).toHaveLength(2);
    expect(await run()).toEqual(frozen);
    expect(await t.prisma.task.findFirstOrThrow()).toMatchObject({
      laneConflictLanes: [],
      laneConflicts: 0,
    });
  });

  it('`/retry` and `/approve` → one reply each; the run unchanged', async () => {
    const { issue, frozen } = await stoppedThenClosed(103);

    const retry = await expectClosed(comment(103, 10301, '/retry'));
    const approve = await expectClosed(comment(103, 10302, '/approve'));

    expect(bodies(issue).slice(1)).toEqual([
      `${issueClosedMarker(retry.deliveryId)}\nThis issue is closed, so \`/retry\` did nothing. Reopen the issue, then comment \`/retry\` again.`,
      `${issueClosedMarker(approve.deliveryId)}\nThis issue is closed, so \`/approve\` did nothing. Reopen the issue, then comment \`/approve\` again.`,
    ]);
    expect(await run()).toEqual(frozen);
  });

  it('a comment, `grill: skip`, another lane removed, `issues.opened` → nothing; `IGNORED` `issue-closed`', async () => {
    const { issue, frozen } = await stoppedThenClosed(104);

    await expectClosed(comment(104, 10401, 'hello'));
    t.issues.setHumanLabels(issue, ['workflow: code-only', 'grill: skip']);
    await expectClosed(added(104, 'grill: skip'));
    t.issues.setHumanLabels(issue, ['workflow: code-only']);
    await expectClosed(removed(104, 'workflow: spec-code'));
    await expectClosed(issuesOpened({ number: 104 }));

    expect(bodies(issue)).toHaveLength(1);
    expect(await run()).toEqual(frozen);
  });

  it("the run's own start event processed again on a closed issue → `issue-closed`, silent (plan P15)", async () => {
    const { issue, stop, frozen } = await stoppedThenClosed(105);
    await t.prisma.webhookEvent.update({
      where: { id: stop.id },
      data: { status: 'PENDING' },
    });

    await drainDueNow(t);

    expect(
      await t.prisma.webhookEvent.findUniqueOrThrow({ where: { id: stop.id } }),
    ).toMatchObject({ status: 'IGNORED', ignoreReason: 'issue-closed' });
    expect(bodies(issue)).toHaveLength(1);
    expect(await run()).toEqual(frozen);
  });

  it('reopened, a lane label starts a run as usual', async () => {
    const { issue } = await stoppedThenClosed(106);
    t.issues.setHumanLabels(issue, []);
    await deliver(t, removed(106, 'workflow: code-only'));

    t.issues.setOpen(issue, true);
    t.issues.setHumanLabels(issue, ['workflow: spec-code']);
    const row = await deliver(t, added(106, 'workflow: spec-code'));

    // Run 2 starts, and stops at its first step (not built).
    expect(row).toMatchObject({ status: 'FAILED' });
    const runs = await t.prisma.run.findMany({ orderBy: { number: 'asc' } });
    expect(runs.map(({ number, lane }) => [number, lane])).toEqual([
      [1, 'code-only'],
      [2, 'spec-code'],
    ]);
    expect(runs[1]).toMatchObject({ endedAt: null, stopStep: 'grill' });
  });
});
