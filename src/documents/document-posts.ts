// Spec 7 "Two transactions + marker" (D13): every document comment and every reply is stored with its whole text
// first (Tx1), then posted once: its marker (the body's first line) is searched first, so a retried event never posts
// twice (Tx2). The `/approve` refusal lives here because two handlers answer one: the gate's verdict (`documents`)
// and an approve op that finds the comment gone or empty when it reads it again (plan P16).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
} from '../contracts/issue-provider.js';
import type { TaskComment } from '../contracts/workflow-input.js';
import type {
  DocumentAction,
  TaskDocument,
} from '../generated/prisma/client.js';
import type { StepOutcome } from '../workflow/decide.js';
import type {
  StepContext,
  StepRun,
} from '../workflow/step-handler.registry.js';
import { issueTag } from '../workflow/task.service.js';
import {
  approveRefusedReply,
  refreshRefusedReply,
  type ApproveRefusal,
  type RefreshRefusal,
} from './document-comments.js';
import {
  DocumentsStore,
  type ActionRecord,
  type DocumentKind,
} from './documents.store.js';

export const APPROVE_REFUSED: StepOutcome = {
  type: 'IGNORED',
  reason: 'approve-refused',
};

/** Plan P35: a `/refresh` that did nothing (deleted, empty, already approved) ends `IGNORED`. */
export const REFRESH_REFUSED: StepOutcome = {
  type: 'IGNORED',
  reason: 'refresh-refused',
};

/** What posting needs: the issue and the lease; a reply's row and its log line also name the run, when there is one. */
export type PostContext = Pick<StepContext, 'task' | 'lease' | 'input'> & {
  run?: StepRun;
};

/** A reply to answer, without what the event gives (the row's id, the comment answered, its sender, the run). */
export type Answer = Omit<
  ActionRecord,
  'id' | 'runId' | 'sourceCommentId' | 'sender'
>;

@Injectable()
export class DocumentPosts {
  private readonly logger = new Logger(DocumentPosts.name);

  constructor(
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
    private readonly store: DocumentsStore,
  ) {}

  /** A version's comment: find its marker, else post its stored body; then Tx2. */
  async postVersion(
    context: PostContext,
    row: TaskDocument,
  ): Promise<TaskDocument> {
    const { ref } = context.task;
    const comment =
      (await this.issues.findCommentByMarker(ref, markerOf(row.body))) ??
      (await this.issues.postComment(ref, row.body));
    return this.store.markPosted(context.lease, row.id, {
      commentId: comment.id,
      commentUrl: comment.url,
      postedAt: comment.createdAt,
    });
  }

  /** A reply stored by Tx1 and not posted yet: find its marker, else post it; then Tx2. Nothing for one posted. */
  async postReply(context: PostContext, row: DocumentAction): Promise<void> {
    if (row.replyPostState !== 'PENDING_POST' || row.replyBody === null) return;
    const { ref } = context.task;
    const posted =
      (await this.issues.findCommentByMarker(ref, markerOf(row.replyBody))) ??
      (await this.issues.postComment(ref, row.replyBody));
    await this.store.markReplyPosted(context.lease, row.id, posted);
  }

  /**
   * One reply to the event's comment: the row this comment already has for the action is replayed (plan P34: a
   * retried event never posts twice), else stored (Tx1) and logged; then posted once.
   */
  async answer(
    context: PostContext,
    answer: Answer,
    logLine: string,
  ): Promise<void> {
    const comment = commentOf(context);
    const recorded = await this.store.actionFor(answer.action, comment.id);
    const row =
      recorded ??
      (await this.store.insertAction(context.lease, {
        ...answer,
        id: randomUUID(),
        runId: context.run?.id ?? null,
        sourceCommentId: comment.id,
        sender: context.input.sender,
      }));
    if (!recorded) this.log(context, logLine);
    await this.postReply(context, row);
  }

  /**
   * Row 20: one reply per refused `/approve` comment, naming the waiting document; the event then ends `IGNORED`
   * `approve-refused` (plan P6). A `deleted` refusal also records the deletion, without its text, when the bot hadn't
   * seen it.
   */
  async refuseApprove(
    context: StepContext,
    refusal: ApproveRefusal,
    waiting: TaskDocument,
  ): Promise<StepOutcome> {
    const comment = commentOf(context);
    if (
      refusal === 'deleted' &&
      !waiting.deletedAt &&
      !(await this.store.actionFor('approve-refused', comment.id))
    )
      await this.store.recordMissedDeletion(context.lease, waiting.id);
    await this.answer(
      context,
      {
        documentId: waiting.id,
        action: 'approve-refused',
        result: refusal,
        replyBody: approveRefusedReply(
          comment,
          refusal,
          {
            kind: waiting.kind as DocumentKind,
            version: waiting.version,
            url: waiting.commentUrl,
            approvedBy: waiting.approvedBy,
          },
          context.run.lane,
        ),
      },
      `/approve refused (${refusal})`,
    );
    return APPROVE_REFUSED;
  }

  /**
   * Spec "`/refresh`" step 1 (SPW23, plan P5): one reply when the document to refresh is deleted, emptied or
   * already approved, before any model call; a deletion the bot hadn't seen is recorded (without its text).
   */
  async refuseRefresh(
    context: StepContext,
    refusal: RefreshRefusal,
    doc: TaskDocument,
  ): Promise<StepOutcome> {
    const comment = commentOf(context);
    if (
      refusal === 'deleted' &&
      !doc.deletedAt &&
      !(await this.store.actionFor('refresh', comment.id))
    )
      await this.store.recordMissedDeletion(context.lease, doc.id);
    await this.answer(
      context,
      {
        documentId: doc.id,
        action: 'refresh',
        result: refusal,
        replyBody: refreshRefusedReply(comment, refusal, {
          kind: doc.kind as 'spec' | 'plan',
          version: doc.version,
        }),
      },
      `/refresh refused (${refusal})`,
    );
    return REFRESH_REFUSED;
  }

  /** `#12 run 2 documents: …` (or `#12 documents: …` with no run), the spec's log lines. */
  log(
    context: Pick<PostContext, 'task' | 'run'>,
    message: string,
    step = 'documents',
  ): void {
    const run = context.run ? ` run ${context.run.number}` : '';
    this.logger.log(
      `${issueTag(context.task.ref.externalRef)}${run} ${step}: ${message}`,
    );
  }
}

/** Every comment and reply of spec 7 starts with its hidden marker line. */
function markerOf(body: string): string {
  return body.split('\n')[0];
}

/** The human comment the event carries (a command or a plain comment). */
function commentOf(context: PostContext): TaskComment {
  const { input } = context;
  if (!('comment' in input))
    throw new Error(`a reply needs a comment, got a ${input.type} event`);
  return input.comment;
}
