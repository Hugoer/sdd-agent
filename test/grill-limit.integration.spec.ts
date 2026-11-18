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
import { limitBody } from '../src/grill/grill-comments.js';
import { GrillStore } from '../src/grill/grill.store.js';
import {
  needsHumanMarker,
  retryRefusedMarker,
} from '../src/workflow/workflow-comments.js';
import { startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import { HUMAN } from './fixtures/github/payloads.js';
import {
  askedRound1,
  botComments,
  captureLogs,
  commented,
  grillAnswer,
  grillRows,
} from './grill-helpers.js';
import { deliver, drainDueNow, seedWorkflow } from './router-helpers.js';
import { testEnv } from './test-env.js';

// Spec 6 "Round limit" (GM9) and invalid answers (GMW4), plan T16, with `GRILL_MAX_ROUNDS=1`: ConfigModule reads
// the environment when app.module.js is first imported, so the setting changes before this file's imports.
vi.hoisted(() => {
  process.env.GRILL_MAX_ROUNDS = '1';
});

const GAPS = [
  'who approves a split over 100 €',
  'whether a split shows up in the monthly export',
];
const MODEL_LINE = 'Model: `gemini-4-hydrogen` (standard)';

describe('Grill Me round limit and invalid answers (spec 6)', () => {
  let t: TestApp;
  let logs: string[];

  const event = (id: string) =>
    t.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
  const task = () => t.prisma.task.findFirstOrThrow();
  const run = () => t.prisma.run.findFirstOrThrow();
  const sent = (call: number) =>
    t.models.calls[call].messages.map((message) => message.text).join('\n');
  /** The stop comment spec 5 posts for the limit: its marker, then Grill Me's body. */
  const limitStop = (runId: string, gaps: string[]) =>
    [
      needsHumanMarker(runId, 1),
      limitBody({
        rounds: 1,
        confidence: 80,
        threshold: 95,
        run: { number: 1, lane: 'full-sdd' },
        gaps,
        notes: [MODEL_LINE],
      }),
    ].join('\n');

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
    process.env.GRILL_MAX_ROUNDS = testEnv.GRILL_MAX_ROUNDS;
  });

  it('round 1 posted, an answer, the model wants another question → `needs-human`: one stop comment with the limit body and no restart line; session and evaluation LIMIT; the stop `grill-limit`, not retryable', async () => {
    const issue = await askedRound1(t, 51);
    t.models.replyJson(
      grillAnswer({ confidence: 80, questions: 2, gaps: GAPS }),
    );

    const row = await deliver(
      t,
      commented(51, 5101, 'Q1: it depends. It must also sync with the bank.'),
    );

    expect(row).toMatchObject({ status: 'DONE' });
    const { session, evaluations, answers, rounds } = await grillRows(t);
    expect(session).toMatchObject({
      status: 'LIMIT',
      rounds: 1,
      lastQuestion: 2,
      lastConfidence: 80,
    });
    expect(session?.endedAt).toBeInstanceOf(Date);
    expect(evaluations.map(({ result }) => result)).toEqual(['ASKED', 'LIMIT']);
    expect(evaluations[1]).toMatchObject({
      afterRound: 1,
      confidence: 80,
      questionsProposed: 2,
      gaps: GAPS,
      notes: [MODEL_LINE],
    });
    expect(answers).toMatchObject([
      { commentId: '5101', evaluationId: evaluations[1].id },
    ]);
    expect(rounds).toHaveLength(1);
    const stopped = await run();
    expect(stopped).toMatchObject({
      stopStep: 'grill',
      stopCause: 'grill-limit',
      stopRetryable: false,
      stops: 1,
    });
    const comments = botComments(t, issue);
    expect(comments).toHaveLength(2);
    expect(comments[1].body).toBe(limitStop(stopped.id, GAPS));
    expect(comments[1].body.split('\n')[1]).toBe(
      '⚠️ **Grill Me used its only round and is 80% sure** (it writes the Spec at 95%), so run 1 stopped here.',
    );
    expect(comments[1].body).toContain(
      '1. Remove the `workflow: full-sdd` label. The bot then posts your answers so far, ready to copy.',
    );
    expect(comments[1].body).not.toContain('start again from scratch');
    expect(comments[1].body.endsWith(`<sub>${MODEL_LINE}</sub>`)).toBe(true);
    expect(t.issues.labelsOf(issue)).toContain('status: needs-human');
    expect(logs).toContain(
      '#51 run 1 grill: evaluation → LIMIT (confidence 80)',
    );
  });

  it('at the limit, nothing new to ask but Q1 still open → WAITING: 👀, no stop, `grilling`', async () => {
    const issue = await askedRound1(t, 52);
    t.models.replyJson(grillAnswer({ confidence: 70, open: [1] }));

    const row = await deliver(t, commented(52, 5201, 'Q2: equally.'));

    expect(row).toMatchObject({ status: 'DONE' });
    const { session, evaluations } = await grillRows(t);
    expect(evaluations.map(({ result }) => result)).toEqual([
      'ASKED',
      'WAITING',
    ]);
    expect(session).toMatchObject({ status: 'ASKING', rounds: 1 });
    expect(t.issues.acknowledged(issue)).toEqual(['5201']);
    expect(botComments(t, issue)).toHaveLength(1);
    expect(await task()).toMatchObject({ status: 'grilling' });
    expect(await run()).toMatchObject({ stopStep: null, stops: 0 });
  });

  it('`/retry` after the limit stop → spec 5’s "needs a restart" reply, no model call', async () => {
    const issue = await askedRound1(t, 53);
    t.models.replyJson(
      grillAnswer({ confidence: 80, questions: 1, gaps: GAPS }),
    );
    await deliver(t, commented(53, 5301, 'Q1: it depends.'));

    const row = await deliver(t, commented(53, 5302, '/retry'));

    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'retry-refused',
    });
    const reply = botComments(t, issue).at(-1)!.body;
    expect(reply.startsWith(retryRefusedMarker('5302'))).toBe(true);
    expect(reply).toContain(
      'Run 1 stopped because the Grill round limit was reached, so it needs a restart: remove the ' +
        '`workflow: full-sdd` label and add it again.',
    );
    expect(t.models.calls).toHaveLength(2);
    expect(await run()).toMatchObject({ stopCause: 'grill-limit', stops: 1 });
  });

  it('the stop’s write finds the issue’s lease taken → retried: one stop comment with the same body, no second model call', async () => {
    const issue = await askedRound1(t, 54);
    t.models.replyJson(
      grillAnswer({ confidence: 80, questions: 1, gaps: ['who pays the tip'] }),
    );
    const store = t.app.get(GrillStore);
    const recordEvaluation = store.recordEvaluation.bind(store);
    vi.spyOn(store, 'recordEvaluation').mockImplementationOnce(
      async (...args) => {
        const recorded = await recordEvaluation(...args);
        // Another job takes the issue's lease right after Tx1.
        await t.prisma.task.updateMany({
          data: {
            leaseOwner: randomUUID(),
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        });
        return recorded;
      },
    );

    const first = await deliver(t, commented(54, 5401, 'Q1: it depends.'));

    expect(first).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect((await grillRows(t)).session).toMatchObject({ status: 'LIMIT' });
    expect(botComments(t, issue)).toHaveLength(1);
    await t.prisma.task.updateMany({
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    await drainDueNow(t);

    expect(await event(first.id)).toMatchObject({ status: 'DONE' });
    expect(t.models.calls).toHaveLength(2);
    const stopped = await run();
    expect(stopped).toMatchObject({ stopCause: 'grill-limit', stops: 1 });
    const comments = botComments(t, issue);
    expect(comments).toHaveLength(2);
    expect(comments[1].body).toBe(limitStop(stopped.id, ['who pays the tip']));
  });

  it('three answers listing Q7 as open after round 1’s three questions → the `invalid-answer` stop with the `/retry` line; three `execution_logs` rows, the re-ask names the rule', async () => {
    const issue = await askedRound1(t, 55, 3);
    const invalid = grillAnswer({ confidence: 60, open: [7] });
    t.models.replyJson(invalid).replyJson(invalid).replyJson(invalid);

    const row = await deliver(t, commented(55, 5501, 'Q1: yes.'));

    expect(row).toMatchObject({ status: 'FAILED' });
    const calls = await t.prisma.executionLog.findMany({
      where: { step: 'grill' },
      orderBy: [{ createdAt: 'asc' }, { attempt: 'asc' }],
    });
    expect(
      calls.slice(1).map(({ attempt, errorCode }) => [attempt, errorCode]),
    ).toEqual([
      [1, 'invalid-answer'],
      [2, 'invalid-answer'],
      [3, 'invalid-answer'],
    ]);
    expect(sent(1)).not.toContain('open lists Q7');
    expect(sent(2)).toContain('open lists Q7, but only Q1–Q3 were asked');
    expect(await run()).toMatchObject({
      stopStep: 'grill',
      stopCause: 'invalid-answer',
      stopRetryable: true,
      stops: 1,
    });
    expect(botComments(t, issue).at(-1)!.body).toContain(
      'comment `/retry` to continue run 1 where it stopped',
    );
    const { evaluations, answers } = await grillRows(t);
    expect(evaluations).toHaveLength(1);
    expect(answers).toEqual([]);
  });
});
