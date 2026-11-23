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
import { approveRefusedMarker } from '../src/documents/document-comments.js';
import {
  DOCUMENT_END,
  DOCUMENT_START,
} from '../src/documents/document-text.js';
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import {
  PLAN_TEXT,
  SPEC_TEXT,
  actionRows,
  commentNow,
  documentRows,
  runAgain,
  specWritten,
  withMarker,
} from './documents-helpers.js';
import { HUMAN } from './fixtures/github/payloads.js';
import { captureLogs } from './grill-helpers.js';
import { deliver, drainDueNow, seedWorkflow } from './router-helpers.js';

// Spec 7 "`/approve`" (R2, D10, SPW5), plan T11: the gate's verdict and the refusals.

describe('/approve: the gate and the refusals (spec 7)', () => {
  let t: TestApp;
  let logs: string[];

  const task = () => t.prisma.task.findFirstOrThrow();
  const specRow = async () => (await documentRows(t))[0];
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

  it('written before Spec v1 was posted → ONE "written before" reply, nothing approved, IGNORED approve-refused; run again → no second reply', async () => {
    const issue = await specWritten(t, 31);
    const spec = await specRow();

    const event = await deliver(t, commentNow(31, 3101, '/approve', 120));

    expect(event).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'approve-refused',
    });
    expect(replies(issue, 3101)).toEqual([
      expect.objectContaining({
        body:
          `${approveRefusedMarker('3101')}\nThis \`/approve\` was written before Spec v1 was posted, so it ` +
          `didn't count. Read [Spec v1](${spec.commentUrl}), then comment \`/approve\` again.`,
      }),
    ]);
    expect(await specRow()).toMatchObject({ approvedAt: null });
    expect(await actionRows(t)).toEqual([
      expect.objectContaining({
        action: 'approve-refused',
        result: 'before-document',
        documentId: spec.id,
        sourceCommentId: '3101',
        sender: HUMAN,
        replyPostState: 'POSTED',
        replyCommentId: replies(issue, 3101)[0].id,
      }),
    ]);
    expect(await task()).toMatchObject({ status: 'spec-review' });
    expect(logs).toContain(
      '#31 run 1 documents: /approve refused (before-document)',
    );

    await runAgain(t, event.id);

    expect(replies(issue, 3101)).toHaveLength(1);
    expect(await actionRows(t)).toHaveLength(1);
  });

  it('the Spec comment emptied between its markers → the `empty` reply', async () => {
    const issue = await specWritten(t, 32);
    const spec = await specRow();
    t.issues.editComment(
      spec.commentId!,
      spec.body.replace(
        /<!-- sdd-agent:document -->[\s\S]*<!-- sdd-agent:document-end -->/,
        `${DOCUMENT_START}\n\n${DOCUMENT_END}`,
      ),
    );

    await deliver(t, commentNow(32, 3201, '/approve'));

    expect(replies(issue, 3201)[0].body).toContain(
      "Spec v1's comment has no text left between its markers, so there's nothing to approve.",
    );
    expect(await actionRows(t)).toMatchObject([{ result: 'empty' }]);
  });

  it('the Spec comment deleted while the bot was stopped → the `deleted` reply; the deletion recorded without its text', async () => {
    const issue = await specWritten(t, 33);
    t.issues.deleteComment((await specRow()).commentId!);

    await deliver(t, commentNow(33, 3301, '/approve'));

    expect(replies(issue, 3301)[0].body).toContain(
      "Spec v1 was deleted, so there's nothing to approve. Comment `/restore` to get it back, or remove the " +
        '`workflow: full-sdd` label and add it again to start over.',
    );
    const spec = await specRow();
    expect(spec.deletedAt).not.toBeNull();
    expect(spec).toMatchObject({ deletedText: null, deletedBy: null });
    expect(await actionRows(t)).toMatchObject([{ result: 'deleted' }]);
  });

  it('approved by another event (the row set directly) → the `already-approved` reply', async () => {
    const issue = await specWritten(t, 34);
    await t.prisma.taskDocument.updateMany({
      data: { approvedAt: new Date(), approvedBy: 'carol' },
    });

    await deliver(t, commentNow(34, 3401, '/approve'));

    expect(replies(issue, 3401)[0].body).toContain(
      'Spec v1 is already approved (by `carol`), so this `/approve` changes nothing.',
    );
    expect(await actionRows(t)).toMatchObject([{ result: 'already-approved' }]);
  });

  it('each verdict is one getComment of the waiting document, no other read of it', async () => {
    await specWritten(t, 35);
    const spec = await specRow();
    t.issues.calls.length = 0;

    await deliver(t, commentNow(35, 3501, '/approve', 120));

    const reads = t.issues.calls.filter(
      ({ method }) => method === 'getComment',
    );
    expect(reads).toHaveLength(1);
    expect(reads[0].args[1]).toBe(spec.commentId);
  });

  it('a crash between the row and the post → the retried job posts the reply once (P34)', async () => {
    const issue = await specWritten(t, 36);
    t.issues.failNextOn(
      'postComment',
      new ProviderError('GitHub POST comment → 502', 'transient'),
    );

    const first = await deliver(t, commentNow(36, 3601, '/approve', 120));
    expect(first).toMatchObject({ status: 'PENDING' });
    expect(await actionRows(t)).toMatchObject([
      { replyPostState: 'PENDING_POST' },
    ]);
    await drainDueNow(t);

    expect(
      await t.prisma.webhookEvent.findUniqueOrThrow({
        where: { id: first.id },
      }),
    ).toMatchObject({ status: 'IGNORED', ignoreReason: 'approve-refused' });
    expect(replies(issue, 3601)).toHaveLength(1);
    expect(await actionRows(t)).toMatchObject([{ replyPostState: 'POSTED' }]);
  });
});

describe('/approve: approving the Spec (spec 7 "Approving")', () => {
  let t: TestApp;
  let logs: string[];

  const specRow = async () => (await documentRows(t))[0];
  const run = () => t.prisma.run.findFirstOrThrow();
  const compares = () =>
    t.repo.calls.filter(({ method }) => method === 'changedFiles');

  beforeAll(async () => {
    t = await startApp({ grill: 'real', documents: 'real' });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.repo.calls.length = 0;
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

  it('an edited Spec → `approved_text` is the edited document without header or notes; the edits counted; main unchanged → no compare', async () => {
    await specWritten(t, 41);
    const spec = await specRow();
    t.issues.editComment(
      spec.commentId!,
      spec.body.replace(
        'Split a bill evenly between the people in it.',
        'Split a bill evenly between the people in it, rounding down.\nThe payer is listed first.',
      ),
    );
    t.models.reply({ answer: PLAN_TEXT });

    await deliver(t, commentNow(41, 4101, '/approve'));

    const approved = await specRow();
    expect(approved.approvedText).toBe(
      SPEC_TEXT.trim().replace(
        'Split a bill evenly between the people in it.',
        'Split a bill evenly between the people in it, rounding down.\nThe payer is listed first.',
      ),
    );
    expect(approved.approvedText).not.toContain('**Spec v1**');
    expect(approved.approvedText).not.toContain('Model:');
    expect(approved).toMatchObject({
      approvedBy: HUMAN,
      approveCommentId: '4101',
      approvedCommit: spec.commit,
      linesAdded: 2,
      linesRemoved: 1,
      changedFiles: null,
      changedPaths: [],
      changedComplete: null,
      staleFiles: [],
    });
    expect(approved.approvedAt).not.toBeNull();
    expect(compares()).toEqual([]);
    // Row 17: the Plan follows.
    expect(await t.prisma.task.findFirstOrThrow()).toMatchObject({
      status: 'ready-for-dev',
    });
  });

  it('an unchanged Spec → 0 and 0; the log line', async () => {
    await specWritten(t, 42);
    t.models.reply({ answer: PLAN_TEXT });

    await deliver(t, commentNow(42, 4201, '/approve'));

    expect(await specRow()).toMatchObject({ linesAdded: 0, linesRemoved: 0 });
    expect(logs).toContain(
      `#42 run 1 spec: v1 approved by ${HUMAN} (0 files flagged, +0 −0 lines)`,
    );
  });

  it('a file the Spec read changed → in `stale_files` and `changed_paths`; a changed file it didn’t read → only in `changed_paths`', async () => {
    t.repo.seedFile('main', 'src/t43-read.ts', 'export const a = 1;\n');
    t.repo.seedFile('main', 'src/t43-other.ts', 'export const b = 1;\n');
    await specWritten(t, 43, { reads: ['src/t43-read.ts'] });
    t.repo.seedFile('main', 'src/t43-read.ts', 'export const a = 2;\n');
    t.repo.seedFile('main', 'src/t43-other.ts', 'export const b = 2;\n');
    t.models.reply({ answer: PLAN_TEXT });

    await deliver(t, commentNow(43, 4301, '/approve'));

    expect(await specRow()).toMatchObject({
      staleFiles: ['src/t43-read.ts'],
      changedPaths: ['src/t43-other.ts', 'src/t43-read.ts'],
      changedFiles: 2,
      changedComplete: true,
      approvedCommit: await t.repo.resolveRef('main'),
    });
    expect(compares()).toHaveLength(1);
    expect(logs).toContain(
      `#43 run 1 spec: v1 approved by ${HUMAN} (1 file flagged, +0 −0 lines)`,
    );
    t.repo.removeFile('main', 'src/t43-read.ts');
    t.repo.removeFile('main', 'src/t43-other.ts');
  });

  it('GitHub doesn’t know the commit (404) → not compared, the approval counts (SPW22, P32)', async () => {
    await specWritten(t, 44);
    t.repo.seedFile('main', 'src/t44.ts', 'x');
    vi.spyOn(t.repo, 'changedFiles').mockRejectedValueOnce(
      new ProviderError('GitHub GET compare → 404: Not Found', 'permanent', {
        status: 404,
      }),
    );
    t.models.reply({ answer: PLAN_TEXT });

    await deliver(t, commentNow(44, 4401, '/approve'));

    const approved = await specRow();
    expect(approved.approvedAt).not.toBeNull();
    expect(approved).toMatchObject({
      changedFiles: null,
      changedComplete: null,
      staleFiles: [],
    });
    expect(logs).toContain(
      `#44 run 1 spec: v1 approved by ${HUMAN} (not compared, +0 −0 lines)`,
    );
    t.repo.removeFile('main', 'src/t44.ts');
  });

  it('a 403 from the compare → the run stops at `spec` (row 28); nothing approved', async () => {
    await specWritten(t, 45);
    t.repo.seedFile('main', 'src/t45.ts', 'x');
    vi.spyOn(t.repo, 'changedFiles').mockRejectedValueOnce(
      new ProviderError('GitHub GET compare → 403: Forbidden', 'permanent', {
        status: 403,
      }),
    );

    const event = await deliver(t, commentNow(45, 4501, '/approve'));

    expect(event).toMatchObject({ status: 'FAILED' });
    expect(await run()).toMatchObject({ stopStep: 'spec' });
    expect(await specRow()).toMatchObject({ approvedAt: null });
    t.repo.removeFile('main', 'src/t45.ts');
  });

  it('the comment emptied between the gate and the approval (P16) → the `empty` reply, nothing approved, no next step', async () => {
    const issue = await specWritten(t, 46);
    const spec = await specRow();
    const getComment = t.issues.getComment.bind(t.issues);
    vi.spyOn(t.issues, 'getComment')
      .mockImplementationOnce(getComment)
      .mockResolvedValueOnce({
        body: `${DOCUMENT_START}\n${DOCUMENT_END}`,
        createdAt: spec.postedAt!,
      });

    const event = await deliver(t, commentNow(46, 4601, '/approve'));

    expect(event).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'approve-refused',
    });
    expect(withMarker(t, issue, approveRefusedMarker('4601'))).toHaveLength(1);
    expect(await specRow()).toMatchObject({ approvedAt: null });
    expect(await run()).toMatchObject({ stopStep: null });
  });
});
