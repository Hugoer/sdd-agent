// Spec 6: Grill Me, the `grill` handler of spec 5's step-handler registry. Every op first finishes what a crash
// left, then does its own work ("Exactly once and recovery", GM14).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
} from '../contracts/issue-provider.js';
import type {
  GrillEvaluation,
  GrillSession,
} from '../generated/prisma/client.js';
import type { StepOutcome } from '../workflow/decide.js';
import type {
  StepContext,
  StepHandler,
} from '../workflow/step-handler.registry.js';
import { issueTag } from '../workflow/task.service.js';
import { AnswerReader } from './answer-reader.service.js';
import {
  approveMarker,
  approveReply,
  clearComment,
  clearMarker,
  limitBody,
  roundMarker,
  skippedComment,
  skippedMarker,
  stoppedComment,
  stoppedMarker,
} from './grill-comments.js';
import {
  GrillEvaluationService,
  questionsOf,
  type Evaluated,
} from './grill-evaluation.service.js';
import { GrillStore } from './grill.store.js';

const ASKED: StepOutcome = { type: 'ASKED' };
const CLEAR: StepOutcome = { type: 'CLEAR' };

@Injectable()
export class GrillHandler implements StepHandler {
  private readonly logger = new Logger(GrillHandler.name);
  private readonly threshold: number;

  constructor(
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
    private readonly store: GrillStore,
    private readonly reader: AnswerReader,
    private readonly evaluation: GrillEvaluationService,
    config: ConfigService<Env, true>,
  ) {
    this.threshold = config.get('GRILL_CONFIDENCE_THRESHOLD', { infer: true });
  }

  async run(context: StepContext): Promise<StepOutcome | void> {
    const session = await this.store.session(context.run.id);
    // 1. Finish: a question comment stored by Tx1 but not posted yet; a wait's 👀 not added yet.
    const recovered =
      session !== null && (await this.postPending(context, session, true));
    if (session) await this.acknowledgePending(context, session);
    // 2. Own work; 3. return. Grill Me already ended (plan P1): the same answer to every op.
    if (session && session.status !== 'ASKING') {
      return this.ended(context, session);
    }
    switch (context.op) {
      case 'start':
        return this.start(context, session);
      case 'round':
        return this.round(context, session, recovered);
      case 'skip':
        return this.skip(context, session);
      case 'approve':
        return this.approve(context, session);
      default:
        throw new Error(`grill: no ${context.op} op`);
    }
  }

  /**
   * No session → create it and evaluate; no round posted yet → evaluate; a round posted (the run's start event
   * processed again) → the status shows `grilling`, with no model call.
   */
  private async start(
    context: StepContext,
    found: GrillSession | null,
  ): Promise<StepOutcome | void> {
    const session =
      found ?? (await this.store.createSession(context.lease, context.run.id));
    if (session.rounds > 0) return ASKED;
    const unread = await this.reader.unread(
      context.task.ref,
      context.run,
      session.id,
    );
    return this.acted(
      context,
      session,
      await this.evaluation.evaluate(context, session, unread),
      false,
    );
  }

  /**
   * A comment while asking: the answers not read yet, evaluated if there are any. When the comment that triggered
   * it was already read (by the evaluation of an earlier event, GM4), there is nothing to do: no model call.
   */
  private async round(
    context: StepContext,
    session: GrillSession | null,
    recovered: boolean,
  ): Promise<StepOutcome | void> {
    if (!session) throw new Error('grill round: the run has no session');
    const nothing = recovered ? ASKED : undefined;
    const trigger =
      context.input.type === 'COMMENT' ? context.input.comment.id : null;
    if (
      trigger !== null &&
      (await this.store.readCommentIds(session.id)).has(trigger)
    ) {
      this.log(context, `nothing new (comment ${trigger} already read)`);
      return nothing;
    }
    const unread = await this.reader.unread(
      context.task.ref,
      context.run,
      session.id,
    );
    if (unread.length === 0) {
      this.log(context, 'nothing new');
      return nothing;
    }
    return this.acted(
      context,
      session,
      await this.evaluation.evaluate(context, session, unread),
      recovered,
    );
  }

  /**
   * After the evaluation's transaction: post the question comment, add the wait's 👀, or end the session; then
   * step 3's outcome (a wait shows `grilling` only when step 1 posted a round).
   */
  private async acted(
    context: StepContext,
    session: GrillSession,
    evaluated: Evaluated,
    recovered: boolean,
  ): Promise<StepOutcome | void> {
    switch (evaluated) {
      case 'ASKED':
        await this.postPending(context, session, false);
        return ASKED;
      case 'WAITING':
        await this.acknowledgePending(context, session);
        return recovered ? ASKED : undefined;
      case 'CLEAR':
      case 'LIMIT':
        return this.ended(context, { ...session, status: evaluated });
    }
  }

  /**
   * `grill: skip` (GM8, GM15): the unread answers go into the session without a model call, so the Spec sees them.
   * Before the first question: `SKIPPED` and the skipped comment, which names nobody (GMW5). While asking:
   * `STOPPED` and the stopped comment, naming who added the label when its own event took the skip path. The router
   * runs the Spec next.
   */
  private async skip(
    context: StepContext,
    found: GrillSession | null,
  ): Promise<void> {
    const session =
      found ?? (await this.store.createSession(context.lease, context.run.id));
    const unread = await this.reader.unread(
      context.task.ref,
      context.run,
      session.id,
    );
    if (session.rounds === 0) {
      await this.store.recordSkipped(context.lease, session.id, unread);
      this.log(
        context,
        `skipped by grill: skip (${unread.length} comments read)`,
      );
      await this.postOnce(context, skippedMarker(session.id), () =>
        Promise.resolve(skippedComment(session.id)),
      );
      return;
    }
    const stoppedBy =
      context.input.type === 'SKIP_ADDED' ? context.input.sender : null;
    await this.store.recordStopped(context.lease, session.id, unread, {
      afterRound: session.rounds,
      stoppedBy,
    });
    this.log(context, 'stopped by grill: skip');
    await this.postOnce(context, stoppedMarker(session.id), () =>
      Promise.resolve(stoppedComment(session.id, stoppedBy)),
    );
  }

  /**
   * `/approve` while asking (GM8): one reply per `/approve` comment with the questions open now; nothing else
   * changes.
   */
  private async approve(
    context: StepContext,
    session: GrillSession | null,
  ): Promise<void> {
    if (!session) throw new Error('grill approve: the run has no session');
    const { input } = context;
    if (input.type !== 'APPROVE') {
      throw new Error(`grill approve: a ${input.type} event`);
    }
    const { id } = input.comment;
    await this.postOnce(context, approveMarker(id), async () =>
      approveReply(id, await this.openNow(session)),
    );
  }

  /**
   * From the latest evaluation that acted: after a question comment, its questions and the earlier ones it lists
   * as still open; after a 👀 wait, the ones that evaluation lists.
   */
  private async openNow(session: GrillSession): Promise<number[]> {
    const evaluation = await this.actingEvaluation(session);
    if (evaluation.result === 'WAITING') return ascending(evaluation.open);
    const round = await this.store.roundOf(evaluation.id);
    if (!round) {
      throw new Error(
        `grill evaluation ${evaluation.id} is ${evaluation.result} with no round`,
      );
    }
    return ascending([
      ...round.stillOpen,
      ...questionsOf(round).map(({ number }) => number),
    ]);
  }

  /** Plan P1: an ended session posts its closing comment if it is missing, then answers every op the same way. */
  private async ended(
    context: StepContext,
    session: GrillSession,
  ): Promise<StepOutcome | void> {
    switch (session.status) {
      case 'CLEAR':
        // "No questions needed" only when no question was asked in the run.
        if (session.rounds === 0) {
          await this.postOnce(context, clearMarker(session.id), () =>
            this.clearText(session),
          );
        }
        return CLEAR;
      case 'SKIPPED':
        await this.postOnce(context, skippedMarker(session.id), () =>
          Promise.resolve(skippedComment(session.id)),
        );
        return CLEAR;
      case 'STOPPED':
        // Rebuilt with the stored login, so a retried post names the same person.
        await this.postOnce(context, stoppedMarker(session.id), () =>
          Promise.resolve(stoppedComment(session.id, session.stoppedBy)),
        );
        return CLEAR;
      case 'LIMIT':
        // GM9: spec 5 stops the run with this body (its marker, no restart line); the same text on every retry.
        return { type: 'LIMIT', body: await this.limitText(context, session) };
      default:
        throw new Error(
          `grill: a ${session.status} session is built in a later task of spec 6`,
        );
    }
  }

  /** Built from the stored evaluation (plan P2), so a retried post is the same comment. */
  private async clearText(session: GrillSession): Promise<string> {
    const evaluation = await this.actingEvaluation(session);
    return clearComment(session.id, {
      confidence: evaluation.confidence,
      threshold: this.threshold,
      notes: evaluation.notes,
    });
  }

  /** The round-limit body from the stored evaluation and the rounds posted (plan P2, P3). */
  private async limitText(
    context: StepContext,
    session: GrillSession,
  ): Promise<string> {
    const evaluation = await this.actingEvaluation(session);
    return limitBody({
      rounds: session.rounds,
      confidence: evaluation.confidence,
      threshold: this.threshold,
      run: context.run,
      gaps: evaluation.gaps,
      notes: evaluation.notes,
    });
  }

  /** The latest evaluation that acted; for an ended session, the one that ended it (nothing is evaluated after). */
  private async actingEvaluation(
    session: GrillSession,
  ): Promise<GrillEvaluation> {
    const evaluation = await this.store.latestActingEvaluation(session.id);
    if (!evaluation) {
      throw new Error(
        `grill session ${session.id} is ${session.status} with no evaluation`,
      );
    }
    return evaluation;
  }

  /** "Find the marker, else post" for the stored question comment, then Tx2. */
  private async postPending(
    context: StepContext,
    session: GrillSession,
    recovered: boolean,
  ): Promise<boolean> {
    const round = await this.store.pendingRound(session.id);
    if (!round) return false;
    const { ref } = context.task;
    const comment =
      (await this.issues.findCommentByMarker(ref, roundMarker(round.id))) ??
      (await this.issues.postComment(ref, round.body));
    await this.store.markPosted(context.lease, round.id, {
      commentId: comment.id,
      commentUrl: comment.url,
      postedAt: comment.createdAt,
    });
    if (recovered) {
      this.log(context, `round ${round.number} posted (recovered)`);
    }
    return true;
  }

  /** 👀 on each comment a `WAITING` evaluation read (adding one twice changes nothing), then recorded. */
  private async acknowledgePending(
    context: StepContext,
    session: GrillSession,
  ): Promise<void> {
    const answers = await this.store.unacknowledged(session.id);
    if (answers.length === 0) return;
    for (const { commentId } of answers) {
      await this.issues.acknowledgeComment(context.task.ref, commentId);
    }
    await this.store.markAcknowledged(
      context.lease,
      session.id,
      answers.map(({ commentId }) => commentId),
    );
  }

  /** Spec 5's rule for every other comment: find the marker, else post. */
  private async postOnce(
    context: StepContext,
    marker: string,
    body: () => Promise<string>,
  ): Promise<void> {
    const { ref } = context.task;
    if (!(await this.issues.findCommentByMarker(ref, marker))) {
      await this.issues.postComment(ref, await body());
    }
  }

  private log(context: StepContext, message: string): void {
    this.logger.log(
      `${issueTag(context.task.ref.externalRef)} run ${context.run.number} grill: ${message}`,
    );
  }
}

/** Question numbers, each once, in order. */
function ascending(numbers: number[]): number[] {
  return [...new Set(numbers)].sort((a, b) => a - b);
}
