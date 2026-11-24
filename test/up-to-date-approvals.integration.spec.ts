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
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import {
  PLAN_TEXT,
  actionRows,
  commentNow,
  documentRows,
  scriptReads,
  specWritten,
  withMarker,
  yours,
} from './documents-helpers.js';
import { HUMAN, issuesUnlabeled } from './fixtures/github/payloads.js';
import { captureLogs, laneAdded } from './grill-helpers.js';
import {
  deliver,
  drainDueNow,
  seedIssue,
  seedWorkflow,
} from './router-helpers.js';

// Spec 14 (`up-to-date-approvals`), plan T5: an `/approve` asks first when files its document read changed on `main`
// since its starting point, GitHub can't compare, or the change is large.

const REPO_URL = 'https://github.com/test-owner/test-repo';

describe('/approve asks first (spec 14)', () => {
  let t: TestApp;
  let logs: string[];
  let seeded: string[];

  const run = () => t.prisma.run.findFirstOrThrow();
  const task = () => t.prisma.task.findFirstOrThrow();
  const rows = async (kind: string) =>
    (await documentRows(t)).filter((row) => row.kind === kind);
  const questions = (issue: TaskRef) =>
    withMarker(t, issue, 'sdd-agent:approve-asked:');
  const replies = (issue: TaskRef, commentId: number) =>
    withMarker(t, issue, `:${commentId} -->`);
  const compares = () =>
    t.repo.calls.filter(({ method }) => method === 'changedFiles').length;
  const now = () => t.repo.resolveRef('main');
  const short = (sha: string | null) => `\`${sha!.slice(0, 7)}\``;
  /** A file on `main` (recorded, so the test removes it at the end). */
  const seed = (path: string, content: string) => {
    seeded.push(path);
    t.repo.seedFile('main', path, content);
  };

  /** Issue `number`, `full-sdd`: Spec v1 (reading `specReads`) approved, then Plan v1 (reading `planReads`) waits. */
  async function planWaiting(
    number: number,
    specReads: string[],
    planReads: string[],
  ) {
    const issue = await specWritten(t, number, { reads: specReads });
    scriptReads(t, planReads, PLAN_TEXT);
    expect(
      await deliver(t, commentNow(number, number * 100 + 1, '/approve')),
    ).toMatchObject({ status: 'DONE' });
    return issue;
  }

  beforeAll(async () => {
    t = await startApp({ grill: 'real', documents: 'real' });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.models.calls.length = 0;
    t.repo.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
    seedWorkflow(t.repo);
    seeded = [];
    seed('src/index.ts', 'export const a = 1;\n');
    seed('src/index.test.ts', 'export const t = 1;\n');
    logs = captureLogs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expect(t.models.remaining).toBe(0);
    for (const path of seeded) t.repo.removeFile('main', path);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('Spec v1, a file it read changed → ONE question, IGNORED approve-asked, nothing else moves; `/approve` again → Plan v1 (no ⚠️ line), NO reply to it', async () => {
    const issue = await specWritten(t, 1, { reads: ['src/index.ts'] });
    const [spec] = await rows('spec');
    seed('src/index.ts', 'export const a = 2;\n');
    const b1 = await now();
    const modelCalls = await t.prisma.executionLog.count();

    const event = await deliver(t, commentNow(1, 101, '/approve'));

    expect(event).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'approve-asked',
    });
    expect(questions(issue)).toEqual([
      expect.objectContaining({
        body:
          `<!-- sdd-agent:approve-asked:101 -->\n${yours('`/approve`', 1, 101)} didn't count yet: since Spec v1 ` +
          `was written (${short(spec.commit)}), \`main\` changed \`src/index.ts\`, which it read ` +
          `([compare](${REPO_URL}/compare/${spec.commit}...${b1})). Comment \`/refresh\` to bring it up to date ` +
          'with `main`, or `/approve` again to approve it as it is.',
      }),
    ]);
    expect(await task()).toMatchObject({ status: 'spec-review' });
    expect(t.issues.labelsOf(issue)).toContain('status: spec-review');
    expect(await rows('plan')).toEqual([]);
    expect(await t.prisma.executionLog.count()).toBe(modelCalls);
    expect((await rows('spec'))[0]).toMatchObject({
      askedCommit: b1,
      approvedAt: null,
    });
    const [question] = await actionRows(t);
    expect(question).toMatchObject({
      action: 'approve-asked',
      result: 'stale',
      documentId: spec.id,
      sourceCommentId: '101',
      fromCommit: spec.commit,
      toCommit: b1,
      files: [{ path: 'src/index.ts', readers: ['own'] }],
      changedFiles: 1,
      filesComplete: true,
      replyPostState: 'POSTED',
    });
    expect(question.replyPostedAt).not.toBeNull();
    expect(question.replyCommentId).toBe(questions(issue)[0].id);
    expect(question.replyCommentUrl).toBe(
      `${REPO_URL}/issues/1#issuecomment-${questions(issue)[0].id}`,
    );
    expect(logs).toContain(
      `#1 run 1 spec: v1 /approve asked (stale, 1 file read changed since ${spec.commit!.slice(0, 7)})`,
    );

    t.models.reply({ answer: PLAN_TEXT });
    const counted = await deliver(t, commentNow(1, 102, '/approve'));

    expect(counted).toMatchObject({ status: 'DONE' });
    const [plan] = await rows('plan');
    expect(plan.body).not.toContain('⚠️');
    expect(replies(issue, 102)).toEqual([]);
    expect((await rows('spec'))[0]).toMatchObject({
      approveCommentId: '102',
      staleFiles: ['src/index.ts'],
      approvedFromCommit: spec.commit,
      approvedCommit: b1,
    });
  });

  it('`main` moves after a question → a second question naming only the new file, "since the bot asked"; then an unrelated change → counts, `stale_files` holds both', async () => {
    const issue = await specWritten(t, 2, {
      reads: ['src/index.ts', 'src/index.test.ts'],
    });
    const [spec] = await rows('spec');
    seed('src/index.ts', 'export const a = 2;\n');
    await deliver(t, commentNow(2, 201, '/approve'));
    const [first] = await actionRows(t);
    seed('src/index.test.ts', 'export const t = 2;\n');
    const b2 = await now();

    await deliver(t, commentNow(2, 202, '/approve'));

    expect(questions(issue)).toHaveLength(2);
    const second = questions(issue)[1].body;
    expect(second).toContain(
      `didn't count yet: since [the bot asked](${first.replyCommentUrl}) (${short(first.toCommit)}), \`main\` ` +
        `changed \`src/index.test.ts\`, which Spec v1 read ([compare](${REPO_URL}/compare/${first.toCommit}...${b2})).`,
    );
    expect(second).not.toContain('`src/index.ts`');
    expect((await actionRows(t))[1]).toMatchObject({
      fromCommit: first.toCommit,
      toCommit: b2,
      files: [{ path: 'src/index.test.ts', readers: ['own'] }],
    });

    seed('notes/spec-14.md', 'unrelated');
    t.models.reply({ answer: PLAN_TEXT });
    await deliver(t, commentNow(2, 203, '/approve'));

    expect(await rows('plan')).toHaveLength(1);
    expect(replies(issue, 203)).toEqual([]);
    expect((await rows('spec'))[0]).toMatchObject({
      approvedFromCommit: spec.commit,
      staleFiles: ['src/index.test.ts', 'src/index.ts'],
      changedPaths: ['notes/spec-14.md', 'src/index.test.ts', 'src/index.ts'],
    });
  });

  it('only an unrelated change since the Spec → counts at once, NO question; one compare', async () => {
    const issue = await specWritten(t, 3, { reads: ['src/index.ts'] });
    seed('notes/spec-14.md', 'unrelated');
    t.models.reply({ answer: PLAN_TEXT });

    await deliver(t, commentNow(3, 301, '/approve'));

    expect(questions(issue)).toEqual([]);
    expect(await rows('plan')).toHaveLength(1);
    expect((await rows('spec'))[0]).toMatchObject({
      staleFiles: [],
      changedPaths: ['notes/spec-14.md'],
    });
    expect(compares()).toBe(1);
  });

  it('the Plan waits, a file only the approved Spec read changed → ONE question; `/approve` again → the `workspace` stop, NO other reply, NO `approve-warning` row', async () => {
    const issue = await planWaiting(4, ['src/index.test.ts'], ['src/index.ts']);
    seed('src/index.test.ts', 'export const t = 2;\n');

    await deliver(t, commentNow(4, 402, '/approve'));

    expect(questions(issue)).toHaveLength(1);
    expect(questions(issue)[0].body).toContain(
      'changed `src/index.test.ts`, which the approved Spec read ([compare](',
    );
    expect(questions(issue)[0].body).toContain(
      'Comment `/refresh` to bring Spec v1 and Plan v1 up to date with `main`, or `/approve` again to approve ' +
        'Plan v1 as it is.',
    );

    await deliver(t, commentNow(4, 403, '/approve'));

    expect(await run()).toMatchObject({ stopStep: 'workspace' });
    expect(replies(issue, 403)).toEqual([]);
    expect((await actionRows(t)).map(({ action }) => action)).toEqual([
      'approve-asked',
    ]);
  });

  it('spec-code: a question, `/approve` again → the stop; `/retry` after another read file changed → the same stop, NO question', async () => {
    const issue = await specWritten(t, 5, {
      lane: 'spec-code',
      reads: ['src/index.ts', 'src/index.test.ts'],
    });
    seed('src/index.ts', 'export const a = 2;\n');
    await deliver(t, commentNow(5, 501, '/approve'));
    expect(questions(issue)).toHaveLength(1);

    await deliver(t, commentNow(5, 502, '/approve'));
    expect(await run()).toMatchObject({ stopStep: 'workspace', stops: 1 });
    seed('src/index.test.ts', 'export const t = 2;\n');

    await deliver(t, commentNow(5, 503, '/retry'));

    expect(questions(issue)).toHaveLength(1);
    expect(await run()).toMatchObject({
      stopStep: 'workspace',
      stops: 2,
      retries: 1,
    });
    expect(await rows('plan')).toEqual([]);
  });

  it('code-only: any change, `/approve` on the go-signal → the stop, NO question, no compare', async () => {
    const issue = seedIssue(t, 6, { labels: ['workflow: code-only'] });
    await deliver(t, laneAdded(6, 'code-only'));
    seed('src/index.ts', 'export const a = 2;\n');

    await deliver(t, commentNow(6, 601, '/approve'));

    expect(await run()).toMatchObject({ stopStep: 'workspace' });
    expect(questions(issue)).toEqual([]);
    expect(compares()).toBe(0);
  });

  it('an unknown starting commit → ONE `not-compared` question, no compare link; `/approve` again → counts, `changed_complete` null', async () => {
    const issue = await specWritten(t, 7, { reads: ['src/index.ts'] });
    const [spec] = await rows('spec');
    const unknown = '0'.repeat(40);
    await t.prisma.taskDocument.update({
      where: { id: spec.id },
      data: { commit: unknown },
    });

    await deliver(t, commentNow(7, 701, '/approve'));

    expect(questions(issue)).toEqual([
      expect.objectContaining({
        body:
          `<!-- sdd-agent:approve-asked:701 -->\n${yours('`/approve`', 7, 701)} didn't count yet: the bot ` +
          "couldn't compare `0000000`, where Spec v1 was written, with `main` (that commit is no longer on GitHub, " +
          "e.g. after a force-push), so it can't tell whether files it read changed. Comment `/refresh` to check " +
          "it against today's `main`, or `/approve` again to approve it as it is.",
      }),
    ]);
    expect((await actionRows(t))[0]).toMatchObject({
      result: 'not-compared',
      files: [],
      changedFiles: null,
      filesComplete: null,
    });
    expect(logs).toContain('#7 run 1 spec: v1 /approve asked (not-compared)');

    t.models.reply({ answer: PLAN_TEXT });
    await deliver(t, commentNow(7, 702, '/approve'));

    expect(await rows('plan')).toHaveLength(1);
    expect((await rows('spec'))[0]).toMatchObject({
      approvedFromCommit: unknown,
      changedComplete: null,
      changedFiles: null,
    });
  });

  it('16 changed files, none read → ONE `large-change` question; 15 → counts at once', async () => {
    const issue = await specWritten(t, 8, { reads: ['src/index.ts'] });
    for (let i = 1; i <= 16; i++) seed(`bulk/f${i}.txt`, 'x');

    await deliver(t, commentNow(8, 801, '/approve'));

    expect(questions(issue)).toHaveLength(1);
    expect(questions(issue)[0].body).toContain(
      `didn't count yet: since Spec v1 was written (${short((await rows('spec'))[0].commit)}), 16 files changed on ` +
        '`main` ([compare](',
    );
    expect(questions(issue)[0].body).toContain(
      '), none of them one it read. A change this size may still affect it.',
    );
    expect((await actionRows(t))[0]).toMatchObject({
      result: 'large-change',
      files: [],
      changedFiles: 16,
      filesComplete: true,
    });
    expect(logs).toContain(
      '#8 run 1 spec: v1 /approve asked (large-change, 16 files)',
    );

    await resetDatabase(t.prisma);
    const fifteen = await specWritten(t, 9, { reads: ['src/index.ts'] });
    for (let i = 1; i <= 15; i++) seed(`bulk/g${i}.txt`, 'x');
    t.models.reply({ answer: PLAN_TEXT });

    await deliver(t, commentNow(9, 901, '/approve'));

    expect(questions(fifteen)).toEqual([]);
    expect(await rows('plan')).toHaveLength(1);
  });

  it('a cut list (300, `complete` false): none read → "more than 300 files changed"; with a read file → `stale` "… and possibly more"', async () => {
    const bulk = Array.from({ length: 300 }, (_, i) => `bulk/h${i}.txt`);
    const issue = await specWritten(t, 10, { reads: ['src/index.ts'] });
    seed('notes/x.md', 'moved');
    vi.spyOn(t.repo, 'changedFiles').mockResolvedValueOnce({
      paths: bulk,
      complete: false,
    });

    await deliver(t, commentNow(10, 1001, '/approve'));

    expect(questions(issue)[0].body).toContain(
      'more than 300 files changed on `main` ([compare](',
    );
    expect(questions(issue)[0].body).toContain(
      '); none of the 300 GitHub lists is one it read. A change this size may still affect it.',
    );
    expect((await actionRows(t))[0]).toMatchObject({
      result: 'large-change',
      changedFiles: 300,
      filesComplete: false,
    });

    await resetDatabase(t.prisma);
    const read = await specWritten(t, 11, { reads: ['src/index.ts'] });
    seed('notes/y.md', 'moved');
    vi.spyOn(t.repo, 'changedFiles').mockResolvedValueOnce({
      paths: [...bulk.slice(0, 299), 'src/index.ts'],
      complete: false,
    });

    await deliver(t, commentNow(11, 1101, '/approve'));

    expect(questions(read)[0].body).toContain(
      'changed `src/index.ts` … and possibly more, which it read ([compare](',
    );
    expect((await actionRows(t))[0]).toMatchObject({
      result: 'stale',
      filesComplete: false,
      changedFiles: 300,
    });
  });

  describe('the time rule and a pending question (plan T6)', () => {
    const refusals = (issue: TaskRef, commentId: number) =>
      withMarker(t, issue, approveRefusedMarker(String(commentId)));
    /** The next question's post fails once (a transient GitHub error): the event waits to be retried. */
    const questionPostFails = () => {
      const post = t.issues.postComment.bind(t.issues);
      vi.spyOn(t.issues, 'postComment').mockImplementationOnce((ref, body) =>
        body.includes('sdd-agent:approve-asked:')
          ? Promise.reject(
              new ProviderError('GitHub POST comment → 502', 'transient'),
            )
          : post(ref, body),
      );
    };

    it('two `/approve` written before the question → ONE question and ONE `before-question` reply linking it; NO Plan; then `/approve` → Plan v1', async () => {
      const issue = await specWritten(t, 21, { reads: ['src/index.ts'] });
      seed('src/index.ts', 'export const a = 2;\n');
      // The Spec was posted a minute ago, so `/approve` comments written seconds ago come after it.
      await t.prisma.taskDocument.updateMany({
        data: { postedAt: new Date(Date.now() - 60_000) },
      });

      await deliver(t, commentNow(21, 2101, '/approve', 3));
      const second = await deliver(t, commentNow(21, 2102, '/approve', 2));

      expect(questions(issue)).toHaveLength(1);
      const [question] = await actionRows(t);
      expect(second).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'approve-refused',
      });
      expect(refusals(issue, 2102)).toEqual([
        expect.objectContaining({
          body:
            `${approveRefusedMarker('2102')}\n${yours('`/approve`', 21, 2102)} was written before [the bot's ` +
            `question](${question.replyCommentUrl}), so it didn't count: read it, then comment \`/refresh\`, or ` +
            '`/approve` again.',
        }),
      ]);
      expect((await actionRows(t))[1]).toMatchObject({
        action: 'approve-refused',
        result: 'before-question',
      });
      expect(logs).toContain(
        '#21 run 1 documents: /approve refused (before-question)',
      );
      expect(await rows('plan')).toEqual([]);

      t.models.reply({ answer: PLAN_TEXT });
      await deliver(t, commentNow(21, 2103, '/approve'));

      expect(await rows('plan')).toHaveLength(1);
    });

    it('a question stored but not posted, then another `/approve` → the question posted first, then `before-question`; the first event’s retry posts nothing more', async () => {
      const issue = await specWritten(t, 22, { reads: ['src/index.ts'] });
      seed('src/index.ts', 'export const a = 2;\n');
      // The Spec was posted a minute ago, so `/approve` comments written seconds ago come after it.
      await t.prisma.taskDocument.updateMany({
        data: { postedAt: new Date(Date.now() - 60_000) },
      });
      questionPostFails();

      const first = await deliver(t, commentNow(22, 2201, '/approve', 2));
      expect(first).toMatchObject({ status: 'PENDING' });
      expect(questions(issue)).toEqual([]);

      await deliver(t, commentNow(22, 2202, '/approve', 1));

      expect(questions(issue)).toHaveLength(1);
      expect(refusals(issue, 2202)).toHaveLength(1);
      expect(refusals(issue, 2202)[0].body).toContain(
        "was written before [the bot's question](",
      );
      const comments = t.issues.calls.filter(
        ({ method }) => method === 'postComment',
      ).length;

      await drainDueNow(t);

      expect(
        t.issues.calls.filter(({ method }) => method === 'postComment'),
      ).toHaveLength(comments);
      expect(questions(issue)).toHaveLength(1);
      expect(
        await t.prisma.webhookEvent.findUniqueOrThrow({
          where: { id: first.id },
        }),
      ).toMatchObject({ status: 'IGNORED', ignoreReason: 'approve-asked' });
    });

    it('a retried asking event after the document was deleted → only its question, NO `deleted` reply', async () => {
      const issue = await specWritten(t, 23, { reads: ['src/index.ts'] });
      seed('src/index.ts', 'export const a = 2;\n');
      questionPostFails();
      const first = await deliver(t, commentNow(23, 2301, '/approve'));
      expect(first).toMatchObject({ status: 'PENDING' });
      t.issues.deleteComment((await rows('spec'))[0].commentId!);

      await drainDueNow(t);

      expect(questions(issue)).toHaveLength(1);
      expect(refusals(issue, 2301)).toEqual([]);
      expect(await actionRows(t)).toHaveLength(1);
    });

    it.each([
      ['stopped (`needs-human`)', 'needs-human'],
      ['ended', 'ended'],
    ] as const)(
      'a retried asking event after the run was %s → only its question, posted once; NO other reply (plan UP21)',
      async (_, state) => {
        const number = state === 'ended' ? 25 : 24;
        const issue = await specWritten(t, number, { reads: ['src/index.ts'] });
        seed('src/index.ts', 'export const a = 2;\n');
        questionPostFails();
        const first = await deliver(
          t,
          commentNow(number, number * 100 + 1, '/approve'),
        );
        expect(first).toMatchObject({ status: 'PENDING' });
        if (state === 'needs-human') {
          await t.prisma.task.updateMany({
            data: { status: 'needs-human', shownStatus: 'needs-human' },
          });
          await t.prisma.run.updateMany({
            data: { statusBeforeStop: 'spec-review' },
          });
        } else {
          t.issues.setHumanLabels(issue, []);
          await deliver(
            t,
            issuesUnlabeled({ number, label: 'workflow: full-sdd' }),
          );
          expect(await task()).toMatchObject({ currentRunId: null });
        }

        await drainDueNow(t);

        expect(questions(issue)).toHaveLength(1);
        expect(
          withMarker(t, issue, `:${number * 100 + 1} -->`).map(
            ({ body }) => body.split('\n')[0],
          ),
        ).toEqual([`<!-- sdd-agent:approve-asked:${number * 100 + 1} -->`]);
        expect(
          await t.prisma.webhookEvent.findUniqueOrThrow({
            where: { id: first.id },
          }),
        ).toMatchObject({ status: 'IGNORED', ignoreReason: 'approve-asked' });
        expect(await actionRows(t)).toHaveLength(1);
      },
    );
  });
});
