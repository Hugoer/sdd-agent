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
import {
  laneConflictMarker,
  runEndedMarker,
} from '../src/workflow/workflow-comments.js';
import { resetDatabase } from './db.js';
import { startApp, type TestApp } from './app.js';
import {
  HUMAN,
  issueCommentCreated,
  issuesLabeled,
  issuesUnlabeled,
} from './fixtures/github/payloads.js';
import {
  deliver,
  drainDueNow,
  seedIssue,
  seedWorkflow,
  store,
} from './router-helpers.js';

// Spec 5 "Lane-conflict reminder" (rows 3, 8; RL8, RL15; plan Q3, P9), in the booted app, no step handler.
// A reminder lists the lanes in `readControls`' order (full-sdd, spec-code, code-only), not the labels' order.

const KEEP_ONE = 'Keep exactly one: the bot starts a run when one is left.';

function added(number: number, lane: string) {
  return issuesLabeled({ number, label: `workflow: ${lane}` });
}

function removed(number: number, lane: string) {
  return issuesUnlabeled({ number, label: `workflow: ${lane}` });
}

function hello(number: number, commentId: number, body = 'hello') {
  return issueCommentCreated({ number, commentId, body });
}

const labels = (...lanes: string[]) => lanes.map((lane) => `workflow: ${lane}`);

describe('the lane-conflict reminder (spec 5, T18)', () => {
  let t: TestApp;

  const event = (id: string) =>
    t.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
  const task = () => t.prisma.task.findFirstOrThrow();
  const reminders = (issue: TaskRef) =>
    t.issues
      .commentsOf(issue)
      .map(({ body }) => body)
      .filter((body) => body.includes('sdd-agent:lane-conflict:'));

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

  it('two lane labels added in one go (two events) → ONE reminder, both `lane-conflict`, no run; remove one → a run starts; add it again → a new reminder `…:2` (rows 3, 4)', async () => {
    const issue = seedIssue(t, 91, {
      labels: labels('full-sdd', 'code-only'),
    });
    const log = vi.spyOn(Logger.prototype, 'log');
    const first = await store(t, added(91, 'full-sdd'));
    const second = await store(t, added(91, 'code-only'));

    await t.worker.drainOnce();

    for (const id of [first.id, second.id])
      expect(await event(id)).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'lane-conflict',
      });
    expect(reminders(issue)).toEqual([
      `${laneConflictMarker(1)}\nThis issue has 2 \`workflow:\` labels: \`workflow: full-sdd\`, \`workflow: code-only\`. ${KEEP_ONE}`,
    ]);
    expect(log.mock.calls.map(([message]) => String(message))).toContain(
      '#91 lane conflict (reminder posted)',
    );
    expect(await task()).toMatchObject({
      laneConflictLanes: ['full-sdd', 'code-only'],
      laneConflicts: 1,
    });
    expect(await t.prisma.run.count()).toBe(0);

    // One lane left: run 1 starts (and stops at its first step, not built); the conflict is over.
    t.issues.setHumanLabels(issue, labels('full-sdd'));
    expect(await deliver(t, removed(91, 'code-only'))).toMatchObject({
      status: 'FAILED',
    });
    expect(await t.prisma.run.count()).toBe(1);
    expect(await task()).toMatchObject({ laneConflictLanes: [] });

    t.issues.setHumanLabels(issue, labels('full-sdd', 'code-only'));
    expect(await deliver(t, added(91, 'code-only'))).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'lane-conflict',
    });
    const all = reminders(issue);
    expect(all).toHaveLength(2);
    expect(all[1]).toBe(
      `${laneConflictMarker(2)}\nThis issue has 2 \`workflow:\` labels: \`workflow: full-sdd\`, \`workflow: code-only\`. ` +
        'Run 1 keeps `workflow: full-sdd`. To switch, remove `workflow: full-sdd`; to stay, remove the others.',
    );
  });

  it('plan Q3: a third lane while two are listed → a fresh "still has 3"; one of three removed → a fresh "still has 2"; an event that reads the listed set → nothing', async () => {
    const issue = seedIssue(t, 92, {
      labels: labels('full-sdd', 'code-only'),
    });
    await deliver(t, added(92, 'code-only'));

    t.issues.setHumanLabels(
      issue,
      labels('full-sdd', 'code-only', 'spec-code'),
    );
    expect(await deliver(t, added(92, 'spec-code'))).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'lane-conflict',
    });

    t.issues.setHumanLabels(issue, labels('full-sdd', 'spec-code'));
    expect(await deliver(t, removed(92, 'code-only'))).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'lane-conflict',
    });

    expect(await deliver(t, hello(92, 9201))).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'no-transition',
    });

    expect(reminders(issue)).toEqual([
      `${laneConflictMarker(1)}\nThis issue has 2 \`workflow:\` labels: \`workflow: full-sdd\`, \`workflow: code-only\`. ${KEEP_ONE}`,
      `${laneConflictMarker(2)}\nThis issue still has 3 \`workflow:\` labels: \`workflow: full-sdd\`, \`workflow: spec-code\`, \`workflow: code-only\`. ${KEEP_ONE}`,
      `${laneConflictMarker(3)}\nThis issue still has 2 \`workflow:\` labels: \`workflow: full-sdd\`, \`workflow: spec-code\`. ${KEEP_ONE}`,
    ]);
    expect(await task()).toMatchObject({
      laneConflictLanes: ['full-sdd', 'spec-code'],
      laneConflicts: 3,
    });
  });

  it("three lanes with a run, the run's lane removed → the cancel comment, no run, then a fresh reminder in the draft wording (RL15)", async () => {
    const issue = seedIssue(t, 93, { labels: labels('code-only') });
    await deliver(t, added(93, 'code-only'));
    // Two lanes added in one go while run 1 is stopped: one reminder, in the run wording.
    t.issues.setHumanLabels(
      issue,
      labels('code-only', 'spec-code', 'full-sdd'),
    );
    await store(t, added(93, 'spec-code'));
    await store(t, added(93, 'full-sdd'));
    await t.worker.drainOnce();
    expect(reminders(issue)).toEqual([
      `${laneConflictMarker(1)}\nThis issue has 3 \`workflow:\` labels: \`workflow: full-sdd\`, \`workflow: spec-code\`, \`workflow: code-only\`. ` +
        'Run 1 keeps `workflow: code-only`. To switch, remove `workflow: code-only`; to stay, remove the others.',
    ]);

    t.issues.setHumanLabels(issue, labels('spec-code', 'full-sdd'));
    const row = await deliver(t, removed(93, 'code-only'));

    expect(row).toMatchObject({ status: 'DONE' });
    const run = await t.prisma.run.findFirstOrThrow();
    expect(run).toMatchObject({ endReason: 'cancelled' });
    expect(await t.prisma.run.count()).toBe(1);
    expect(await task()).toMatchObject({ currentRunId: null });
    const bodies = t.issues.commentsOf(issue).map(({ body }) => body);
    // The stop comment, the first reminder, the cancel comment, then the fresh reminder.
    expect(bodies).toHaveLength(4);
    expect(bodies[2]).toContain(runEndedMarker(run.id));
    expect(bodies[3]).toBe(
      `${laneConflictMarker(2)}\nThis issue has 2 \`workflow:\` labels: \`workflow: full-sdd\`, \`workflow: spec-code\`. ${KEEP_ONE}`,
    );
  });

  it('the reminder post failing → retried → posted once; posted but not recorded → found by its marker, not posted again', async () => {
    const issue = seedIssue(t, 94, {
      labels: labels('full-sdd', 'code-only'),
    });
    t.issues.failNextOn(
      'postComment',
      new ProviderError('GitHub POST comment → 502', 'transient'),
    );

    const row = await deliver(t, added(94, 'code-only'));
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
    await drainDueNow(t);

    expect(await event(row.id)).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'lane-conflict',
    });
    expect(reminders(issue)).toHaveLength(1);

    // A crash after the post, before the record.
    await t.prisma.task.updateMany({
      data: { laneConflictLanes: [], laneConflicts: 0 },
    });
    await deliver(t, hello(94, 9401));

    expect(reminders(issue)).toHaveLength(1);
    expect(await task()).toMatchObject({
      laneConflictLanes: ['full-sdd', 'code-only'],
      laneConflicts: 1,
    });
  });

  it('the reminder failing in the job of an accepted `/retry` → that event FAILED at once, no reply (plan P9)', async () => {
    const issue = seedIssue(t, 95, { labels: labels('code-only') });
    const stop = await deliver(t, added(95, 'code-only'));
    // A second lane whose event was never delivered: the /retry's job is the first to see two lanes.
    t.issues.setHumanLabels(issue, labels('code-only', 'spec-code'));
    t.issues.failNextOn(
      'postComment',
      new ProviderError('GitHub POST comment → 502', 'transient'),
    );

    const row = await deliver(t, hello(95, 9501, '/retry'));

    expect(row).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'GitHub POST comment → 502',
    });
    // The /retry was accepted: the stop's event ran again and stopped the run again; no reply to the /retry.
    expect(await event(stop.id)).toMatchObject({ status: 'FAILED' });
    expect(await t.prisma.run.findFirstOrThrow()).toMatchObject({
      stops: 2,
      retries: 1,
    });
    expect(
      t.issues
        .commentsOf(issue)
        .some(({ body }) => body.includes('sdd-agent:retry-refused')),
    ).toBe(false);
  });
});
