// Spec 7: the `documents` handler of spec 5's step-handler registry: the replies to commands and comments about the
// documents (spec "`/approve`", "`/approve please`", "A comment written while the bot writes the Spec", "Replies
// where nothing waits"). Every reply is a `document_actions` row stored with its text first, then posted once by its
// marker (DocumentPosts); a retried event replays the row (plan P34). After a reply the event ends `IGNORED` with its
// reason; a comment that needs nothing ends `no-transition` (plan P6).
import { Injectable } from '@nestjs/common';
import type { TaskComment } from '../contracts/workflow-input.js';
import type { TaskDocument } from '../generated/prisma/client.js';
import { GrillService } from '../grill/grill.service.js';
import { isApproveNearMiss } from '../intake/approve-command.js';
import type { StepOutcome } from '../workflow/decide.js';
import type {
  StepContext,
  StepHandler,
} from '../workflow/step-handler.registry.js';
import {
  approveHintReply,
  approveNothingWaitsReply,
  lateCommentReply,
  type NothingWaits,
} from './document-comments.js';
import { APPROVE_REFUSED, DocumentPosts } from './document-posts.js';
import { DocumentsStore } from './documents.store.js';

const NO_TRANSITION: StepOutcome = { type: 'IGNORED', reason: 'no-transition' };
const APPROVE_HINT: StepOutcome = { type: 'IGNORED', reason: 'approve-hint' };
const LATE_COMMENT: StepOutcome = { type: 'IGNORED', reason: 'late-comment' };

/** Row 36: an `/approve` in a status where nothing waits, by the result its row records. */
const NOTHING_WAITS: Partial<Record<StepContext['status'], NothingWaits>> = {
  draft: 'starting',
  executing: 'executing',
  'in-review': 'in-review',
  'needs-human': 'stopped',
};

@Injectable()
export class DocumentsHandler implements StepHandler {
  constructor(
    private readonly store: DocumentsStore,
    private readonly posts: DocumentPosts,
    private readonly grill: GrillService,
  ) {}

  async run(context: StepContext): Promise<StepOutcome | void> {
    switch (context.op) {
      case 'reply':
        return this.reply(context);
      default:
        throw new Error(`documents: no ${context.op} op`);
    }
  }

  private reply(context: StepContext): Promise<StepOutcome> {
    const { input } = context;
    switch (input.type) {
      case 'APPROVE':
        return context.approval === null
          ? this.nothingWaits(context, input.comment)
          : this.refuseApprove(context);
      case 'COMMENT':
        return this.comment(context, input.comment);
      default:
        throw new Error(`documents reply: a ${input.type} event`);
    }
  }

  /** Row 20: the gate refused this `/approve` (its verdict is in the context, plan P14). */
  private async refuseApprove(context: StepContext): Promise<StepOutcome> {
    const { approval, run, status, statusBeforeStop } = context;
    if (approval === null || approval === 'valid' || approval === 'done')
      throw new Error(`documents reply: an /approve judged ${approval}`);
    const waiting = await this.store.waiting(run.id, status, statusBeforeStop);
    if (!waiting)
      throw new Error(`documents reply: no waiting document in ${status}`);
    return this.posts.refuseApprove(context, approval, waiting);
  }

  /** Row 36 (SPW16): an `/approve` where nothing waits: one reply why, worded by the run's state (plan P14). */
  private async nothingWaits(
    context: StepContext,
    comment: TaskComment,
  ): Promise<StepOutcome> {
    const situation = NOTHING_WAITS[context.status];
    if (!situation)
      throw new Error(`documents reply: an /approve in ${context.status}`);
    await this.posts.answer(
      context,
      {
        documentId: null,
        action: 'approve-refused',
        result: situation,
        replyBody: approveNothingWaitsReply(
          comment.id,
          situation,
          context.run.number,
        ),
      },
      `/approve refused (${situation})`,
    );
    return APPROVE_REFUSED;
  }

  /**
   * Row 20, a plain comment while a document waits: a near miss of `/approve` gets the hint, once per waiting
   * document (plan P38); in `spec-review`, a comment written while the bot wrote the run's first Spec gets the
   * late-comment reply (SP12, SPW19); anything else needs nothing.
   */
  private async comment(
    context: StepContext,
    comment: TaskComment,
  ): Promise<StepOutcome> {
    const { run, status, statusBeforeStop } = context;
    const waiting = await this.store.waiting(run.id, status, statusBeforeStop);
    if (!waiting) return NO_TRANSITION;
    if (isApproveNearMiss(comment.body))
      return this.hint(context, comment, waiting);
    if (status === 'spec-review') {
      const first = await this.late(context, comment);
      if (first) {
        await this.posts.answer(
          context,
          {
            documentId: first.id,
            action: 'late-comment',
            result: 'late',
            replyBody: lateCommentReply(comment.id, context.input.sender),
          },
          `late comment ${comment.id} answered`,
        );
        return LATE_COMMENT;
      }
    }
    return NO_TRANSITION;
  }

  /** The hint, unless this waiting document already has one (from another comment). */
  private async hint(
    context: StepContext,
    comment: TaskComment,
    waiting: TaskDocument,
  ): Promise<StepOutcome> {
    const own = await this.store.actionFor('approve-hint', comment.id);
    if (!own && (await this.store.hintFor(waiting.id))) return NO_TRANSITION;
    await this.posts.answer(
      context,
      {
        documentId: waiting.id,
        action: 'approve-hint',
        result: 'hint',
        replyBody: approveHintReply(waiting.id),
      },
      `/approve hint (comment ${comment.id})`,
    );
    return APPROVE_HINT;
  }

  /**
   * SP12's four conditions (the fourth, not a near miss, is checked before): the comment was created before the run's
   * first Spec was posted, received after the run started (spec 6's rule 1), and Grill Me never read it. The first
   * Spec when they hold, else null.
   */
  private async late(
    context: StepContext,
    comment: TaskComment,
  ): Promise<TaskDocument | null> {
    const { run, input } = context;
    const first = await this.store.firstSpec(run.id);
    if (!first?.postedAt || comment.createdAt >= first.postedAt) return null;
    if (input.receivedAt < run.startEventReceivedAt) return null;
    const { answers } = await this.grill.transcript(run.id);
    return answers.some(({ commentId }) => commentId === comment.id)
      ? null
      : first;
  }
}
