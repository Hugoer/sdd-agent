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
  approveMarker,
  approveReply,
  stoppedComment,
  stoppedMarker,
} from '../src/grill/grill-comments.js';
import { approveDeniedMarker } from '../src/intake/intake.service.js';
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import {
  HUMAN,
  issueCommentCreated,
  issuesLabeled,
} from './fixtures/github/payloads.js';
import {
  askedRound1,
  botComments,
  captureLogs,
  commented,
  grillAnswer,
  grillRows,
} from './grill-helpers.js';
import { deliver, drainDueNow, seedWorkflow, store } from './router-helpers.js';

// Spec 6 "`/approve`, `grill: skip` and `/retry` while the bot is asking" (GM8, GM14, GM15) and ended sessions
// (plan P1), plan T17. Every test starts from round 1 posted (one model call).

describe('Grill Me commands while asking (spec 6)', () => {
  let t: TestApp;
  let logs: string[];

  const event = (id: string) =>
    t.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
  const task = () => t.prisma.task.findFirstOrThrow();
  const run = () => t.prisma.run.findFirstOrThrow();
  const skipAdded = (number: number) =>
    issuesLabeled({ number, label: 'grill: skip' });
  /** A human adds or removes `grill: skip` (the API answers this from now on). */
  const skipOn = (issue: TaskRef, on: boolean) =>
    t.issues.setHumanLabels(
      issue,
      on ? ['workflow: full-sdd', 'grill: skip'] : ['workflow: full-sdd'],
    );
  const bodies = (issue: TaskRef) =>
    botComments(t, issue).map(({ body }) => body);
  const withMarker = (issue: TaskRef, marker: string) =>
    bodies(issue).filter((body) => body.startsWith(marker));

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

  describe('`/approve` (GM8)', () => {
    it('by an Approver → one reply with the questions open now; a second `/approve` → its own reply; the job run again → no second reply; nothing else changes', async () => {
      const issue = await askedRound1(t, 61);

      const first = await deliver(t, commented(61, 6101, '/approve'));
      await deliver(t, commented(61, 6102, '/approve'));
      await t.prisma.webhookEvent.update({
        where: { id: first.id },
        data: { status: 'PENDING', processedAt: null },
      });
      await drainDueNow(t);

      expect(await event(first.id)).toMatchObject({ status: 'DONE' });
      const replies = bodies(issue).slice(1);
      expect(replies).toEqual([
        approveReply('6101', [1, 2]),
        approveReply('6102', [1, 2]),
      ]);
      expect(replies[0]).toContain(
        "There's nothing to approve yet: the bot is still asking questions (still open: Q1, Q2).",
      );
      const { session, evaluations } = await grillRows(t);
      expect(session).toMatchObject({ status: 'ASKING', rounds: 1 });
      expect(evaluations).toHaveLength(1);
      expect(await task()).toMatchObject({ status: 'grilling' });
      expect(t.models.calls).toHaveLength(1);
    });

    it('after a 👀 wait → the questions that evaluation lists as open', async () => {
      const issue = await askedRound1(t, 62, 3);
      t.models.replyJson(grillAnswer({ confidence: 60, open: [2, 3] }));
      await deliver(t, commented(62, 6201, 'Q1: yes.'));

      await deliver(t, commented(62, 6202, '/approve'));

      expect(withMarker(issue, approveMarker('6202'))).toEqual([
        approveReply('6202', [2, 3]),
      ]);
    });

    it('after round 2 with "Still open from before: Q2" → Q2 and round 2’s question', async () => {
      const issue = await askedRound1(t, 63);
      t.models.replyJson(
        grillAnswer({ confidence: 70, questions: 1, open: [2] }),
      );
      await deliver(t, commented(63, 6301, 'Q1: yes.'));

      await deliver(t, commented(63, 6302, '/approve'));

      expect(withMarker(issue, approveMarker('6302'))).toEqual([
        approveReply('6302', [2, 3]),
      ]);
    });

    it('a Participant’s `/approve` → spec 2’s reply, not Grill Me’s', async () => {
      const issue = await askedRound1(t, 64);
      t.issues.setAccessLevel('pat', 'participant');

      const row = await deliver(
        t,
        issueCommentCreated({
          number: 64,
          commentId: 6401,
          body: '/approve',
          sender: 'pat',
        }),
      );

      expect(row).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'approve-denied',
      });
      expect(withMarker(issue, approveDeniedMarker('6401'))).toHaveLength(1);
      expect(withMarker(issue, approveMarker('6401'))).toEqual([]);
    });
  });

  describe('`grill: skip` while asking (GM8, GM15)', () => {
    it('added → the unread answer read without a model call, session STOPPED with the login, one stopped comment, then the `spec` stop', async () => {
      const issue = await askedRound1(t, 65);
      skipOn(issue, true);
      const label = await store(t, skipAdded(65));
      const answer = await store(t, commented(65, 6501, 'Q1: yes.'));

      await t.worker.drainOnce();

      expect(await event(label.id)).toMatchObject({ status: 'FAILED' });
      expect(await event(answer.id)).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'no-transition',
      });
      const { session, answers } = await grillRows(t);
      expect(session).toMatchObject({
        status: 'STOPPED',
        stoppedBy: HUMAN,
        rounds: 1,
      });
      expect(session?.endedAt).toBeInstanceOf(Date);
      expect(answers).toMatchObject([
        { commentId: '6501', evaluationId: null, afterRound: 1 },
      ]);
      expect(withMarker(issue, stoppedMarker(session!.id))).toEqual([
        stoppedComment(session!.id, HUMAN),
      ]);
      expect(stoppedComment(session!.id, HUMAN)).toContain(
        'Grill Me stopped by `dev-user` (`grill: skip` added): writing the Spec from the issue and the answers so far.',
      );
      expect(await run()).toMatchObject({
        stopStep: 'spec',
        stopCause: 'step-not-built',
      });
      expect(t.models.calls).toHaveLength(1);
      expect(logs).toContain('#65 run 1 grill: stopped by grill: skip');
    });

    it('added and removed before its event runs → no stopped comment, the event DONE; the next answer gets a normal reply', async () => {
      const issue = await askedRound1(t, 66);

      const row = await deliver(t, skipAdded(66));

      expect(row).toMatchObject({ status: 'DONE' });
      expect((await grillRows(t)).session).toMatchObject({ status: 'ASKING' });
      expect(logs).toContain('#66 run 1 grill: nothing new');
      t.models.replyJson(grillAnswer({ confidence: 70, questions: 1 }));
      await deliver(t, commented(66, 6601, 'Q1: yes.'));
      expect(bodies(issue)).toHaveLength(2);
      expect(bodies(issue)[1]).toContain('**Grill Me, round 2 of 5**');
      expect(await task()).toMatchObject({ status: 'grilling' });
    });

    it('a comment while asking with the label on (added while the issue was closed) → "Grill Me stopped (`grill: skip` is on)", the comment read', async () => {
      const issue = await askedRound1(t, 67);
      t.issues.setOpen(issue, false);
      skipOn(issue, true);
      expect(await deliver(t, skipAdded(67))).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'issue-closed',
      });
      t.issues.setOpen(issue, true);

      const row = await deliver(t, commented(67, 6701, 'Q1: yes.'));

      expect(row).toMatchObject({ status: 'FAILED' });
      const { session, answers } = await grillRows(t);
      expect(session).toMatchObject({ status: 'STOPPED', stoppedBy: null });
      expect(answers).toMatchObject([
        { commentId: '6701', evaluationId: null },
      ]);
      expect(withMarker(issue, stoppedMarker(session!.id))).toEqual([
        stoppedComment(session!.id, null),
      ]);
      expect(stoppedComment(session!.id, null)).toContain(
        'Grill Me stopped (`grill: skip` is on): writing the Spec from the issue and the answers so far.',
      );
      expect(t.models.calls).toHaveLength(1);
    });

    it('GM15: the model fails (permanent) → the stop at `grill`; `grill: skip` added while stopped → no reply; `/retry` → "Grill Me stopped (`grill: skip` is on)" and the `spec` stop, no question comment', async () => {
      const issue = await askedRound1(t, 68);
      t.models.reply({
        error: new LlmError(
          'scripted call to `gemini-4-hydrogen` failed',
          'permanent',
          'bad-request',
        ),
      });
      expect(await deliver(t, commented(68, 6801, 'Q1: yes.'))).toMatchObject({
        status: 'FAILED',
      });
      skipOn(issue, true);
      expect(await deliver(t, skipAdded(68))).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'no-transition',
      });
      expect(bodies(issue)).toHaveLength(2);

      await deliver(t, commented(68, 6802, '/retry'));

      const { session, answers, rounds } = await grillRows(t);
      expect(session).toMatchObject({ status: 'STOPPED', stoppedBy: null });
      expect(answers).toMatchObject([
        { commentId: '6801', evaluationId: null },
      ]);
      expect(rounds).toHaveLength(1);
      expect(withMarker(issue, stoppedMarker(session!.id))).toEqual([
        stoppedComment(session!.id, null),
      ]);
      expect(await run()).toMatchObject({ stopStep: 'spec', stops: 2 });
      expect(t.models.calls).toHaveLength(2);
    });
  });

  describe('a round not posted yet comes first (GM14)', () => {
    const roundTwoPending = async (number: number) => {
      const issue = await askedRound1(t, number);
      t.models.replyJson(grillAnswer({ confidence: 60, questions: 2 }));
      t.issues.failNextOn(
        'postComment',
        new ProviderError('GitHub POST comment → 502', 'transient'),
      );
      const answer = await deliver(
        t,
        commented(number, number * 100 + 1, 'Q1: yes. Q2: no.'),
      );
      expect(answer).toMatchObject({ status: 'PENDING' });
      expect(
        (await grillRows(t)).rounds.map(({ postState }) => postState),
      ).toEqual(['POSTED', 'PENDING_POST']);
      return { issue, answer };
    };

    it('`/approve` → round 2 posted once, then the reply naming its questions; the retried answer event posts nothing', async () => {
      const { issue, answer } = await roundTwoPending(69);

      await deliver(t, commented(69, 6902, '/approve'));

      expect(logs).toContain('#69 run 1 grill: round 2 posted (recovered)');
      const { rounds } = await grillRows(t);
      expect(bodies(issue)).toEqual([
        rounds[0].body,
        rounds[1].body,
        approveReply('6902', [3, 4]),
      ]);
      await drainDueNow(t);
      expect(await event(answer.id)).toMatchObject({ status: 'DONE' });
      expect(bodies(issue)).toHaveLength(3);
      expect(t.models.calls).toHaveLength(2);
    });

    it('`grill: skip` → round 2 posted once, then the stop', async () => {
      const { issue, answer } = await roundTwoPending(70);
      skipOn(issue, true);

      await deliver(t, skipAdded(70));

      const { session, rounds } = await grillRows(t);
      expect(session).toMatchObject({
        status: 'STOPPED',
        stoppedBy: HUMAN,
        rounds: 2,
      });
      const comments = bodies(issue);
      expect(comments.slice(0, 3)).toEqual([
        rounds[0].body,
        rounds[1].body,
        stoppedComment(session!.id, HUMAN),
      ]);
      expect(comments[3]).toContain('stopped at step `spec`');
      await drainDueNow(t);
      expect(await event(answer.id)).toMatchObject({
        status: 'IGNORED',
        ignoreReason: 'no-transition',
      });
      expect(bodies(issue)).toHaveLength(4);
    });
  });

  describe('ended sessions (plan P1)', () => {
    it('STOPPED, the `spec` step fails, the label removed, `/retry` → the `spec` step again: no model call, no Grill Me comment', async () => {
      const issue = await askedRound1(t, 71);
      skipOn(issue, true);
      expect(await deliver(t, skipAdded(71))).toMatchObject({
        status: 'FAILED',
      });
      const before = bodies(issue).filter((body) =>
        body.startsWith('<!-- sdd-agent:grill-'),
      );
      skipOn(issue, false);

      await deliver(t, commented(71, 7101, '/retry'));

      expect(await run()).toMatchObject({
        stopStep: 'spec',
        stopCause: 'step-not-built',
        stops: 2,
        retries: 1,
      });
      expect(
        bodies(issue).filter((body) =>
          body.startsWith('<!-- sdd-agent:grill-'),
        ),
      ).toEqual(before);
      expect(t.models.calls).toHaveLength(1);
    });

    it('the stopped comment’s post fails once and the label is removed before the retry → the retried event posts "Grill Me stopped by `<login>`" once, then the `spec` step', async () => {
      const issue = await askedRound1(t, 72);
      skipOn(issue, true);
      t.issues.failNextOn(
        'postComment',
        new ProviderError('GitHub POST comment → 502', 'transient'),
      );
      const first = await deliver(t, skipAdded(72));
      expect(first).toMatchObject({ status: 'PENDING' });
      const { session } = await grillRows(t);
      expect(session).toMatchObject({ status: 'STOPPED', stoppedBy: HUMAN });
      expect(withMarker(issue, stoppedMarker(session!.id))).toEqual([]);
      skipOn(issue, false);

      await drainDueNow(t);

      expect(await event(first.id)).toMatchObject({ status: 'FAILED' });
      expect(withMarker(issue, stoppedMarker(session!.id))).toEqual([
        stoppedComment(session!.id, HUMAN),
      ]);
      expect(await run()).toMatchObject({ stopStep: 'spec', stops: 1 });
      expect(t.models.calls).toHaveLength(1);
    });
  });
});
