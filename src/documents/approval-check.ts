// Spec 7 "`/approve`" (R2, D10, SPW5; plan P7, P15, P26): the verdict on an `/approve` is a pure function of what the
// gate read; the gate reads the waiting document (by status), whether this event already approved a document of the
// run, and one `getComment` (none for the go-signal, which has no text).
import { Inject, Injectable } from '@nestjs/common';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
} from '../contracts/issue-provider.js';
import type { TaskDocument } from '../generated/prisma/client.js';
import type {
  ApprovalVerdict,
  RouterIgnoreReason,
} from '../workflow/decide.js';
import type {
  ApprovalGate,
  GateContext,
  NoRunContext,
} from '../workflow/step-handler.registry.js';
import { approveNothingWaitsReply } from './document-comments.js';
import { DocumentPosts } from './document-posts.js';
import { documentText } from './document-text.js';
import { DocumentsStore } from './documents.store.js';

export type WaitingDocument = Pick<
  TaskDocument,
  'kind' | 'approvedAt' | 'postedAt' | 'deletedAt'
>;

/**
 * The spec's table, in its order: this event's own approval (a retry) → valid, or `done` when it approved an earlier
 * document of the run; then already approved, written before the document's comment (GitHub's second: the same
 * second counts), deleted, empty. The go-signal checks only the time and the approval.
 */
export function approvalVerdict(
  waiting: WaitingDocument,
  approve: { createdAt: Date },
  comment: { body: string } | null,
  thisEventApproved: 'waiting' | 'earlier' | null,
): ApprovalVerdict {
  if (thisEventApproved === 'waiting') return 'valid';
  if (thisEventApproved === 'earlier') return 'done';
  if (waiting.approvedAt) return 'already-approved';
  if (!waiting.postedAt || approve.createdAt < waiting.postedAt)
    return 'before-document';
  if (waiting.kind === 'go-signal') return 'valid';
  if (!comment || waiting.deletedAt) return 'deleted';
  return documentText(comment.body) === '' ? 'empty' : 'valid';
}

/** The gate DocumentsModule registers with spec 5's registry (plan P7, P26). */
@Injectable()
export class DocumentsGate implements ApprovalGate {
  constructor(
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
    private readonly store: DocumentsStore,
    private readonly posts: DocumentPosts,
  ) {}

  /**
   * Row 5 (plan P7, P36): an `/approve` on an issue with no run gets one reply, and a `document_actions` row with no
   * run, counted with the other wasted actions.
   */
  async replyWithoutRun(context: NoRunContext): Promise<RouterIgnoreReason> {
    const { input } = context;
    if (input.type !== 'APPROVE')
      throw new Error(
        `approval gate: no reply without a run for ${input.type}`,
      );
    await this.posts.answer(
      context,
      {
        documentId: null,
        action: 'approve-refused',
        result: 'no-run',
        replyBody: approveNothingWaitsReply(input.comment.id, 'no-run', null),
      },
      '/approve refused (no-run)',
    );
    return 'approve-refused';
  }

  async verdict(context: GateContext): Promise<ApprovalVerdict> {
    const { input, run, status, lease, task } = context;
    if (input.type !== 'APPROVE')
      throw new Error(`approval gate: a ${input.type} event`);
    const waiting = await this.store.waiting(run.id, status, null);
    if (!waiting)
      throw new Error(
        `approval gate: run ${run.number} has no waiting document in ${status}`,
      );
    const approved = await this.store.approvedByEvent(run.id, lease.eventId);
    const thisEvent =
      approved.length === 0
        ? null
        : approved.some(({ id }) => id === waiting.id)
          ? 'waiting'
          : 'earlier';
    const comment =
      waiting.kind === 'go-signal' || !waiting.commentId
        ? null
        : await this.issues.getComment(task.ref, waiting.commentId);
    return approvalVerdict(waiting, input.comment, comment, thisEvent);
  }
}
