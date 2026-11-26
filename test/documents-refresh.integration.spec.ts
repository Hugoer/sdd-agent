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
import { LlmError } from '../src/contracts/llm-error.js';
import {
  approveRefusedMarker,
  refreshMarker,
  refusedMarker,
} from '../src/documents/document-comments.js';
import {
  DOCUMENT_END,
  DOCUMENT_START,
} from '../src/documents/document-text.js';
import { TaskService } from '../src/workflow/task.service.js';
import { issueClosedMarker } from '../src/workflow/workflow-comments.js';
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import {
  PLAN_TEXT,
  SPEC_TEXT,
  actionRows,
  commentNow,
  documentRows,
  runAgain,
  scriptReads,
  specWritten,
  withMarker,
  yours,
} from './documents-helpers.js';
import { HUMAN } from './fixtures/github/payloads.js';
import { captureLogs, laneAdded } from './grill-helpers.js';
import {
  deliver,
  drainDueNow,
  seedIssue,
  seedWorkflow,
} from './router-helpers.js';

// Spec 7 "`/refresh`" in `spec-review` (SP4, SP5, SPW7, SPW11, SPW17, SPW23; plan P5, P28, P32, P34, P35), "Replies
// where nothing waits" for `/refresh` (plan T19).

const SPEC_V2 = SPEC_TEXT.replace(
  'Split a bill evenly',
  'Split a bill evenly with `splitEvenly()`',
);

describe('/refresh while the Spec waits (spec 7)', () => {
  let t: TestApp;
  let logs: string[];

  const run = () => t.prisma.run.findFirstOrThrow();
  const specs = async () =>
    (await documentRows(t)).filter(({ kind }) => kind === 'spec');
  const replies = (issue: TaskRef, commentId: number) =>
    withMarker(t, issue, refreshMarker(String(commentId)));
  const modelLogs = () => t.prisma.executionLog.count();
  /** The refresh call's system text: the model's last call. */
  const frame = () => t.models.calls.at(-1)!.messages[0].text;
  const changed = (document = SPEC_V2) => ({
    upToDate: false,
    changes: ['The Spec names `splitEvenly()`, which replaced `split()`.'],
    document,
  });

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

  it('`main` unchanged → ONE nothing-changed reply, NO model call, the event DONE', async () => {
    const issue = await specWritten(t, 101);
    const [spec] = await specs();
    const before = await modelLogs();

    const event = await deliver(t, commentNow(101, 10101, '/refresh'));

    expect(event).toMatchObject({ status: 'DONE' });
    expect(replies(issue, 10101)).toEqual([
      expect.objectContaining({
        body:
          `${refreshMarker('10101')}\n${yours('`/refresh`', 101, 10101)} has nothing to refresh: nothing changed ` +
          `on \`main\` since Spec v1 was written (\`${spec.commit!.slice(0, 7)}\`).`,
      }),
    ]);
    expect(await modelLogs()).toBe(before);
    expect(await actionRows(t)).toEqual([
      expect.objectContaining({
        action: 'refresh',
        result: 'nothing-changed',
        documentId: spec.id,
        sourceCommentId: '10101',
        logIds: [],
        replyPostState: 'POSTED',
      }),
    ]);
    expect(logs).toContain('#101 run 1 documents: /refresh → nothing changed');
  });

  it('a file the Spec read changed → ONE Spec v2 (both commits, What changed, the diff); v1 superseded; an `/approve` written before v2 → "written before Spec v2"', async () => {
    t.repo.seedFile('main', 'src/r102.ts', 'export const a = 1;\n');
    const issue = await specWritten(t, 102, { reads: ['src/r102.ts'] });
    const [v1] = await specs();
    t.repo.seedFile('main', 'src/r102.ts', 'export const a = 2;\n');
    const now = await t.repo.resolveRef('main');
    t.models.replyJson(changed());

    const event = await deliver(t, commentNow(102, 10201, '/refresh'));

    expect(event).toMatchObject({ status: 'DONE' });
    expect(frame()).toContain(
      `These files changed since, * marking the ones the Spec read: src/r102.ts *.`,
    );
    const [old, v2] = await specs();
    expect(old.supersededAt).not.toBeNull();
    expect(v2).toMatchObject({
      version: 2,
      origin: 'refreshed',
      basedOnId: v1.id,
      commit: now,
      triggerCommentId: '10201',
      changes: ['The Spec names `splitEvenly()`, which replaced `split()`.'],
      postState: 'POSTED',
    });
    expect(v2.text).toBe(SPEC_V2.trim());
    expect(v2.body).toContain(
      `**Spec v2** · run 1 (\`full-sdd\`) · replaces v1 above · read at \`main\` @ \`${now.slice(0, 7)}\` (v1: ` +
        `\`${v1.commit!.slice(0, 7)}\`, [compare](https://github.com/test-owner/test-repo/compare/${v1.commit}...${now}))`,
    );
    expect(v2.body).toContain(
      `Refreshed for [\`${HUMAN}\`'s \`/refresh\`](https://github.com/test-owner/test-repo/issues/102#issuecomment-10201). ` +
        'What changed:\n- The Spec names `splitEvenly()`, which replaced `split()`.',
    );
    expect(v2.body).toContain(
      '<details><summary>Diff from v1 (as it read at the refresh)</summary>',
    );
    expect(v2.body).toContain(
      '-Split a bill evenly between the people in it.\n+Split a bill evenly with `splitEvenly()` between the people in it.',
    );
    expect(withMarker(t, issue, 'sdd-agent:spec:')).toHaveLength(2);
    expect(await actionRows(t)).toEqual([
      expect.objectContaining({
        action: 'refresh',
        result: 'spec-changed',
        documentId: v2.id,
        logIds: [v2.logId],
        replyBody: null,
      }),
    ]);
    expect(logs).toContain('#102 run 1 documents: /refresh → spec v2');

    await deliver(t, commentNow(102, 10202, '/approve', 2));

    expect(
      withMarker(t, issue, approveRefusedMarker('10202'))[0].body,
    ).toContain('was written before Spec v2 was posted');
  });

  it('up to date → the reply with the files and the notes, `checked_commit` = B; a second `/refresh` at B → nothing changed since it was last checked (SPW11)', async () => {
    t.repo.seedFile('main', 'src/r103.ts', 'export const a = 1;\n');
    const issue = await specWritten(t, 103, { reads: ['src/r103.ts'] });
    const [spec] = await specs();
    t.repo.seedFile('main', 'src/r103.ts', 'export const a = 2;\n');
    const now = await t.repo.resolveRef('main');
    t.models.replyJson({ upToDate: true, changes: [], document: '' });

    await deliver(t, commentNow(103, 10301, '/refresh'));

    const [body] = replies(issue, 10301).map(({ body }) => body);
    expect(body).toContain(
      `${yours('`/refresh`', 103, 10301)} checked Spec v1 against \`main\` @ \`${now.slice(0, 7)}\`: still up to ` +
        `date. 1 file changed since \`${spec.commit!.slice(0, 7)}\` ([compare](https://github.com/test-owner/test-repo/` +
        `compare/${spec.commit}...${now})); nothing in the Spec needs to change.\n\n---\n<sub>Model: `,
    );
    expect((await specs())[0]).toMatchObject({ checkedCommit: now });
    const [row] = await actionRows(t);
    expect(row).toMatchObject({ result: 'up-to-date', documentId: spec.id });
    expect(row.logIds).toHaveLength(1);
    expect(logs).toContain('#103 run 1 documents: /refresh → up to date');

    await deliver(t, commentNow(103, 10302, '/refresh'));

    expect(replies(issue, 10302)[0].body).toContain(
      `has nothing to refresh: nothing changed on \`main\` since Spec v1 was last checked (\`${now.slice(0, 7)}\`).`,
    );

    // Spec 14: the approval's range starts where the refresh found it up to date.
    t.models.reply({ answer: PLAN_TEXT });
    await deliver(t, commentNow(103, 10303, '/approve'));

    expect((await specs())[0]).toMatchObject({
      approvedFromCommit: now,
      approvedCommit: now,
    });
  });

  it('deleted (not seen), emptied, or already approved → ONE reply each, NO model call, `IGNORED` `refresh-refused`', async () => {
    const deleted = await specWritten(t, 104);
    t.issues.deleteComment((await specs())[0].commentId!);
    const before = await modelLogs();

    const first = await deliver(t, commentNow(104, 10401, '/refresh'));

    expect(first).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'refresh-refused',
    });
    expect(replies(deleted, 10401)[0].body).toContain(
      'has nothing to refresh: Spec v1 was deleted. Comment `/restore` to get it back, then `/refresh`.',
    );
    expect((await specs())[0]).toMatchObject({ deletedText: null });
    expect((await specs())[0].deletedAt).not.toBeNull();

    await resetDatabase(t.prisma);
    const emptied = await specWritten(t, 105);
    const [spec] = await specs();
    t.issues.editComment(
      spec.commentId!,
      spec.body.replace(
        /<!-- sdd-agent:document -->[\s\S]*<!-- sdd-agent:document-end -->/,
        `${DOCUMENT_START}\n\n${DOCUMENT_END}`,
      ),
    );
    await deliver(t, commentNow(105, 10501, '/refresh'));
    expect(replies(emptied, 10501)[0].body).toContain(
      "has nothing to refresh: Spec v1's comment has no text left between its markers.",
    );

    await resetDatabase(t.prisma);
    const approved = await specWritten(t, 106, { lane: 'spec-code' });
    await t.prisma.taskDocument.updateMany({
      data: { approvedAt: new Date(), approvedBy: 'carol' },
    });
    await deliver(t, commentNow(106, 10601, '/refresh'));
    expect(replies(approved, 10601)[0].body).toContain(
      "can't refresh Spec v1: it's already approved.",
    );
    expect(await actionRows(t)).toMatchObject([
      { action: 'refresh', result: 'already-approved' },
    ]);
    expect(await modelLogs()).toBeGreaterThanOrEqual(before);
    expect(logs).toContain(
      '#106 run 1 documents: /refresh refused (already-approved)',
    );
  });

  it.each([
    [
      'grilling',
      "has nothing to refresh yet: run 1 is still at Grill Me, so there's no Spec.",
    ],
    ['draft', 'has nothing to refresh yet: run 1 is just starting.'],
    [
      'executing',
      'comes too late: run 1 is already writing the code from the approved texts.',
    ],
    ['in-review', "comes too late: run 1's pull request is open."],
    [
      'needs-human',
      'has nothing to refresh now: run 1 is stopped. Continue it first (see the stop comment), then comment `/refresh`.',
    ],
  ] as const)(
    '`/refresh` in %s (status set in the test database) → ONE reply, `IGNORED` `refresh-refused`',
    async (status, text) => {
      const number =
        110 +
        ['grilling', 'draft', 'executing', 'in-review', 'needs-human'].indexOf(
          status,
        );
      const issue = await specWritten(t, number);
      await t.prisma.task.updateMany({ data: { status, shownStatus: status } });
      const commentId = number * 100 + 1;

      const event = await deliver(t, commentNow(number, commentId, '/refresh'));

      expect(event).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'refresh-refused',
      });
      expect(
        withMarker(t, issue, refusedMarker('refresh', String(commentId))),
      ).toEqual([
        expect.objectContaining({
          body: `${refusedMarker('refresh', String(commentId))}\n${yours('`/refresh`', number, commentId)} ${text}`,
        }),
      ]);
      expect(await actionRows(t)).toMatchObject([
        { action: 'refresh-refused', sourceCommentId: String(commentId) },
      ]);
    },
  );

  it('a `code-only` run → ONE "no Spec or Plan" reply; no run → ONE reply naming the label (P40); closed → spec 5\'s reply; no access → nothing', async () => {
    const codeOnly = seedIssue(t, 120, { labels: ['workflow: code-only'] });
    await deliver(t, laneAdded(120, 'code-only'));
    await deliver(t, commentNow(120, 12001, '/refresh'));
    expect(
      withMarker(t, codeOnly, refusedMarker('refresh', '12001'))[0].body,
    ).toContain(
      'has nothing to refresh: a `code-only` run has no Spec or Plan; the bot codes from the issue description as ' +
        'it reads at `/approve`.',
    );

    const noRun = seedIssue(t, 121, { labels: ['workflow: full-sdd'] });
    const refused = await deliver(t, commentNow(121, 12101, '/refresh'));
    expect(refused).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'refresh-refused',
    });
    expect(
      withMarker(t, noRun, refusedMarker('refresh', '12101'))[0].body,
    ).toContain(
      'has nothing to refresh: `workflow: full-sdd` is on, but the bot has no run for it yet.',
    );
    expect(await actionRows(t)).toContainEqual(
      expect.objectContaining({
        action: 'refresh-refused',
        result: 'no-run',
        runId: null,
      }),
    );

    const closed = await specWritten(t, 122);
    t.issues.setOpen(closed, false);
    const onClosed = await deliver(t, commentNow(122, 12201, '/refresh'));
    expect(
      withMarker(t, closed, issueClosedMarker(onClosed.deliveryId))[0].body,
    ).toContain('This issue is closed, so `/refresh` did nothing.');

    const open = await specWritten(t, 123);
    t.issues.setAccessLevel(HUMAN, 'none');
    const unauthorized = await deliver(t, commentNow(123, 12301, '/refresh'));
    expect(unauthorized).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'unauthorized',
    });
    expect(replies(open, 12301)).toEqual([]);
  });

  it('the refresh call fails → the stop at `spec`; `/retry` → ONE Spec v2; the event run again after its Tx2 → no second comment, no model call (P34)', async () => {
    const issue = await specWritten(t, 130);
    t.repo.seedFile('main', 'src/r130.ts', 'export const a = 2;\n');
    t.models.reply({
      error: new LlmError(
        'Google blocked the answer',
        'permanent',
        'answer-blocked',
      ),
    });

    const refresh = await deliver(t, commentNow(130, 13001, '/refresh'));

    expect(refresh).toMatchObject({ status: 'FAILED' });
    expect(await run()).toMatchObject({ stopStep: 'spec' });
    t.models.replyJson(changed());

    await deliver(t, commentNow(130, 13002, '/retry'));

    expect(withMarker(t, issue, 'sdd-agent:spec:')).toHaveLength(2);
    expect((await specs()).map(({ version }) => version)).toEqual([1, 2]);

    await runAgain(t, refresh.id);

    expect(withMarker(t, issue, 'sdd-agent:spec:')).toHaveLength(2);
    expect(await actionRows(t)).toHaveLength(1);
    t.repo.removeFile('main', 'src/r130.ts');
  });

  it("a too-long document three times → the stop at `spec` with P2's schema message", async () => {
    await specWritten(t, 131);
    t.repo.seedFile('main', 'src/r131.ts', 'export const a = 2;\n');
    const long = changed('x'.repeat(60_000));
    t.models.replyJson(long).replyJson(long).replyJson(long);

    const event = await deliver(t, commentNow(131, 13101, '/refresh'));

    expect(event).toMatchObject({ status: 'FAILED' });
    const stopped = await run();
    expect(stopped.stopStep).toBe('spec');
    expect(stopped.stopMessage).toContain(
      'gave no valid answer: document: 60,000 characters, at most 50,000 fit',
    );
    t.repo.removeFile('main', 'src/r131.ts');
  });
});

// Spec 7 "`/refresh`" in `ready-for-dev`, `full-sdd` (SPW8, SPW17; plan P28, P34, P35; plan T20). Spec 13: the Plan waits under `plan-review`.

const PLAN_V2 = PLAN_TEXT.replace('`split()`', '`splitEvenly()`');

describe('/refresh while the Plan waits (spec 7, full-sdd)', () => {
  let t: TestApp;
  let logs: string[];

  const task = () => t.prisma.task.findFirstOrThrow();
  const run = () => t.prisma.run.findFirstOrThrow();
  const rows = async (kind: string) =>
    (await documentRows(t)).filter((row) => row.kind === kind);
  const replies = (issue: TaskRef, commentId: number) =>
    withMarker(t, issue, refreshMarker(String(commentId)));
  const isFrame =
    (kind: 'Spec' | 'Plan') => (call: (typeof t.models.calls)[number]) =>
      call.messages[0].text.startsWith(
        `You are the ${kind} step of a spec-driven workflow on a GitHub issue, asked to bring`,
      );
  const UP_TO_DATE = { upToDate: true, changes: [], document: '' };

  /** Spec v1 (it reads `src/f-spec.ts`), approved; Plan v1 (it reads `src/f-plan.ts`) waits. */
  async function planWaiting(number: number) {
    const issue = await specWritten(t, number, { reads: ['src/f-spec.ts'] });
    scriptReads(t, ['src/f-plan.ts'], PLAN_TEXT);
    expect(
      await deliver(t, commentNow(number, number * 100, '/approve')),
    ).toMatchObject({ status: 'DONE' });
    expect(await task()).toMatchObject({ status: 'plan-review' });
    return issue;
  }

  beforeAll(async () => {
    t = await startApp({ grill: 'real', documents: 'real' });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.models.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    seedWorkflow(t.repo);
    t.repo.seedFile('main', 'src/f-spec.ts', 'export const s = 1;\n');
    t.repo.seedFile('main', 'src/f-plan.ts', 'export const p = 1;\n');
    logs = captureLogs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expect(t.models.remaining).toBe(0);
    for (const path of ['src/f-spec.ts', 'src/f-plan.ts'])
      t.repo.removeFile('main', path);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('a change that makes the approved Spec wrong → ONE Spec v2 ("Plan v1 … no longer counts"), `spec-review`; `/approve` → Plan v2, written', async () => {
    const issue = await planWaiting(140);
    t.repo.seedFile('main', 'src/f-spec.ts', 'export const s = 2;\n');
    t.models.replyJson({
      upToDate: false,
      changes: ['Names `splitEvenly()`.'],
      document: SPEC_V2,
    });

    const event = await deliver(t, commentNow(140, 14001, '/refresh'));

    expect(event).toMatchObject({ status: 'DONE' });
    expect(t.models.calls.filter(isFrame('Plan'))).toHaveLength(0);
    expect(await task()).toMatchObject({ status: 'spec-review' });
    const [v1, v2] = await rows('spec');
    expect(v1.supersededAt).not.toBeNull();
    expect(v2).toMatchObject({
      version: 2,
      origin: 'refreshed',
      basedOnId: v1.id,
    });
    expect(v2.body).toContain(
      'Plan v1 was written from Spec v1, so it no longer counts: approve this Spec and the bot writes a new Plan.',
    );
    expect(v2.body).toContain(
      '<details><summary>Diff from v1 (as it read at the refresh)</summary>',
    );
    expect((await rows('plan'))[0].supersededAt).not.toBeNull();
    expect(await actionRows(t)).toMatchObject([
      {
        action: 'refresh',
        result: 'spec-changed',
        documentId: v2.id,
        replyBody: null,
      },
    ]);
    expect(replies(issue, 14001)).toEqual([]);

    t.models.reply({ answer: PLAN_TEXT });
    await deliver(t, commentNow(140, 14002, '/approve'));

    expect((await rows('plan')).at(-1)).toMatchObject({
      version: 2,
      origin: 'written',
      basedOnId: v2.id,
    });
    expect(await task()).toMatchObject({ status: 'plan-review' });
  });

  it('a change only the Plan\'s files see → ONE Plan v2 ("The approved Spec v1 is still up to date."); status stays `plan-review`; the row has both calls', async () => {
    const issue = await planWaiting(141);
    const [planV1] = await rows('plan');
    t.repo.seedFile('main', 'src/f-plan.ts', 'export const p = 2;\n');
    const now = await t.repo.resolveRef('main');
    t.models.replyJson(UP_TO_DATE).replyJson({
      upToDate: false,
      changes: ['Uses `splitEvenly()`.'],
      document: PLAN_V2,
    });

    await deliver(t, commentNow(141, 14101, '/refresh'));

    expect(await task()).toMatchObject({ status: 'plan-review' });
    expect(t.models.calls.at(-1)!.messages[0].text).toContain(
      'These files changed since, * marking the ones the Plan read: src/f-plan.ts *.',
    );
    const [, planV2] = await rows('plan');
    expect(planV2).toMatchObject({
      version: 2,
      origin: 'refreshed',
      basedOnId: planV1.id,
      commit: now,
    });
    expect(planV2.body).toContain(
      `**Plan v2** · run 1 (\`full-sdd\`) · from the approved Spec v1 · replaces v1 above · read at \`main\` @ ` +
        `\`${now.slice(0, 7)}\``,
    );
    expect(planV2.body).toContain(
      `Refreshed for [\`${HUMAN}\`'s \`/refresh\`](https://github.com/test-owner/test-repo/issues/141#issuecomment-14101). ` +
        'The approved Spec v1 is still up to date. What changed:\n- Uses `splitEvenly()`.',
    );
    expect((await rows('spec'))[0]).toMatchObject({ checkedCommit: now });
    const [row] = await actionRows(t);
    expect(row).toMatchObject({
      result: 'plan-changed',
      documentId: planV2.id,
      replyBody: null,
    });
    expect(row.logIds).toHaveLength(2);
    expect(withMarker(t, issue, 'sdd-agent:plan:')).toHaveLength(2);
    expect(replies(issue, 14101)).toEqual([]);
    expect(logs).toContain('#141 run 1 documents: /refresh → plan v2');
  });

  it('both still right → ONE "both still up to date" reply; the Plan\'s starting point moves (SPW11)', async () => {
    const issue = await planWaiting(142);
    t.repo.seedFile('main', 'src/f-plan.ts', 'export const p = 2;\n');
    const now = await t.repo.resolveRef('main');
    t.models.replyJson(UP_TO_DATE).replyJson(UP_TO_DATE);

    await deliver(t, commentNow(142, 14201, '/refresh'));

    expect(replies(issue, 14201)).toHaveLength(1);
    expect(replies(issue, 14201)[0].body).toContain(
      `${yours('`/refresh`', 142, 14201)} checked Spec v1 and Plan v1 against \`main\` @ \`${now.slice(0, 7)}\`: ` +
        'both still up to date.',
    );
    expect((await rows('plan'))[0]).toMatchObject({ checkedCommit: now });
    const [row] = await actionRows(t);
    expect(row).toMatchObject({ result: 'up-to-date' });
    expect(row.logIds).toHaveLength(2);
  });

  it('nothing changed since the Spec and the Plan → ONE reply for both, NO model call; the Plan written at B after a Spec check → "already written at that commit"', async () => {
    const issue = await planWaiting(143);
    const [spec] = await rows('spec');

    await deliver(t, commentNow(143, 14301, '/refresh'));

    expect(replies(issue, 14301)[0].body).toContain(
      `has nothing to refresh: nothing changed on \`main\` since Spec v1 and Plan v1 were written ` +
        `(\`${spec.commit!.slice(0, 7)}\`).`,
    );
    expect(t.models.calls.filter(isFrame('Spec'))).toHaveLength(0);

    await resetDatabase(t.prisma);
    await specWritten(t, 144, { reads: ['src/f-spec.ts'] });
    t.repo.seedFile('main', 'src/f-spec.ts', 'export const s = 3;\n');
    const now = await t.repo.resolveRef('main');
    // Spec 14: a question first, then `/approve` again writes the Plan.
    expect(await deliver(t, commentNow(144, 14399, '/approve'))).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'approve-asked',
    });
    t.models.reply({ answer: PLAN_TEXT });
    const later = await deliver(t, commentNow(144, 14400, '/approve'));
    expect(later).toMatchObject({ status: 'DONE' });
    t.models.replyJson(UP_TO_DATE);

    await deliver(t, commentNow(144, 14401, '/refresh'));

    const [body] = (await actionRows(t))
      .filter(({ action }) => action === 'refresh')
      .map(({ replyBody }) => replyBody);
    expect(body).toContain(
      `checked Spec v1 against \`main\` @ \`${now.slice(0, 7)}\`: still up to date, and Plan v1 was already ` +
        'written at that commit.',
    );
  });

  it("the Plan's refresh call fails → the stop at `plan`; `/retry` → the Spec step makes no second call (P28), ONE answer", async () => {
    const issue = await planWaiting(145);
    t.repo.seedFile('main', 'src/f-plan.ts', 'export const p = 2;\n');
    t.models.replyJson(UP_TO_DATE).reply({
      error: new LlmError(
        'Google blocked the answer',
        'permanent',
        'answer-blocked',
      ),
    });

    const refresh = await deliver(t, commentNow(145, 14501, '/refresh'));

    expect(refresh).toMatchObject({ status: 'FAILED' });
    expect(await run()).toMatchObject({ stopStep: 'plan' });
    const specCalls = t.models.calls.filter(isFrame('Spec')).length;
    t.models.replyJson(UP_TO_DATE);

    await deliver(t, commentNow(145, 14502, '/retry'));

    expect(t.models.calls.filter(isFrame('Spec'))).toHaveLength(specCalls);
    expect(replies(issue, 14501)).toHaveLength(1);
    expect(await actionRows(t)).toMatchObject([{ result: 'up-to-date' }]);
  });

  it('the Plan comment deleted (or emptied), then `/refresh` → ONE reply, NO model call, no Spec v2', async () => {
    const issue = await planWaiting(146);
    t.issues.deleteComment((await rows('plan'))[0].commentId!);
    const before = await t.prisma.executionLog.count();

    const event = await deliver(t, commentNow(146, 14601, '/refresh'));

    expect(event).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'refresh-refused',
    });
    expect(replies(issue, 14601)[0].body).toContain(
      'has nothing to refresh: Plan v1 was deleted. Comment `/restore` to get it back, then `/refresh`.',
    );
    expect(await t.prisma.executionLog.count()).toBe(before);
    expect(await rows('spec')).toHaveLength(1);

    await resetDatabase(t.prisma);
    const emptied = await planWaiting(147);
    const [plan] = await rows('plan');
    t.issues.editComment(
      plan.commentId!,
      plan.body.replace(
        /<!-- sdd-agent:document -->[\s\S]*<!-- sdd-agent:document-end -->/,
        `${DOCUMENT_START}\n\n${DOCUMENT_END}`,
      ),
    );
    await deliver(t, commentNow(147, 14701, '/refresh'));
    expect(replies(emptied, 14701)[0].body).toContain(
      "has nothing to refresh: Plan v1's comment has no text left between its markers. Edit the comment to put the " +
        'Plan back, then comment `/refresh`.',
    );
  });

  it('Spec v2 posted, then the status write fails → the retried event returns `SPEC_REFRESHED` from the row (P34): `spec-review`, no second comment, no call', async () => {
    const issue = await planWaiting(148);
    t.repo.seedFile('main', 'src/f-spec.ts', 'export const s = 2;\n');
    t.models.replyJson({ upToDate: false, changes: ['x'], document: SPEC_V2 });
    const tasks = t.app.get(TaskService);
    const setStatus = tasks.setStatus.bind(tasks);
    vi.spyOn(tasks, 'setStatus').mockImplementationOnce((lease, status) =>
      status === 'spec-review'
        ? Promise.reject(new Error('status write broke'))
        : setStatus(lease, status),
    );

    const first = await deliver(t, commentNow(148, 14801, '/refresh'));
    expect(first).toMatchObject({ status: 'PENDING' });
    const calls = t.models.calls.length;

    await drainDueNow(t);

    expect(
      await t.prisma.webhookEvent.findUniqueOrThrow({
        where: { id: first.id },
      }),
    ).toMatchObject({ status: 'DONE' });
    expect(await task()).toMatchObject({ status: 'spec-review' });
    expect(withMarker(t, issue, 'sdd-agent:spec:')).toHaveLength(2);
    expect(replies(issue, 14801)).toEqual([]);
    expect(t.models.calls).toHaveLength(calls);
  });
});
