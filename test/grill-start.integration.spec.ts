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
import {
  clearComment,
  clearMarker,
  roundMarker,
  skippedComment,
  skippedMarker,
} from '../src/grill/grill-comments.js';
import { GrillStore } from '../src/grill/grill.store.js';
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import {
  HUMAN,
  issueCommentCreated,
  issuesLabeled,
} from './fixtures/github/payloads.js';
import {
  botComments,
  captureLogs,
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

// Spec 6 "Where Grill Me runs", "One evaluation", "Exactly once and recovery": a run's start (plan T11–T13).

describe('Grill Me at run start (spec 6)', () => {
  let t: TestApp;
  let logs: string[];

  const event = (id: string) =>
    t.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
  const task = () => t.prisma.task.findFirstOrThrow();

  beforeAll(async () => {
    t = await startApp({ grill: 'real' });
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

  describe('round 1 (T11)', () => {
    it('`workflow: full-sdd` on a vague issue → session ASKING, evaluation ASKED with its log row, round 1 POSTED with Q1 and Q2, `status: grilling`, the event DONE', async () => {
      const issue = seedIssue(t, 12, {
        labels: ['workflow: full-sdd'],
        description: 'Let people split bills.',
      });
      t.models.replyJson(
        grillAnswer({ confidence: 60, questions: 2, gaps: ['who pays'] }),
      );

      const row = await deliver(t, laneAdded(12));

      expect(row).toMatchObject({ status: 'DONE' });
      const run = await t.prisma.run.findFirstOrThrow();
      const log = await t.prisma.executionLog.findFirstOrThrow({
        where: { step: 'grill' },
      });
      expect(log).toMatchObject({ runId: run.id, lane: 'full-sdd' });
      const { session, evaluations, rounds } = await grillRows(t);
      expect(session).toMatchObject({
        runId: run.id,
        status: 'ASKING',
        rounds: 1,
        lastQuestion: 2,
        firstConfidence: 60,
        lastConfidence: 60,
        endedAt: null,
      });
      expect(evaluations).toMatchObject([
        {
          result: 'ASKED',
          logId: log.id,
          model: 'gemini-4-hydrogen',
          modelLevel: 'standard',
          afterRound: 0,
          confidence: 60,
          questionsProposed: 2,
          open: [],
          gaps: ['who pays'],
          notes: ['Model: `gemini-4-hydrogen` (standard)'],
        },
      ]);
      const comments = botComments(t, issue);
      expect(comments).toHaveLength(1);
      expect(rounds).toMatchObject([
        {
          number: 1,
          postState: 'POSTED',
          commentId: comments[0].id,
          logId: log.id,
          questions: [
            { number: 1, question: 'Question 1?', guess: 'Guess 1.' },
            { number: 2, question: 'Question 2?', guess: 'Guess 2.' },
          ],
          stillOpen: [],
        },
      ]);
      expect(comments[0].body).toBe(rounds[0].body);
      expect(comments[0].body.startsWith(roundMarker(rounds[0].id))).toBe(true);
      expect(comments[0].body).toContain(
        '**Grill Me, round 1 of 5** · confidence 60% (the bot writes the Spec at 95%)',
      );
      expect(await task()).toMatchObject({
        status: 'grilling',
        shownStatus: 'grilling',
      });
      expect(t.issues.labelsOf(issue)).toContain('status: grilling');
      expect(logs).toContain(
        '#12 run 1 grill: evaluation → ASKED (round 1, 2 of 3 questions, confidence 60)',
      );
    });

    it('five questions with K = 3 → three posted, `questions_proposed` 5', async () => {
      const issue = seedIssue(t, 13, { labels: ['workflow: spec-code'] });
      t.models.replyJson(grillAnswer({ confidence: 40, questions: 5 }));

      await deliver(t, laneAdded(13, 'spec-code'));

      const { evaluations, rounds, session } = await grillRows(t);
      expect(evaluations).toMatchObject([{ questionsProposed: 5 }]);
      expect(rounds[0].questions).toHaveLength(3);
      expect(session).toMatchObject({ lastQuestion: 3 });
      expect(botComments(t, issue)[0].body).toContain('**Q3.** Question 3?');
      expect(botComments(t, issue)[0].body).not.toContain('Q4');
    });

    it('posting fails once after Tx1 → retried: one comment, one model call, the recovery logged', async () => {
      const issue = seedIssue(t, 14, { labels: ['workflow: full-sdd'] });
      t.models.replyJson(grillAnswer({ confidence: 60, questions: 2 }));
      t.issues.failNextOn(
        'postComment',
        new ProviderError('GitHub POST comment → 502', 'transient'),
      );

      const first = await deliver(t, laneAdded(14));
      expect(first).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect((await grillRows(t)).rounds).toMatchObject([
        { postState: 'PENDING_POST' },
      ]);
      await drainDueNow(t);

      expect(await event(first.id)).toMatchObject({ status: 'DONE' });
      expect(botComments(t, issue)).toHaveLength(1);
      expect(t.models.calls).toHaveLength(1);
      expect((await grillRows(t)).rounds).toMatchObject([
        { postState: 'POSTED' },
      ]);
      expect(await task()).toMatchObject({ status: 'grilling' });
      expect(logs).toContain('#14 run 1 grill: round 1 posted (recovered)');
    });

    it('Tx2 fails once → the comment is found by its marker: one comment', async () => {
      const issue = seedIssue(t, 15, { labels: ['workflow: full-sdd'] });
      t.models.replyJson(grillAnswer({ confidence: 60, questions: 2 }));
      vi.spyOn(t.app.get(GrillStore), 'markPosted').mockRejectedValueOnce(
        new Error('Tx2 broke'),
      );

      const first = await deliver(t, laneAdded(15));
      expect(first).toMatchObject({ status: 'PENDING' });
      expect(botComments(t, issue)).toHaveLength(1);
      await drainDueNow(t);

      expect(await event(first.id)).toMatchObject({ status: 'DONE' });
      expect(botComments(t, issue)).toHaveLength(1);
      expect((await grillRows(t)).rounds).toMatchObject([
        { postState: 'POSTED', commentId: botComments(t, issue)[0].id },
      ]);
      expect(t.models.calls).toHaveLength(1);
    });

    it('Tx1 fails once → one more model call, one comment', async () => {
      const issue = seedIssue(t, 16, { labels: ['workflow: full-sdd'] });
      t.models
        .replyJson(grillAnswer({ confidence: 60, questions: 2 }))
        .replyJson(grillAnswer({ confidence: 61, questions: 2 }));
      vi.spyOn(t.app.get(GrillStore), 'recordEvaluation').mockRejectedValueOnce(
        new Error('Tx1 broke'),
      );

      const first = await deliver(t, laneAdded(16));
      expect(first).toMatchObject({ status: 'PENDING' });
      expect((await grillRows(t)).evaluations).toHaveLength(0);
      await drainDueNow(t);

      expect(await event(first.id)).toMatchObject({ status: 'DONE' });
      expect(t.models.calls).toHaveLength(2);
      expect(botComments(t, issue)).toHaveLength(1);
      expect((await grillRows(t)).evaluations).toMatchObject([
        { result: 'ASKED', confidence: 61 },
      ]);
    });

    it('the run’s start event processed again with round 1 posted → no model call, ASKED, no second comment', async () => {
      const issue = seedIssue(t, 17, { labels: ['workflow: full-sdd'] });
      t.models.replyJson(grillAnswer({ confidence: 60, questions: 2 }));
      const start = await deliver(t, laneAdded(17));

      await t.prisma.webhookEvent.update({
        where: { id: start.id },
        data: { status: 'PENDING', processedAt: null },
      });
      await drainDueNow(t);

      expect(await event(start.id)).toMatchObject({ status: 'DONE' });
      expect(t.models.calls).toHaveLength(1);
      expect(botComments(t, issue)).toHaveLength(1);
      expect(await task()).toMatchObject({ status: 'grilling' });
    });
  });

  describe('already clear, and the look again (T12)', () => {
    const run = () => t.prisma.run.findFirstOrThrow();
    const withMarker = (issue: TaskRef, marker: string) =>
      botComments(t, issue).filter(({ body }) => body.startsWith(marker));
    /** Everything one model call was sent, as text. */
    const sent = (call: number) =>
      t.models.calls[call].messages.map((message) => message.text).join('\n');

    it('a complete issue (confidence 97, with two questions) → session CLEAR with no round, one "no questions needed" comment, the questions dropped, then the `spec` stop', async () => {
      const issue = seedIssue(t, 21, { labels: ['workflow: spec-code'] });
      t.models.replyJson(grillAnswer({ confidence: 97, questions: 2 }));

      const row = await deliver(t, laneAdded(21, 'spec-code'));

      expect(row).toMatchObject({ status: 'FAILED' });
      const { session, evaluations, rounds } = await grillRows(t);
      expect(session).toMatchObject({
        status: 'CLEAR',
        rounds: 0,
        lastQuestion: 0,
        firstConfidence: 97,
        lastConfidence: 97,
      });
      expect(session?.endedAt).toBeInstanceOf(Date);
      expect(evaluations).toMatchObject([
        { result: 'CLEAR', confidence: 97, questionsProposed: 2 },
      ]);
      expect(rounds).toEqual([]);
      const comments = botComments(t, issue);
      expect(comments).toHaveLength(2);
      expect(comments[0].body).toBe(
        clearComment(session!.id, {
          confidence: 97,
          threshold: 95,
          notes: ['Model: `gemini-4-hydrogen` (standard)'],
        }),
      );
      expect(comments[1].body).toContain('stopped at step `spec`');
      expect(await run()).toMatchObject({
        stopStep: 'spec',
        stopCause: 'step-not-built',
      });
      expect(logs).toContain(
        '#21 run 1 grill: evaluation → CLEAR (confidence 97)',
      );
    });

    it('the clear comment failing once → posted once on the retry, no second model call; `/retry` after the `spec` stop → no model call, a second `spec` stop', async () => {
      const issue = seedIssue(t, 22, { labels: ['workflow: full-sdd'] });
      t.models.replyJson(grillAnswer({ confidence: 96 }));
      t.issues.failNextOn(
        'postComment',
        new ProviderError('GitHub POST comment → 502', 'transient'),
      );

      const first = await deliver(t, laneAdded(22));
      expect(first).toMatchObject({ status: 'PENDING' });
      await drainDueNow(t);
      expect(await event(first.id)).toMatchObject({ status: 'FAILED' });
      const sessionId = (await grillRows(t)).session!.id;
      expect(withMarker(issue, clearMarker(sessionId))).toHaveLength(1);

      const retried = await deliver(
        t,
        issueCommentCreated({ number: 22, commentId: 2201, body: '/retry' }),
      );

      expect(retried).toMatchObject({ status: 'DONE' });
      expect(t.models.calls).toHaveLength(1);
      expect(withMarker(issue, clearMarker(sessionId))).toHaveLength(1);
      expect(await run()).toMatchObject({
        stopStep: 'spec',
        stopCause: 'step-not-built',
        stops: 2,
        retries: 1,
      });
    });

    it('a comment stored while the model thinks → SUPERSEDED, a second call with it under "New comments", one question comment; its own event then DONE with no call', async () => {
      const issue = seedIssue(t, 23, { labels: ['workflow: full-sdd'] });
      t.models
        .replyJson(grillAnswer({ confidence: 50, questions: 2 }), {
          during: () =>
            store(
              t,
              issueCommentCreated({
                number: 23,
                commentId: 2301,
                body: 'We split by percentage.',
              }),
            ),
        })
        .replyJson(grillAnswer({ confidence: 70, questions: 1 }));

      const start = await deliver(t, laneAdded(23));
      await t.worker.drainOnce();

      expect(start).toMatchObject({ status: 'DONE' });
      const { evaluations, answers, rounds } = await grillRows(t);
      expect(
        evaluations.map(({ result, confidence }) => [result, confidence]),
      ).toEqual([
        ['SUPERSEDED', 50],
        ['ASKED', 70],
      ]);
      expect(answers).toMatchObject([
        { commentId: '2301', evaluationId: evaluations[1].id, afterRound: 0 },
      ]);
      expect(rounds).toHaveLength(1);
      expect(botComments(t, issue)).toHaveLength(1);
      expect(t.models.calls).toHaveLength(2);
      expect(sent(0)).toContain(
        'New comments since the last call: None. This is the first evaluation.',
      );
      expect(sent(0)).not.toContain('We split by percentage.');
      expect(sent(1)).toContain('New comments since the last call:');
      expect(sent(1)).toContain('We split by percentage.');
      expect(
        await t.prisma.webhookEvent.findFirstOrThrow({
          where: { eventName: 'issue_comment' },
        }),
      ).toMatchObject({ status: 'DONE' });
      expect(logs).toContain(
        '#23 run 1 grill: evaluation → SUPERSEDED (1 newer comment)',
      );
    });

    it('two comments during two calls → two SUPERSEDED, three calls, one question comment', async () => {
      const issue = seedIssue(t, 24, { labels: ['workflow: full-sdd'] });
      const during = (commentId: number) => () =>
        store(
          t,
          issueCommentCreated({
            number: 24,
            commentId,
            body: `answer ${commentId}`,
          }),
        );
      t.models
        .replyJson(grillAnswer({ confidence: 50, questions: 2 }), {
          during: during(2401),
        })
        .replyJson(grillAnswer({ confidence: 60, questions: 2 }), {
          during: during(2402),
        })
        .replyJson(grillAnswer({ confidence: 70, questions: 2 }));

      await deliver(t, laneAdded(24));
      await t.worker.drainOnce();

      const { evaluations, answers } = await grillRows(t);
      expect(evaluations.map(({ result }) => result)).toEqual([
        'SUPERSEDED',
        'SUPERSEDED',
        'ASKED',
      ]);
      expect(answers.map(({ commentId }) => commentId)).toEqual([
        '2401',
        '2402',
      ]);
      expect(t.models.calls).toHaveLength(3);
      expect(botComments(t, issue)).toHaveLength(1);
    });
  });

  describe('skipped at run start (T13)', () => {
    const run = () => t.prisma.run.findFirstOrThrow();
    const skipped = (issue: TaskRef, sessionId: string) =>
      botComments(t, issue).filter(({ body }) =>
        body.startsWith(skippedMarker(sessionId)),
      );

    it('`grill: skip` and `workflow: full-sdd` in one go → session SKIPPED, one skipped comment, the `spec` stop; no model call', async () => {
      const issue = seedIssue(t, 31, {
        labels: ['workflow: full-sdd', 'grill: skip'],
      });

      const row = await deliver(t, laneAdded(31));

      expect(row).toMatchObject({ status: 'FAILED' });
      const { session, evaluations } = await grillRows(t);
      expect(session).toMatchObject({
        status: 'SKIPPED',
        rounds: 0,
        firstConfidence: null,
        lastConfidence: null,
      });
      expect(session?.endedAt).toBeInstanceOf(Date);
      expect(evaluations).toEqual([]);
      const comments = botComments(t, issue);
      expect(comments).toHaveLength(2);
      expect(comments[0].body).toBe(skippedComment(session!.id));
      expect(await run()).toMatchObject({
        grillSkip: true,
        stopStep: 'spec',
        stopCause: 'step-not-built',
      });
      expect(
        await t.prisma.executionLog.count({ where: { step: 'grill' } }),
      ).toBe(0);
    });

    it('the first evaluation fails (permanent) → stop at `grill` → `grill: skip` added → `/retry` → the skipped comment, no model call, the `spec` stop', async () => {
      const issue = seedIssue(t, 32, { labels: ['workflow: full-sdd'] });
      t.models.reply({
        error: new LlmError(
          'scripted call to `gemini-4-hydrogen` failed',
          'permanent',
          'bad-request',
        ),
      });
      const start = await deliver(t, laneAdded(32));
      expect(start).toMatchObject({ status: 'FAILED' });
      expect(await run()).toMatchObject({ stopStep: 'grill', stops: 1 });

      t.issues.setHumanLabels(issue, ['workflow: full-sdd', 'grill: skip']);
      await deliver(t, issuesLabeled({ number: 32, label: 'grill: skip' }));
      await deliver(
        t,
        issueCommentCreated({ number: 32, commentId: 3201, body: '/retry' }),
      );

      const { session } = await grillRows(t);
      expect(session).toMatchObject({ status: 'SKIPPED', rounds: 0 });
      expect(skipped(issue, session!.id)).toHaveLength(1);
      expect(t.models.calls).toHaveLength(1);
      expect(await run()).toMatchObject({
        stopStep: 'spec',
        stopCause: 'step-not-built',
        stops: 2,
      });
    });

    it('posting the skipped comment fails once → posted once', async () => {
      const issue = seedIssue(t, 33, {
        labels: ['workflow: full-sdd', 'grill: skip'],
      });
      t.issues.failNextOn(
        'postComment',
        new ProviderError('GitHub POST comment → 502', 'transient'),
      );

      const first = await deliver(t, laneAdded(33));
      expect(first).toMatchObject({ status: 'PENDING' });
      await drainDueNow(t);

      expect(await event(first.id)).toMatchObject({ status: 'FAILED' });
      const { session } = await grillRows(t);
      expect(skipped(issue, session!.id)).toHaveLength(1);
      expect(await run()).toMatchObject({ stopStep: 'spec', stops: 1 });
    });
  });
});
