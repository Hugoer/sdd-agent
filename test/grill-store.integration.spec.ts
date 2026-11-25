import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/config/env.schema.js';
import { EventsService } from '../src/events/events.service.js';
import {
  GrillStore,
  type AnswerRecord,
  type EvaluationRecord,
  type RoundRecord,
} from '../src/grill/grill.store.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RunService } from '../src/workflow/run.service.js';
import {
  SessionLeaseService,
  type HeldLease,
} from '../src/workflow/session-lease.service.js';
import { TaskService } from '../src/workflow/task.service.js';
import { LeaseLostError } from '../src/workflow/workflow-errors.js';
import { newDeliveryId } from './app.js';
import { resetDatabase } from './db.js';
import { testScanner } from './fakes/in-memory-context-loads.js';
import { testEnv } from './test-env.js';

// Spec 6 "Owned tables" through their only writer, under the lease (plan T7).

const OTHER_EVENT = '00000000-0000-4000-8000-0000000000ff';

const evaluation = (
  data: Partial<EvaluationRecord> = {},
): EvaluationRecord => ({
  logId: randomUUID(),
  model: 'gemini-4-hydrogen',
  modelLevel: 'standard',
  afterRound: 0,
  confidence: 40,
  questionsProposed: 4,
  open: [],
  gaps: ['who pays the tip'],
  notes: ['Model: `gemini-4-hydrogen` (standard)'],
  ...data,
});

const answer = (
  commentId: string,
  data: Partial<AnswerRecord> = {},
): AnswerRecord => ({
  commentId,
  author: 'alice',
  body: `Q1: yes (${commentId})`,
  url: `https://github.com/o/r/issues/12#issuecomment-${commentId}`,
  createdAt: new Date('2026-11-18T10:00:00Z'),
  ...data,
});

const round = (
  number: number,
  data: Partial<RoundRecord> = {},
): RoundRecord => ({
  id: randomUUID(),
  number,
  questions: [
    {
      number: 1,
      question: 'Who can split a bill?',
      guess: 'Anyone in the group',
    },
    { number: 2, question: 'In which currency?', guess: 'Euros only' },
  ],
  stillOpen: [],
  body: `<!-- sdd-agent:grill-round:x -->\nround ${number}`,
  ...data,
});

describe('GrillStore (PostgreSQL)', () => {
  let prisma: PrismaService;
  let leases: SessionLeaseService;
  let tasks: TaskService;
  let runs: RunService;
  let store: GrillStore;
  let lease: HeldLease;
  let runId: string;

  const lost = (): HeldLease => ({ ...lease, eventId: OTHER_EVENT });
  const counts = async () => ({
    sessions: await prisma.grillSession.count(),
    evaluations: await prisma.grillEvaluation.count(),
    rounds: await prisma.grillRound.count(),
    answers: await prisma.grillAnswer.count(),
  });
  const asked = (sessionId: string, number = 1, commentIds = ['101']) =>
    store.recordEvaluation(lease, sessionId, {
      result: 'ASKED',
      evaluation: evaluation({ afterRound: number - 1 }),
      answers: commentIds.map((id) => answer(id)),
      round: round(number),
    });

  beforeAll(async () => {
    const config = new ConfigService<Env, true>({
      DATABASE_URL: testEnv.DATABASE_URL,
      SESSION_LEASE_SECONDS: 120,
    });
    prisma = new PrismaService(config);
    await prisma.$connect();
    leases = new SessionLeaseService(prisma, config);
    tasks = new TaskService(prisma, leases);
    runs = new RunService(
      prisma,
      leases,
      new EventsService(prisma, testScanner()),
    );
    store = new GrillStore(prisma, leases);
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    const task = await tasks.findOrCreate({
      platform: 'GITHUB',
      id: '1012',
      externalRef: 'o/r#12',
    });
    const holder = await prisma.webhookEvent.create({
      data: {
        deliveryId: newDeliveryId(),
        eventName: 'issues',
        action: 'labeled',
        payload: {},
      },
    });
    lease = { taskId: task.id, eventId: holder.id };
    expect(await leases.claim(lease)).toBe(true);
    const run = await runs.create(lease, {
      lane: 'full-sdd',
      grillSkip: false,
      startEventId: holder.id,
    });
    runId = run.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates the run’s session: asking, no round, no question number, no confidence yet', async () => {
    const session = await store.createSession(lease, runId);

    expect(session).toMatchObject({
      taskId: lease.taskId,
      runId,
      status: 'ASKING',
      rounds: 0,
      lastQuestion: 0,
      firstConfidence: null,
      lastConfidence: null,
      stoppedBy: null,
      endedAt: null,
    });
    expect(await store.session(runId)).toEqual(session);
  });

  it('a second session for one run fails', async () => {
    await store.createSession(lease, runId);

    await expect(store.createSession(lease, runId)).rejects.toMatchObject({
      code: 'P2002',
    });
    expect(await prisma.grillSession.count()).toBe(1);
  });

  it('Tx1 for ASKED writes the evaluation, its answers, the session and the round PENDING_POST together', async () => {
    const session = await store.createSession(lease, runId);
    const record = evaluation();
    const stored = round(1);

    const { evaluation: row, round: roundRow } = await store.recordEvaluation(
      lease,
      session.id,
      {
        result: 'ASKED',
        evaluation: record,
        answers: [answer('101'), answer('102', { url: undefined })],
        round: stored,
      },
    );

    expect(row).toMatchObject({
      ...record,
      sessionId: session.id,
      result: 'ASKED',
    });
    expect(roundRow).toMatchObject({
      ...stored,
      sessionId: session.id,
      evaluationId: row.id,
      logId: record.logId,
      postState: 'PENDING_POST',
      commentId: null,
      commentUrl: null,
      postedAt: null,
    });
    expect(await store.answers(session.id)).toMatchObject([
      {
        commentId: '101',
        evaluationId: row.id,
        afterRound: 0,
        url: answer('101').url,
        acknowledged: false,
      },
      { commentId: '102', evaluationId: row.id, afterRound: 0, url: null },
    ]);
    expect(await store.session(runId)).toMatchObject({
      status: 'ASKING',
      rounds: 1,
      lastQuestion: 2,
      firstConfidence: 40,
      lastConfidence: 40,
      endedAt: null,
    });
    expect(await store.pendingRound(session.id)).toMatchObject({
      id: stored.id,
    });
    expect(await store.readCommentIds(session.id)).toEqual(
      new Set(['101', '102']),
    );
    expect(await store.latestActingEvaluation(session.id)).toMatchObject({
      id: row.id,
    });
  });

  it('Tx2 marks the round POSTED with the comment id, url and time; nothing is pending any more', async () => {
    const session = await store.createSession(lease, runId);
    const { round: stored } = await asked(session.id);
    const postedAt = new Date('2026-11-18T10:05:00Z');

    await store.markPosted(lease, stored!.id, {
      commentId: '201',
      commentUrl: 'https://github.com/o/r/issues/12#issuecomment-201',
      postedAt,
    });

    expect(await store.rounds(session.id)).toMatchObject([
      { number: 1, postState: 'POSTED', commentId: '201', postedAt },
    ]);
    expect(await store.pendingRound(session.id)).toBeNull();
  });

  it('a SUPERSEDED evaluation is its own write: it reads nothing, leaves the session as it was and never counts as the latest acting one', async () => {
    const session = await store.createSession(lease, runId);
    const { evaluation: acting } = await asked(session.id);

    const superseded = await store.recordSuperseded(
      lease,
      session.id,
      evaluation({ afterRound: 1, confidence: 90 }),
    );

    expect(superseded).toMatchObject({ result: 'SUPERSEDED', confidence: 90 });
    expect(
      await prisma.grillAnswer.count({
        where: { evaluationId: superseded.id },
      }),
    ).toBe(0);
    expect(await store.session(runId)).toMatchObject({
      rounds: 1,
      lastConfidence: 40,
    });
    expect(await store.latestActingEvaluation(session.id)).toMatchObject({
      id: acting.id,
    });
  });

  it('the first confidence stays, the last follows; WAITING changes nothing else; CLEAR ends the session', async () => {
    const session = await store.createSession(lease, runId);
    await asked(session.id);

    await store.recordEvaluation(lease, session.id, {
      result: 'WAITING',
      evaluation: evaluation({ afterRound: 1, confidence: 60, open: [2] }),
      answers: [answer('102')],
    });
    expect(await store.session(runId)).toMatchObject({
      status: 'ASKING',
      rounds: 1,
      lastQuestion: 2,
      firstConfidence: 40,
      lastConfidence: 60,
      endedAt: null,
    });

    await store.recordEvaluation(lease, session.id, {
      result: 'CLEAR',
      evaluation: evaluation({ afterRound: 1, confidence: 97 }),
      answers: [answer('103')],
    });
    const ended = await store.session(runId);
    expect(ended).toMatchObject({
      status: 'CLEAR',
      rounds: 1,
      firstConfidence: 40,
      lastConfidence: 97,
    });
    expect(ended?.endedAt).toBeInstanceOf(Date);
  });

  it('LIMIT ends the session without a round', async () => {
    const session = await store.createSession(lease, runId);

    const { round: none } = await store.recordEvaluation(lease, session.id, {
      result: 'LIMIT',
      evaluation: evaluation({ afterRound: 5, confidence: 70 }),
      answers: [],
    });

    expect(none).toBeNull();
    expect(await store.session(runId)).toMatchObject({
      status: 'LIMIT',
      rounds: 0,
    });
    expect(await prisma.grillRound.count()).toBe(0);
  });

  it('a round number twice in a session fails, and Tx1 rolls back as a whole: no evaluation, no answer, the session as it was', async () => {
    const session = await store.createSession(lease, runId);
    await asked(session.id, 1, ['101']);
    const before = await store.session(runId);

    await expect(asked(session.id, 1, ['102'])).rejects.toMatchObject({
      code: 'P2002',
    });

    expect(await counts()).toEqual({
      sessions: 1,
      evaluations: 1,
      rounds: 1,
      answers: 1,
    });
    expect(await store.readCommentIds(session.id)).toEqual(new Set(['101']));
    expect(await store.session(runId)).toEqual(before);
  });

  it('one comment read twice in a session fails', async () => {
    const session = await store.createSession(lease, runId);
    await asked(session.id, 1, ['101']);

    await expect(
      store.recordEvaluation(lease, session.id, {
        result: 'WAITING',
        evaluation: evaluation({ afterRound: 1 }),
        answers: [answer('101')],
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.grillEvaluation.count()).toBe(1);
  });

  it('two rounds for one evaluation fail', async () => {
    const session = await store.createSession(lease, runId);
    const { evaluation: row } = await asked(session.id);

    await expect(
      prisma.grillRound.create({
        data: {
          ...round(2),
          sessionId: session.id,
          evaluationId: row.id,
          logId: row.logId,
          postState: 'PENDING_POST',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a write with another lease owner throws LeaseLostError and writes nothing, in all four tables', async () => {
    await expect(store.createSession(lost(), runId)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    expect(await counts()).toEqual({
      sessions: 0,
      evaluations: 0,
      rounds: 0,
      answers: 0,
    });

    const session = await store.createSession(lease, runId);
    await expect(
      store.recordSuperseded(lost(), session.id, evaluation()),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await expect(
      store.recordEvaluation(lost(), session.id, {
        result: 'ASKED',
        evaluation: evaluation(),
        answers: [answer('101')],
        round: round(1),
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(await counts()).toEqual({
      sessions: 1,
      evaluations: 0,
      rounds: 0,
      answers: 0,
    });
    expect(await store.session(runId)).toMatchObject({
      rounds: 0,
      lastConfidence: null,
    });

    const { round: stored } = await asked(session.id);
    await expect(
      store.markPosted(lost(), stored!.id, {
        commentId: '201',
        commentUrl: 'https://github.com/o/r/issues/12#issuecomment-201',
        postedAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(await store.pendingRound(session.id)).toMatchObject({
      id: stored!.id,
      commentId: null,
    });
  });

  it('answers come back in creation order, then by comment id; rounds by number', async () => {
    const session = await store.createSession(lease, runId);
    const at = (iso: string) => new Date(iso);
    await asked(session.id, 1, []);
    await store.recordEvaluation(lease, session.id, {
      result: 'ASKED',
      evaluation: evaluation({ afterRound: 1 }),
      answers: [
        answer('305', { createdAt: at('2026-11-18T10:02:00Z') }),
        answer('304', { createdAt: at('2026-11-18T10:02:00Z') }),
        answer('301', { createdAt: at('2026-11-18T10:03:00Z') }),
        answer('309', { createdAt: at('2026-11-18T10:01:00Z') }),
      ],
      round: round(2, {
        questions: [{ number: 3, question: 'Rounding?', guess: 'To the cent' }],
        stillOpen: [2],
      }),
    });

    expect((await store.answers(session.id)).map((a) => a.commentId)).toEqual([
      '309',
      '304',
      '305',
      '301',
    ]);
    expect((await store.rounds(session.id)).map((r) => r.number)).toEqual([
      1, 2,
    ]);
    expect(await store.session(runId)).toMatchObject({
      rounds: 2,
      lastQuestion: 3,
    });
  });
});
