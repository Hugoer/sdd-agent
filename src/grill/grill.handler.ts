// Spec 6: Grill Me, the `grill` handler of spec 5's step-handler registry. Every op first finishes what a crash
// left, then does its own work ("Exactly once and recovery", GM14).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
} from '../contracts/issue-provider.js';
import type { GrillSession } from '../generated/prisma/client.js';
import type { StepOutcome } from '../workflow/decide.js';
import type {
  StepContext,
  StepHandler,
} from '../workflow/step-handler.registry.js';
import { issueTag } from '../workflow/task.service.js';
import { AnswerReader } from './answer-reader.service.js';
import {
  clearComment,
  clearMarker,
  roundMarker,
  skippedComment,
  skippedMarker,
} from './grill-comments.js';
import { GrillEvaluationService } from './grill-evaluation.service.js';
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
    // 1. Finish: a question comment stored by Tx1 but not posted yet.
    const recovered =
      session !== null && (await this.postPending(context, session, true));
    // 2. Own work; 3. return. Grill Me already ended (plan P1): the same answer to every op.
    if (session && session.status !== 'ASKING') {
      return this.ended(context, session);
    }
    switch (context.op) {
      case 'start':
        return this.start(context, session);
      case 'round':
        // Spec 6 plan T15 reads the new answers here.
        return recovered ? ASKED : undefined;
      case 'skip':
        return this.skip(context, session);
      default:
        throw new Error(
          `grill ${context.op} is built in a later task of spec 6`,
        );
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
    if (
      (await this.evaluation.evaluate(context, session, unread)) === 'CLEAR'
    ) {
      return this.ended(context, { ...session, status: 'CLEAR' });
    }
    await this.postPending(context, session, false);
    return ASKED;
  }

  /**
   * `grill: skip` before the first question (GM8, GM15): the unread answers go into the session without a model
   * call, so the Spec sees them; then the skipped comment, which names nobody (GMW5). The router runs the Spec next.
   */
  private async skip(
    context: StepContext,
    found: GrillSession | null,
  ): Promise<void> {
    if (found && found.rounds > 0) {
      throw new Error('grill skip while asking is built in spec 6 plan T17');
    }
    const session =
      found ?? (await this.store.createSession(context.lease, context.run.id));
    const unread = await this.reader.unread(
      context.task.ref,
      context.run,
      session.id,
    );
    await this.store.recordSkipped(context.lease, session.id, unread);
    this.log(
      context,
      `skipped by grill: skip (${unread.length} comments read)`,
    );
    await this.postOnce(context, skippedMarker(session.id), () =>
      Promise.resolve(skippedComment(session.id)),
    );
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
      default:
        throw new Error(
          `grill: a ${session.status} session is built in a later task of spec 6`,
        );
    }
  }

  /** Built from the stored evaluation (plan P2), so a retried post is the same comment. */
  private async clearText(session: GrillSession): Promise<string> {
    const evaluation = await this.store.latestActingEvaluation(session.id);
    if (!evaluation) {
      throw new Error(
        `grill session ${session.id} is CLEAR with no evaluation`,
      );
    }
    return clearComment(session.id, {
      confidence: evaluation.confidence,
      threshold: this.threshold,
      notes: evaluation.notes,
    });
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
