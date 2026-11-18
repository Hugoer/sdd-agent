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
import { runEndedMarker } from '../src/workflow/workflow-comments.js';
import { resetDatabase } from './db.js';
import { startApp, type TestApp } from './app.js';
import { ScriptedStepHandler } from './fakes/scripted-step-handler.js';
import {
  HUMAN,
  issueCommentCreated,
  issuesLabeled,
  issuesUnlabeled,
} from './fixtures/github/payloads.js';
import { deliver, seedIssue, seedWorkflow, store } from './router-helpers.js';

// Spec 5 "Cancel and restart" (rows 6, 7; RL12, RL15, RL18, RLW1; plan Q1, Q2), in the booted app.

const OTHER = 'other-dev';

function added(number: number, lane: string) {
  return issuesLabeled({ number, label: `workflow: ${lane}` });
}

function removed(number: number, lane: string) {
  return issuesUnlabeled({ number, label: `workflow: ${lane}` });
}

function cancelledText(runId: string, lane: string, sender = HUMAN): string {
  return [
    runEndedMarker(runId),
    `Run 1 (\`${lane}\`) was cancelled: \`${sender}\` removed \`workflow: ${lane}\`.`,
    'To start again, add one `workflow:` label.',
  ].join('\n');
}

describe('cancel with a step handler (spec 5, T17)', () => {
  let t: TestApp;
  const grill = new ScriptedStepHandler();

  const run = () => t.prisma.run.findFirstOrThrow();
  const bodies = (issue: TaskRef) =>
    t.issues.commentsOf(issue).map(({ body }) => body);

  /** Issue `number` on `full-sdd`, run 1 grilling (the Grill asked its questions). */
  async function grilling(number: number): Promise<TaskRef> {
    const issue = seedIssue(t, number, { labels: ['workflow: full-sdd'] });
    grill.answerNext({ type: 'ASKED' });
    expect(await deliver(t, added(number, 'full-sdd'))).toMatchObject({
      status: 'DONE',
    });
    return issue;
  }

  beforeAll(async () => {
    t = await startApp({ grill });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    t.issues.setAccessLevel(OTHER, 'participant');
    seedWorkflow(t.repo);
    grill.reset();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await t.app.close();
  });

  it("the run's lane removed → run 1 cancelled; `draft`, no current run; ONE comment naming the sender in backticks, no `@` (row 6, RL18)", async () => {
    const issue = await grilling(81);
    t.issues.setHumanLabels(issue, []);
    const log = vi.spyOn(Logger.prototype, 'log');

    const row = await deliver(t, removed(81, 'full-sdd'));

    expect(row).toMatchObject({ status: 'DONE' });
    expect(log.mock.calls.map(([message]) => String(message))).toContain(
      '#81 run 1 cancelled',
    );
    const ended = await run();
    expect(ended).toMatchObject({
      endReason: 'cancelled',
      endEventId: row.id,
      stoppedAt: null,
    });
    expect(ended.endedAt).not.toBeNull();
    expect(await t.prisma.task.findFirstOrThrow()).toMatchObject({
      status: 'draft',
      shownStatus: 'draft',
      currentRunId: null,
    });
    expect(t.issues.labelsOf(issue)).toEqual(['status: draft']);
    const comments = t.issues.commentsOf(issue);
    expect(comments.map(({ body }) => body)).toEqual([
      cancelledText(ended.id, 'full-sdd'),
    ]);
    expect(comments[0].body).not.toContain('@');
    expect(ended.endCommentId).toBe(comments[0].id);
    // The cancel hook was asked for its block, for run 1, told how and when it ended (spec 6 plan P6).
    expect(grill.cancelCalls.map(({ run: r }) => r.number)).toEqual([1]);
    expect(grill.cancelCalls[0]).toMatchObject({
      end: { kind: 'cancelled' },
      endEventReceivedAt: row.receivedAt,
    });
  });

  it('spec 6: a handler gets the run with its start event received_at (the comments before it are never answers)', async () => {
    await grilling(84);

    const started = await run();
    expect(grill.calls).toHaveLength(1);
    expect(grill.calls[0].run).toEqual({
      id: started.id,
      number: 1,
      lane: 'full-sdd',
      grillSkip: false,
      startEventReceivedAt: started.startEventReceivedAt,
    });
  });

  it('spec 6 plan P6: a swap → the hook hears `replaced` by run 2 and the added label event received_at', async () => {
    const issue = await grilling(85);
    t.issues.setHumanLabels(issue, ['workflow: spec-code']);

    const swap = await deliver(t, added(85, 'spec-code'));

    expect(swap).toMatchObject({ status: 'DONE' });
    expect(grill.cancelCalls).toHaveLength(1);
    expect(grill.cancelCalls[0]).toMatchObject({
      run: { number: 1, lane: 'full-sdd' },
      end: { kind: 'replaced', by: { number: 2, lane: 'spec-code' } },
      endEventReceivedAt: swap.receivedAt,
    });
  });

  it("a cancel hook's block is appended to the same comment (RL18, spec 6's answered rounds)", async () => {
    const issue = await grilling(82);
    grill.cancelBlock = '**Answered so far:** 2 of 5 rounds.';
    t.issues.setHumanLabels(issue, []);

    await deliver(t, removed(82, 'full-sdd'));

    expect(bodies(issue)).toEqual([
      `${cancelledText((await run()).id, 'full-sdd')}\n\n**Answered so far:** 2 of 5 rounds.`,
    ]);
  });

  it('GitHub down at the run-ended comment → pending; the next event, from another sender, posts it once naming who removed the label (plan Q1, Q2)', async () => {
    const issue = await grilling(83);
    t.issues.setHumanLabels(issue, []);
    t.issues.failNextOn(
      'postComment',
      new ProviderError('GitHub POST comment → 403', 'permanent'),
    );

    const cancel = await deliver(t, removed(83, 'full-sdd'));

    // Ended in the database; no current run, so the failure stops nothing (RLW2).
    expect(cancel).toMatchObject({ status: 'FAILED' });
    expect(await run()).toMatchObject({
      endReason: 'cancelled',
      endCommentId: null,
    });
    expect(bodies(issue)).toEqual([]);

    const hello = await deliver(
      t,
      issueCommentCreated({
        number: 83,
        commentId: 8301,
        body: 'hello',
        sender: OTHER,
      }),
    );

    expect(hello).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'no-transition',
    });
    const ended = await run();
    const comments = t.issues.commentsOf(issue);
    expect(comments.map(({ body }) => body)).toEqual([
      cancelledText(ended.id, 'full-sdd', HUMAN),
    ]);
    expect(ended.endCommentId).toBe(comments[0].id);
    // The hook was asked again for the comment posted later, with the same end and time (spec 6 plan P6).
    expect(grill.cancelCalls).toHaveLength(2);
    for (const call of grill.cancelCalls)
      expect(call).toMatchObject({
        end: { kind: 'cancelled' },
        endEventReceivedAt: cancel.receivedAt,
      });

    // Posted but not recorded (a crash in between): the marker is found, nothing is posted, the hook isn't asked.
    await t.prisma.run.updateMany({ data: { endCommentId: null } });
    await deliver(
      t,
      issueCommentCreated({ number: 83, commentId: 8302, body: 'hello' }),
    );

    expect(bodies(issue)).toHaveLength(1);
    expect(await run()).toMatchObject({ endCommentId: comments[0].id });
    expect(grill.cancelCalls).toHaveLength(2);
  });
});

describe('cancel and restart without step handlers (spec 5, T17)', () => {
  let t: TestApp;

  const runs = () => t.prisma.run.findMany({ orderBy: { number: 'asc' } });
  const event = (id: string) =>
    t.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
  const bodies = (issue: TaskRef) =>
    t.issues.commentsOf(issue).map(({ body }) => body);
  const replaced = (issue: TaskRef) =>
    bodies(issue).filter((body) => body.includes('was replaced by'));

  /** Issue `number` on `code-only`, run 1 stopped at `go-signal`. */
  async function stopped(number: number): Promise<TaskRef> {
    const issue = seedIssue(t, number, { labels: ['workflow: code-only'] });
    expect(await deliver(t, added(number, 'code-only'))).toMatchObject({
      status: 'FAILED',
    });
    return issue;
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

  it('a stopped run cancelled → it keeps its stop fields (RLW1); `status: draft`; one cancel comment after the stop comment', async () => {
    const issue = await stopped(84);
    t.issues.setHumanLabels(issue, []);

    const row = await deliver(t, removed(84, 'code-only'));

    expect(row).toMatchObject({ status: 'DONE' });
    const [ended] = await runs();
    expect(ended).toMatchObject({
      endReason: 'cancelled',
      stopStep: 'go-signal',
      stopCause: 'step-not-built',
      stops: 1,
    });
    expect(ended.stoppedAt).not.toBeNull();
    expect(t.issues.labelsOf(issue)).toEqual(['status: draft']);
    expect(bodies(issue)).toHaveLength(2);
    expect(bodies(issue)[1]).toBe(cancelledText(ended.id, 'code-only'));
  });

  it('the run\'s lane removed with one other left → restart: the "replaced" comment, then run 2\'s stop comment (row 6, RL12)', async () => {
    const issue = await stopped(85);
    t.issues.setHumanLabels(issue, ['workflow: spec-code']);
    const log = vi.spyOn(Logger.prototype, 'log');

    const row = await deliver(t, removed(85, 'code-only'));

    // Run 2 starts in the same job and stops at its first step (no handler is built).
    expect(row).toMatchObject({ status: 'FAILED' });
    expect(log.mock.calls.map(([message]) => String(message))).toContain(
      '#85 run 1 restarted → run 2 (spec-code)',
    );
    const [first, second] = await runs();
    expect(first).toMatchObject({
      endReason: 'restarted',
      endEventId: row.id,
    });
    expect(second).toMatchObject({
      number: 2,
      lane: 'spec-code',
      startEventId: row.id,
      endedAt: null,
      stopStep: 'grill',
      stops: 1,
    });
    expect(await t.prisma.task.findFirstOrThrow()).toMatchObject({
      currentRunId: second.id,
      runCount: 2,
      status: 'needs-human',
    });
    const comments = bodies(issue);
    expect(comments).toHaveLength(3);
    expect(comments[1]).toBe(
      [
        runEndedMarker(first.id),
        `Run 1 (\`code-only\`) was replaced by run 2 (\`spec-code\`): \`${HUMAN}\` changed the workflow label.`,
      ].join('\n'),
    );
    expect(comments[2]).toContain('Run 2 stopped at step `grill`');
    expect(first.endCommentId).toBe(t.issues.commentsOf(issue)[1].id);
  });

  it('a swap, removal first, both changes made before the bot handles them → ONE new run, ONE "replaced"; the "added" event `no-transition` (RL12)', async () => {
    const issue = await stopped(86);
    t.issues.setHumanLabels(issue, ['workflow: spec-code']);
    const removal = await store(t, removed(86, 'code-only'));
    const addition = await store(t, added(86, 'spec-code'));

    await t.worker.drainOnce();

    expect(await event(removal.id)).toMatchObject({ status: 'FAILED' });
    expect(await event(addition.id)).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'no-transition',
    });
    expect((await runs()).map(({ number, lane }) => [number, lane])).toEqual([
      [1, 'code-only'],
      [2, 'spec-code'],
    ]);
    expect(replaced(issue)).toHaveLength(1);
  });

  it('a swap, addition first, both changes made before the bot handles them → ONE new run, ONE "replaced"; the removal `no-transition` (row 7, RL12)', async () => {
    const issue = await stopped(87);
    t.issues.setHumanLabels(issue, ['workflow: spec-code']);
    const addition = await store(t, added(87, 'spec-code'));
    const removal = await store(t, removed(87, 'code-only'));

    await t.worker.drainOnce();

    expect(await event(addition.id)).toMatchObject({ status: 'FAILED' });
    expect(await event(removal.id)).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'no-transition',
    });
    const all = await runs();
    expect(all.map(({ number, lane }) => [number, lane])).toEqual([
      [1, 'code-only'],
      [2, 'spec-code'],
    ]);
    expect(all[0]).toMatchObject({
      endReason: 'restarted',
      endEventId: addition.id,
    });
    expect(replaced(issue)).toHaveLength(1);
  });
});
