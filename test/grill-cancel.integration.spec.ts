import { randomUUID } from 'node:crypto';
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
import { ProviderError } from '../src/contracts/provider-error.js';
import { GrillHandler } from '../src/grill/grill.handler.js';
import { GrillService } from '../src/grill/grill.service.js';
import { runEndedMarker } from '../src/workflow/workflow-comments.js';
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import {
  HUMAN,
  issueCommentCreated,
  issuesLabeled,
  issuesUnlabeled,
} from './fixtures/github/payloads.js';
import {
  askedRound1,
  botComments,
  captureLogs,
  commented,
  grillAnswer,
  grillRows,
  laneAdded,
} from './grill-helpers.js';
import {
  deliver,
  drainDueNow,
  seedIssue,
  seedWorkflow,
  store,
} from './router-helpers.js';

// Spec 6 "Cancel and restart: the answers block" (GM10, GM16, GM17) and `GrillService.transcript()`, plan T19.

const CANCEL_HEADER =
  "**Your Grill Me answers from run 1.** The next run starts from the issue description and won't see them. " +
  'Add them to the description before a new run starts, paste them into your first reply to its questions, or ' +
  'edit them into its Spec before `/approve`.';
const failing = () =>
  new LlmError(
    'scripted call to `gemini-4-hydrogen` failed',
    'permanent',
    'bad-request',
  );

describe('Grill Me when a run ends (spec 6)', () => {
  let t: TestApp;

  const event = (id: string) =>
    t.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
  const firstRun = () =>
    t.prisma.run.findFirstOrThrow({ orderBy: { number: 'asc' } });
  const sent = (call: number) =>
    t.models.calls[call].messages.map((message) => message.text).join('\n');
  /** Spec 5's run-ended comment for this run. */
  const endedComments = (issue: TaskRef, runId: string) =>
    botComments(t, issue)
      .map(({ body }) => body)
      .filter((body) => body.startsWith(runEndedMarker(runId)));
  /** A human removes the lane label (every other label stays). */
  const removeLane = (
    issue: TaskRef,
    number: number,
    keep: string[] = [],
    lane = 'full-sdd',
  ) => {
    t.issues.setHumanLabels(issue, keep);
    return issuesUnlabeled({ number, label: `workflow: ${lane}` });
  };

  beforeAll(async () => {
    t = await startApp({ grill: 'real' });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.models.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'approver');
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

  describe('the answers block (GM10)', () => {
    it('two answered rounds, the label removed → one run-ended comment ending with the block, session CANCELLED, `status: draft`', async () => {
      const issue = await askedRound1(t, 81);
      t.models
        .replyJson(grillAnswer({ confidence: 60, questions: 1, open: [2] }))
        .replyJson(grillAnswer({ confidence: 70, open: [2] }));
      await deliver(t, commented(81, 8101, 'Q1: only the creator.'));
      await deliver(t, commented(81, 8102, 'Q3: weekly.'));

      const row = await deliver(t, removeLane(issue, 81));

      expect(row).toMatchObject({ status: 'DONE' });
      const run = await firstRun();
      expect(endedComments(issue, run.id)).toEqual([
        [
          runEndedMarker(run.id),
          `Run 1 (\`full-sdd\`) was cancelled: \`${HUMAN}\` removed \`workflow: full-sdd\`.`,
          'To start again, add one `workflow:` label.',
          '',
          CANCEL_HEADER,
          '```text',
          'Q1. Question 1?',
          '    Guess: Guess 1.',
          'Q2. Question 2?',
          '    Guess: Guess 2.',
          `${HUMAN}: Q1: only the creator.`,
          '',
          'Q3. Question 1?',
          '    Guess: Guess 1.',
          `${HUMAN}: Q3: weekly.`,
          '```',
        ].join('\n'),
      ]);
      const { session } = await grillRows(t);
      expect(session).toMatchObject({ status: 'CANCELLED', rounds: 2 });
      expect(session?.endedAt).toBeInstanceOf(Date);
      expect(await t.prisma.task.findFirstOrThrow()).toMatchObject({
        status: 'draft',
      });
    });

    it('GM17: the lane swapped → the "replaced" comment’s block names run 2; run 2 starts at Q1 and its prompt has none of the old answers', async () => {
      const issue = await askedRound1(t, 82);
      t.models.replyJson(grillAnswer({ confidence: 60, open: [2] }));
      await deliver(t, commented(82, 8201, 'Q1: OLD-ANSWER the creator.'));
      t.models.replyJson(grillAnswer({ confidence: 40, questions: 2 }));
      t.issues.setHumanLabels(issue, ['workflow: spec-code']);

      const swap = await deliver(t, laneAdded(82, 'spec-code'));

      expect(swap).toMatchObject({ status: 'DONE' });
      const run = await firstRun();
      const [replaced] = endedComments(issue, run.id);
      expect(replaced).toContain('was replaced by run 2 (`spec-code`)');
      expect(replaced).toContain(
        "**Your Grill Me answers from run 1.** Run 2 started from the issue description and won't see them: " +
          'paste them into your first reply to its questions, or edit them into its Spec before `/approve`.',
      );
      expect(replaced).toContain(`${HUMAN}: Q1: OLD-ANSWER the creator.`);
      const sessions = await t.prisma.grillSession.findMany({
        orderBy: { startedAt: 'asc' },
      });
      expect(sessions.map(({ status }) => status)).toEqual([
        'CANCELLED',
        'ASKING',
      ]);
      const newRound = await t.prisma.grillRound.findFirstOrThrow({
        where: { sessionId: sessions[1].id },
      });
      expect(
        (newRound.questions as { number: number }[]).map(
          ({ number }) => number,
        ),
      ).toEqual([1, 2]);
      expect(sent(2)).not.toContain('OLD-ANSWER');
      expect(sent(2)).toContain(
        'New comments since the last call: None. This is the first evaluation.',
      );
    });

    it('no answer → no block; the session CANCELLED', async () => {
      const issue = await askedRound1(t, 83);

      await deliver(t, removeLane(issue, 83));

      const run = await firstRun();
      const [ended] = endedComments(issue, run.id);
      expect(ended).toContain('was cancelled');
      expect(ended).not.toContain('Your Grill Me answers');
      expect((await grillRows(t)).session).toMatchObject({
        status: 'CANCELLED',
      });
    });
  });

  describe('answers not read yet (GM16)', () => {
    it('an answer the failed call never read and one written while stopped → in the block; one received after the ending event → not', async () => {
      const issue = await askedRound1(t, 84);
      t.models.reply({ error: failing() });
      expect(await deliver(t, commented(84, 8401, 'Q1: yes.'))).toMatchObject({
        status: 'FAILED',
      });
      expect(
        await deliver(t, commented(84, 8402, 'Q2: monthly.')),
      ).toMatchObject({ status: 'IGNORED', ignoreReason: 'no-transition' });
      const end = await store(t, removeLane(issue, 84));
      await store(t, commented(84, 8403, 'Q3: LATE-ANSWER after the end.'));

      await t.worker.drainOnce();

      expect(await event(end.id)).toMatchObject({ status: 'DONE' });
      const run = await firstRun();
      const [ended] = endedComments(issue, run.id);
      expect(ended).toContain(`${HUMAN}: Q1: yes.\n${HUMAN}: Q2: monthly.`);
      expect(ended).not.toContain('LATE-ANSWER');
      expect((await grillRows(t)).answers).toMatchObject([
        { commentId: '8401', evaluationId: null, afterRound: 1 },
        { commentId: '8402', evaluationId: null, afterRound: 1 },
      ]);
    });

    it('the run-ended comment’s post fails once → the hook called again: the same block, the session closed once, no answer read twice', async () => {
      const issue = await askedRound1(t, 85);
      t.models.reply({ error: failing() });
      await deliver(t, commented(85, 8501, 'Q1: yes.'));
      const hook = vi.spyOn(t.app.get(GrillHandler), 'onCancel');
      t.issues.failNextOn(
        'postComment',
        new ProviderError('GitHub POST comment → 502', 'transient'),
      );

      const end = await deliver(t, removeLane(issue, 85));

      expect(end).toMatchObject({ status: 'PENDING' });
      const first = await grillRows(t);
      expect(first.session).toMatchObject({ status: 'CANCELLED' });
      await drainDueNow(t);

      // The run ended on the first try; the retry posts the pending comment (spec 5 plan Q1) and changes nothing.
      expect(await event(end.id)).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'no-transition',
      });
      expect(hook).toHaveBeenCalledTimes(2);
      const [once, twice] = (await Promise.all(
        hook.mock.results.map(({ value }) => value as Promise<string | null>),
      )) as string[];
      expect(twice).toBe(once);
      expect(once).toContain(`${HUMAN}: Q1: yes.`);
      const second = await grillRows(t);
      expect(second.session?.endedAt).toEqual(first.session?.endedAt);
      expect(second.answers.map(({ commentId }) => commentId)).toEqual([
        '8501',
      ]);
      const run = await firstRun();
      const ended = endedComments(issue, run.id);
      expect(ended).toHaveLength(1);
      expect(ended[0].endsWith(once)).toBe(true);
    });
  });

  describe('a session that already ended keeps its status', () => {
    it('STOPPED (`grill: skip`) → its answers in the block', async () => {
      const issue = await askedRound1(t, 86);
      t.models.replyJson(grillAnswer({ confidence: 60, open: [2] }));
      await deliver(t, commented(86, 8601, 'Q1: yes.'));
      t.issues.setHumanLabels(issue, ['workflow: full-sdd', 'grill: skip']);
      await deliver(t, issuesLabeled({ number: 86, label: 'grill: skip' }));

      await deliver(t, removeLane(issue, 86, ['grill: skip']));

      const run = await firstRun();
      expect(endedComments(issue, run.id)[0]).toContain(`${HUMAN}: Q1: yes.`);
      expect((await grillRows(t)).session).toMatchObject({
        status: 'STOPPED',
      });
    });

    it('LIMIT (five rounds) → its answers in the block', async () => {
      const issue = await askedRound1(t, 87);
      for (let answer = 1; answer <= 5; answer++) {
        t.models.replyJson(grillAnswer({ confidence: 50, questions: 1 }));
        await deliver(t, commented(87, 8700 + answer, `answer ${answer}`));
      }
      expect((await grillRows(t)).session).toMatchObject({
        status: 'LIMIT',
        rounds: 5,
      });

      await deliver(t, removeLane(issue, 87));

      const run = await firstRun();
      const [ended] = endedComments(issue, run.id);
      for (let answer = 1; answer <= 5; answer++) {
        expect(ended).toContain(`${HUMAN}: answer ${answer}`);
      }
      expect((await grillRows(t)).session).toMatchObject({ status: 'LIMIT' });
    });
  });

  it('a `code-only` run cancelled → no block, no Grill row, no access lookup for a commenter (the real hook)', async () => {
    const issue = seedIssue(t, 88, { labels: ['workflow: code-only'] });
    await deliver(t, laneAdded(88, 'code-only'));
    await deliver(
      t,
      issueCommentCreated({
        number: 88,
        commentId: 8801,
        body: 'a remark',
        sender: 'zoe',
      }),
    );
    t.issues.calls.length = 0;

    await deliver(t, removeLane(issue, 88, [], 'code-only'));

    const run = await firstRun();
    const [ended] = endedComments(issue, run.id);
    expect(ended).toContain('was cancelled');
    expect(ended).not.toContain('Your Grill Me answers');
    expect(await t.prisma.grillSession.count()).toBe(0);
    expect(
      t.issues.calls
        .filter(({ method }) => method === 'getAccessLevel')
        .map(({ args }) => args[1]),
    ).not.toContain('zoe');
  });

  describe('`GrillService.transcript()` (for spec 7)', () => {
    it('the rounds with their questions and guesses, then the answers in order, as written', async () => {
      await askedRound1(t, 89);
      t.models
        .replyJson(grillAnswer({ confidence: 60, questions: 1 }))
        .replyJson(grillAnswer({ confidence: 70, open: [3] }));
      await deliver(t, commented(89, 8901, 'Q1: yes.'));
      await deliver(t, commented(89, 8902, 'Q2: no.'));
      const url = (commentId: number) =>
        `https://github.com/test-owner/test-repo/issues/89#issuecomment-${commentId}`;

      const transcript = await t.app
        .get(GrillService)
        .transcript((await firstRun()).id);

      expect(transcript).toEqual({
        status: 'ASKING',
        rounds: [
          {
            number: 1,
            questions: [
              { number: 1, question: 'Question 1?', guess: 'Guess 1.' },
              { number: 2, question: 'Question 2?', guess: 'Guess 2.' },
            ],
          },
          {
            number: 2,
            questions: [
              { number: 3, question: 'Question 1?', guess: 'Guess 1.' },
            ],
          },
        ],
        answers: [
          {
            author: HUMAN,
            body: 'Q1: yes.',
            commentId: '8901',
            url: url(8901),
          },
          {
            author: HUMAN,
            body: 'Q2: no.',
            commentId: '8902',
            url: url(8902),
          },
        ],
      });
    });

    it('a SKIPPED session at a plain run start → no answers; a run with no session → empty', async () => {
      seedIssue(t, 90, { labels: ['workflow: full-sdd', 'grill: skip'] });
      await deliver(t, laneAdded(90));
      const grill = t.app.get(GrillService);

      expect(await grill.transcript((await firstRun()).id)).toEqual({
        status: 'SKIPPED',
        rounds: [],
        answers: [],
      });
      expect(await grill.transcript(randomUUID())).toEqual({
        status: null,
        rounds: [],
        answers: [],
      });
    });
  });
});
