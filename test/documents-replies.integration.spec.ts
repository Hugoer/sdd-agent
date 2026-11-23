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
  approveHintMarker,
  approveRefusedMarker,
  lateCommentMarker,
} from '../src/documents/document-comments.js';
import { issueClosedMarker } from '../src/workflow/workflow-comments.js';
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import {
  PLAN_TEXT,
  SPEC_TEXT,
  actionRows,
  commentNow,
  commentUrl,
  documentRows,
  runAgain,
  specWritten,
  withMarker,
  yours,
} from './documents-helpers.js';
import { HUMAN } from './fixtures/github/payloads.js';
import { captureLogs, grillAnswer, laneAdded } from './grill-helpers.js';
import {
  deliver,
  drainDueNow,
  seedIssue,
  seedWorkflow,
  store,
} from './router-helpers.js';

// Spec 7 "`/approve please`", "A comment written while the bot writes the Spec", "Replies where nothing waits"
// (plan T16).

describe('Replies: the hint, the late comment, `/approve` where nothing waits (spec 7)', () => {
  let t: TestApp;
  let logs: string[];

  const event = (id: string) =>
    t.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
  const hints = (issue: TaskRef) =>
    withMarker(t, issue, 'sdd-agent:approve-hint:');
  const refused = (issue: TaskRef, commentId: number) =>
    withMarker(t, issue, approveRefusedMarker(String(commentId)));

  beforeAll(async () => {
    t = await startApp({ grill: 'real', documents: 'real' });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.models.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    seedWorkflow(t.repo);
    logs = captureLogs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expect(t.models.remaining).toBe(0);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('`/approve please` twice → ONE hint; once the Plan waits → a new hint for it', async () => {
    const issue = await specWritten(t, 91);
    const [spec] = await documentRows(t);

    const first = await deliver(t, commentNow(91, 9101, '/approve please'));
    const second = await deliver(t, commentNow(91, 9102, '/Approved'));

    expect(first).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'approve-hint',
    });
    expect(second).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'no-transition',
    });
    expect(hints(issue)).toEqual([
      expect.objectContaining({
        body:
          `${approveHintMarker(spec.id)}\n${yours('comment', 91, 9101)} isn't an approval: to approve, comment ` +
          'exactly `/approve`, with nothing else.',
      }),
    ]);
    expect(await actionRows(t)).toEqual([
      expect.objectContaining({
        action: 'approve-hint',
        documentId: spec.id,
        sourceCommentId: '9101',
        replyPostState: 'POSTED',
      }),
    ]);
    expect(logs).toContain('#91 run 1 documents: /approve hint (comment 9101)');

    t.models.reply({ answer: PLAN_TEXT });
    await deliver(t, commentNow(91, 9103, '/approve'));
    const plan = (await documentRows(t)).find(({ kind }) => kind === 'plan')!;
    await deliver(t, commentNow(91, 9104, '/approve now'));

    expect(hints(issue)).toHaveLength(2);
    expect(withMarker(t, issue, approveHintMarker(plan.id))).toHaveLength(1);
  });

  it('a comment written while the bot wrote the Spec → after Spec v1, ONE reply naming its author; a comment after it → none', async () => {
    const issue = seedIssue(t, 92, { labels: ['workflow: full-sdd'] });
    t.models.replyJson(grillAnswer({ confidence: 96 })).reply({
      answer: SPEC_TEXT,
      during: () =>
        store(t, commentNow(92, 9201, 'Q3: actually weekly')).then(() => {}),
    });

    await deliver(t, laneAdded(92));
    await t.worker.drainOnce();

    expect(withMarker(t, issue, lateCommentMarker('9201'))).toEqual([
      expect.objectContaining({
        body:
          `${lateCommentMarker('9201')}\n\`${HUMAN}\`, [your comment](${commentUrl(92, 9201)}) was ` +
          "written while the bot was writing the Spec, so the Spec doesn't include it. If it changes the Spec, " +
          'someone with Write access can edit the Spec comment before `/approve`.',
      }),
    ]);
    expect(await actionRows(t)).toMatchObject([
      { action: 'late-comment', sourceCommentId: '9201' },
    ]);
    expect(logs).toContain('#92 run 1 documents: late comment 9201 answered');

    const after = await deliver(t, commentNow(92, 9202, 'looks good'));

    expect(after).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'no-transition',
    });
    expect(await actionRows(t)).toHaveLength(1);
  });

  it('a comment Grill Me read, processed in spec-review → no reply', async () => {
    const issue = seedIssue(t, 93, { labels: ['workflow: full-sdd'] });
    t.models.replyJson(grillAnswer({ confidence: 50, questions: 1 }));
    await deliver(t, laneAdded(93));
    // Two answers stored before either is processed: the first event reads both (one burst), then the Spec.
    await store(t, commentNow(93, 9301, 'Q1: yes.'));
    await store(t, commentNow(93, 9302, 'And it splits evenly.'));
    t.models
      .replyJson(grillAnswer({ confidence: 97 }))
      .reply({ answer: SPEC_TEXT });

    await t.worker.drainOnce();

    expect(withMarker(t, issue, 'sdd-agent:spec:')).toHaveLength(1);
    expect(withMarker(t, issue, 'sdd-agent:late-comment:')).toEqual([]);
    expect(await actionRows(t)).toEqual([]);
  });

  it('`/approve` with no run → ONE reply and a row with no run', async () => {
    const issue = seedIssue(t, 94);

    const row = await deliver(t, commentNow(94, 9401, '/approve'));

    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'approve-refused',
    });
    expect(refused(issue, 9401)).toEqual([
      expect.objectContaining({
        body:
          `${approveRefusedMarker('9401')}\n${yours('`/approve`', 94, 9401)} has nothing to approve: this issue ` +
          'has no run. To start one, add a `workflow:` label.',
      }),
    ]);
    expect(await actionRows(t)).toEqual([
      expect.objectContaining({
        runId: null,
        documentId: null,
        result: 'no-run',
        replyPostState: 'POSTED',
      }),
    ]);
    expect(logs).toContain('#94 documents: /approve refused (no-run)');
  });

  it('P40: `/approve` with no run while `workflow: full-sdd` is on (its event missed) → the reply names the label', async () => {
    const issue = seedIssue(t, 190, {
      labels: ['workflow: full-sdd', 'grill: skip'],
    });

    await deliver(t, commentNow(190, 19001, '/approve'));

    expect(refused(issue, 19001)[0].body).toBe(
      `${approveRefusedMarker('19001')}\n${yours('`/approve`', 190, 19001)} has nothing to approve: ` +
        '`workflow: full-sdd` is on, but the bot has no run for it (it probably missed when the label was added). ' +
        'Remove the label and add it again to start one.',
    );
    expect(await actionRows(t)).toMatchObject([
      { runId: null, result: 'no-run' },
    ]);
    expect(await t.prisma.run.count()).toBe(0);
  });

  it.each([
    ['executing', 95, 'has nothing to approve: run 1 is writing the code.'],
    [
      'in-review',
      195,
      "has nothing to approve here: run 1's pull request is open; review it there.",
    ],
  ] as const)(
    '`/approve` in %s (status set in the test database) → its text',
    async (status, number, text) => {
      const issue = await specWritten(t, number);
      await t.prisma.task.updateMany({ data: { status, shownStatus: status } });
      const commentId = number * 100 + 1;

      await deliver(t, commentNow(number, commentId, '/approve'));

      expect(refused(issue, commentId)[0].body).toBe(
        `${approveRefusedMarker(String(commentId))}\n${yours('`/approve`', number, commentId)} ${text}`,
      );
      expect(await actionRows(t)).toMatchObject([{ result: status }]);
    },
  );

  it('spec-code, two `/approve` a second apart → the `workspace` stop, then ONE "Run 1 is stopped" reply', async () => {
    const issue = await specWritten(t, 96, { lane: 'spec-code' });
    await store(t, commentNow(96, 9601, '/approve'));
    await store(t, commentNow(96, 9602, '/approve'));

    await t.worker.drainOnce();

    expect(await t.prisma.run.findFirstOrThrow()).toMatchObject({
      stopStep: 'workspace',
    });
    expect(refused(issue, 9602)).toEqual([
      expect.objectContaining({
        body:
          `${approveRefusedMarker('9602')}\n${yours('`/approve`', 96, 9602)} has nothing to approve now: run 1 ` +
          'is stopped. See the stop comment for how to continue.',
      }),
    ]);
    expect(await actionRows(t)).toMatchObject([{ result: 'stopped' }]);
  });

  it('full-sdd, two `/approve` a second apart on the Spec → ONE Plan, then ONE "written before Plan v1" reply', async () => {
    const issue = await specWritten(t, 97);
    t.models.reply({ answer: PLAN_TEXT });
    await store(t, commentNow(97, 9701, '/approve'));
    await store(t, commentNow(97, 9702, '/approve'));

    await t.worker.drainOnce();

    expect(withMarker(t, issue, 'sdd-agent:plan:')).toHaveLength(1);
    expect(refused(issue, 9702)).toHaveLength(1);
    expect(refused(issue, 9702)[0].body).toContain(
      `${yours('`/approve`', 97, 9702)} was written before Plan v1 was posted`,
    );
  });

  it('a closed issue → spec 5’s reply, unchanged', async () => {
    const issue = await specWritten(t, 98);
    t.issues.setOpen(issue, false);

    const row = await deliver(t, commentNow(98, 9801, '/approve'));

    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'issue-closed',
    });
    expect(
      withMarker(t, issue, issueClosedMarker(row.deliveryId)),
    ).toHaveLength(1);
    expect(await actionRows(t)).toEqual([]);
  });

  it('each reply posted once when its job runs again after a crash before the post (P34)', async () => {
    const issue = await specWritten(t, 99);
    t.issues.failNextOn(
      'postComment',
      new ProviderError('GitHub POST comment → 502', 'transient'),
    );

    const hint = await deliver(t, commentNow(99, 9901, '/approve please'));
    expect(hint).toMatchObject({ status: 'PENDING' });
    await drainDueNow(t);
    await runAgain(t, hint.id);

    expect(hints(issue)).toHaveLength(1);
    expect(await event(hint.id)).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'approve-hint',
    });
    expect(await actionRows(t)).toHaveLength(1);
  });
});
