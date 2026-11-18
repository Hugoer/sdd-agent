// Spec 6 "Owned tables": the only writer of the four Grill tables. Every transaction first checks that this job
// still holds the issue's session lease (spec 5's assertHeld), so a job that lost it writes nothing.
import { Injectable } from '@nestjs/common';
import type {
  GrillAnswer,
  GrillEvaluation,
  GrillRound,
  GrillSession,
  Prisma,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SessionLeaseService,
  type HeldLease,
} from '../workflow/session-lease.service.js';

export type SessionStatus =
  'ASKING' | 'CLEAR' | 'LIMIT' | 'SKIPPED' | 'STOPPED' | 'CANCELLED';

/** What the bot did with an evaluation; `SUPERSEDED` = thrown away because comments arrived meanwhile (GM4). */
export type EvaluationResult =
  'ASKED' | 'CLEAR' | 'LIMIT' | 'WAITING' | 'SUPERSEDED';

/** One model evaluation as stored (`grill_evaluations`), without its result. */
export interface EvaluationRecord {
  /** `ExecutionLog` id of the call's last attempt (L16). */
  logId: string;
  model: string;
  modelLevel: string;
  /** Question comments posted when it ran (0 = before the first). */
  afterRound: number;
  confidence: number;
  /** How many questions the model returned, before the cap K. */
  questionsProposed: number;
  open: number[];
  gaps: string[];
  /** The lines under the comment's rule (plan P2). */
  notes: string[];
}

/** A comment read as an answer. */
export interface AnswerRecord {
  commentId: string;
  author: string;
  /** As written. */
  body: string;
  url?: string;
  /** The comment's creation time on GitHub. */
  createdAt: Date;
}

export type RoundQuestion = { number: number; question: string; guess: string };

/** A question comment, stored with its full text before it is posted (Tx1). */
export interface RoundRecord {
  /** Chosen by the caller: the comment's marker names it. */
  id: string;
  number: number;
  questions: RoundQuestion[];
  stillOpen: number[];
  /** The comment's full text with its marker, posted as is. */
  body: string;
}

/** An evaluation that acts: it is stored with the answers it read and changes the session (Tx1). */
export type ActingEvaluation =
  | {
      result: 'ASKED';
      evaluation: EvaluationRecord;
      answers: AnswerRecord[];
      round: RoundRecord;
    }
  | {
      result: 'CLEAR' | 'LIMIT' | 'WAITING';
      evaluation: EvaluationRecord;
      answers: AnswerRecord[];
    };

@Injectable()
export class GrillStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leases: SessionLeaseService,
  ) {}

  /** The run's session, or null before its first Grill call. */
  session(runId: string): Promise<GrillSession | null> {
    return this.prisma.grillSession.findUnique({ where: { runId } });
  }

  /** Its question comments, by number. */
  rounds(sessionId: string): Promise<GrillRound[]> {
    return this.prisma.grillRound.findMany({
      where: { sessionId },
      orderBy: { number: 'asc' },
    });
  }

  /** The comments it has read, in creation order, then by comment id. */
  answers(sessionId: string): Promise<GrillAnswer[]> {
    return this.prisma.grillAnswer.findMany({
      where: { sessionId },
      orderBy: [{ createdAt: 'asc' }, { commentId: 'asc' }],
    });
  }

  /** The latest evaluation that acted (any result but `SUPERSEDED`), or null. */
  latestActingEvaluation(sessionId: string): Promise<GrillEvaluation | null> {
    return this.prisma.grillEvaluation.findFirst({
      where: { sessionId, result: { not: 'SUPERSEDED' } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The question comment an `ASKED` evaluation stored, or null. */
  roundOf(evaluationId: string): Promise<GrillRound | null> {
    return this.prisma.grillRound.findUnique({ where: { evaluationId } });
  }

  /** A question comment stored by Tx1 but not posted yet (a crash before Tx2), or null. */
  pendingRound(sessionId: string): Promise<GrillRound | null> {
    return this.prisma.grillRound.findFirst({
      where: { sessionId, postState: 'PENDING_POST' },
    });
  }

  /** Comments a `WAITING` evaluation read whose 👀 isn't recorded yet (a crash or a failed reaction after Tx1). */
  unacknowledged(sessionId: string): Promise<GrillAnswer[]> {
    return this.prisma.grillAnswer.findMany({
      where: {
        sessionId,
        acknowledged: false,
        evaluation: { result: 'WAITING' },
      },
      orderBy: [{ createdAt: 'asc' }, { commentId: 'asc' }],
    });
  }

  /** The ids of the comments it has read (a comment is read once, GMW1). */
  async readCommentIds(sessionId: string): Promise<Set<string>> {
    const rows = await this.prisma.grillAnswer.findMany({
      where: { sessionId },
      select: { commentId: true },
    });
    return new Set(rows.map((row) => row.commentId));
  }

  /** The run's session, asking, with no round posted yet. */
  createSession(lease: HeldLease, runId: string): Promise<GrillSession> {
    return this.write(lease, (tx) =>
      tx.grillSession.create({
        data: { taskId: lease.taskId, runId, status: 'ASKING' },
      }),
    );
  }

  /** GM4: an evaluation thrown away because comments arrived meanwhile. Its own transaction; it reads nothing. */
  recordSuperseded(
    lease: HeldLease,
    sessionId: string,
    evaluation: EvaluationRecord,
  ): Promise<GrillEvaluation> {
    return this.write(lease, (tx) =>
      tx.grillEvaluation.create({
        data: { ...evaluation, sessionId, result: 'SUPERSEDED' },
      }),
    );
  }

  /**
   * Tx1: the evaluation, the answers it read, the session (the confidences; for `ASKED` one more round and the
   * last question number; `CLEAR` and `LIMIT` end it) and, for `ASKED`, the round `PENDING_POST` with its text.
   */
  recordEvaluation(
    lease: HeldLease,
    sessionId: string,
    acting: ActingEvaluation,
  ): Promise<{ evaluation: GrillEvaluation; round: GrillRound | null }> {
    const { result, evaluation: record, answers } = acting;
    return this.write(lease, async (tx) => {
      const evaluation = await tx.grillEvaluation.create({
        data: { ...record, sessionId, result },
      });
      await tx.grillAnswer.createMany({
        data: answers.map((answer) => ({
          ...answer,
          sessionId,
          evaluationId: evaluation.id,
          afterRound: record.afterRound,
        })),
      });
      const session = await tx.grillSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      const ends = result === 'CLEAR' || result === 'LIMIT';
      await tx.grillSession.update({
        where: { id: sessionId },
        data: {
          firstConfidence: session.firstConfidence ?? record.confidence,
          lastConfidence: record.confidence,
          ...(acting.result === 'ASKED' && {
            rounds: { increment: 1 },
            lastQuestion: Math.max(
              ...acting.round.questions.map((question) => question.number),
            ),
          }),
          ...(ends && { status: result, endedAt: await dbNow(tx) }),
        },
      });
      const round =
        acting.result === 'ASKED'
          ? await tx.grillRound.create({
              data: {
                ...acting.round,
                sessionId,
                evaluationId: evaluation.id,
                logId: record.logId,
                postState: 'PENDING_POST',
              },
            })
          : null;
      return { evaluation, round };
    });
  }

  /** Tx2: the question comment is on GitHub. */
  async markPosted(
    lease: HeldLease,
    roundId: string,
    posted: { commentId: string; commentUrl: string; postedAt: Date },
  ): Promise<void> {
    await this.write(lease, (tx) =>
      tx.grillRound.update({
        where: { id: roundId },
        data: { ...posted, postState: 'POSTED' },
      }),
    );
  }

  /** The bot's 👀 is on these comments of the session. */
  async markAcknowledged(
    lease: HeldLease,
    sessionId: string,
    commentIds: string[],
  ): Promise<void> {
    await this.write(lease, (tx) =>
      tx.grillAnswer.updateMany({
        where: { sessionId, commentId: { in: commentIds } },
        data: { acknowledged: true },
      }),
    );
  }

  /**
   * `grill: skip` before the first question: the answers read without a model call (no evaluation), and the
   * session ends `SKIPPED` with no confidence.
   */
  recordSkipped(
    lease: HeldLease,
    sessionId: string,
    answers: AnswerRecord[],
  ): Promise<void> {
    return this.endUnevaluated(lease, sessionId, answers, {
      afterRound: 0,
      status: 'SKIPPED',
      stoppedBy: null,
    });
  }

  /**
   * `grill: skip` while asking (GM8): the answers read without a model call, after the rounds posted, and the
   * session ends `STOPPED`; `stoppedBy` is the label event's sender, or null when a comment or a retried event took
   * the skip path (GM15).
   */
  recordStopped(
    lease: HeldLease,
    sessionId: string,
    answers: AnswerRecord[],
    end: { afterRound: number; stoppedBy: string | null },
  ): Promise<void> {
    return this.endUnevaluated(lease, sessionId, answers, {
      ...end,
      status: 'STOPPED',
    });
  }

  private async endUnevaluated(
    lease: HeldLease,
    sessionId: string,
    answers: AnswerRecord[],
    end: {
      afterRound: number;
      status: 'SKIPPED' | 'STOPPED';
      stoppedBy: string | null;
    },
  ): Promise<void> {
    await this.write(lease, async (tx) => {
      await tx.grillAnswer.createMany({
        data: answers.map((answer) => ({
          ...answer,
          sessionId,
          evaluationId: null,
          afterRound: end.afterRound,
        })),
      });
      await tx.grillSession.update({
        where: { id: sessionId },
        data: {
          status: end.status,
          stoppedBy: end.stoppedBy,
          endedAt: await dbNow(tx),
        },
      });
    });
  }

  private write<T>(
    lease: HeldLease,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.leases.assertHeld(tx, lease);
      return work(tx);
    });
  }
}

/** PostgreSQL's clock, as spec 5 uses it for every time it writes (its plan P7). */
async function dbNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return now;
}
