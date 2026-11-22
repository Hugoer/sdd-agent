// Spec 7 "Owned tables": the only writer of `task_documents` and `document_actions`. Every transaction first checks
// that this job still holds the issue's session lease (spec 5's assertHeld), so a job that lost it writes nothing.
import { Injectable } from '@nestjs/common';
import type { TaskStatus } from '../contracts/issue-provider.js';
import type {
  DocumentAction,
  Prisma,
  TaskDocument,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SessionLeaseService,
  type HeldLease,
} from '../workflow/session-lease.service.js';

export type DocumentKind = 'spec' | 'plan' | 'go-signal';
export type DocumentOrigin = 'written' | 'refreshed' | 'restored';
export type DocumentActionName =
  | 'approve-refused'
  | 'approve-hint'
  | 'approve-warning'
  | 'late-comment'
  | 'refresh'
  | 'refresh-refused'
  | 'deleted'
  | 'restore'
  | 'restore-refused';

/** A version, stored with its full comment before it is posted (Tx1). */
export interface VersionRecord {
  /** Chosen by the caller: the comment's marker names it. */
  id: string;
  runId: string;
  kind: DocumentKind;
  version: number;
  origin: DocumentOrigin;
  /** The version a refresh or a restore started from; a Plan `written`: the approved Spec. */
  basedOnId?: string | null;
  /** The base-branch commit its model read; null for the go-signal. */
  commit: string | null;
  /** The call's last `execution_logs` row; null for a restore and the go-signal. */
  logId: string | null;
  /** The document as posted; empty for the go-signal. */
  text: string;
  /** A refresh's "What changed" lines. */
  changes?: string[];
  /** The lines under the comment's rule (plan P12). */
  notes: string[];
  /** The `/refresh` or `/restore` that made it. */
  triggerCommentId?: string | null;
  /** The comment's full text with its marker, posted as is. */
  body: string;
}

/** A human action answered, stored with its reply before the reply is posted (Tx1). */
export interface ActionRecord {
  /** Chosen by the caller: the reply's marker names it. */
  id: string;
  /** Null when the issue has no run (plan P7). */
  runId: string | null;
  documentId: string | null;
  action: DocumentActionName;
  result: string;
  /** The human comment answered, or the deleted comment. */
  sourceCommentId: string;
  sender: string;
  logIds?: string[];
  /** The reply with its marker; null when the answer is a version. */
  replyBody: string | null;
}

/** What Tx2 records once a comment is on GitHub. */
export interface PostedComment {
  commentId: string;
  commentUrl: string;
  /** The comment's creation time on GitHub. */
  postedAt: Date;
}

@Injectable()
export class DocumentsStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leases: SessionLeaseService,
  ) {}

  /** A version of the run stored by Tx1 but not posted yet (a crash before Tx2), or null. */
  pendingVersion(runId: string): Promise<TaskDocument | null> {
    return this.prisma.taskDocument.findFirst({
      where: { runId, postState: 'PENDING_POST' },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** The run's version of this kind that no newer one replaced, or null. */
  current(runId: string, kind: DocumentKind): Promise<TaskDocument | null> {
    return this.prisma.taskDocument.findFirst({
      where: { runId, kind, supersededAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Plan P15, the spec's "The waiting document": chosen by status, never "the latest". `spec-review` → the
   * current Spec, even when a Plan is posted; `ready-for-dev` → the current Plan or the go-signal; `needs-human` →
   * the one of the status before the stop. It may be approved; the caller decides what that means.
   */
  async waiting(
    runId: string,
    status: TaskStatus,
    statusBeforeStop: TaskStatus | null,
  ): Promise<TaskDocument | null> {
    switch (status) {
      case 'spec-review':
        return this.current(runId, 'spec');
      case 'ready-for-dev':
        return this.prisma.taskDocument.findFirst({
          where: {
            runId,
            kind: { in: ['plan', 'go-signal'] },
            supersededAt: null,
          },
          orderBy: { createdAt: 'desc' },
        });
      case 'needs-human':
        return statusBeforeStop && statusBeforeStop !== 'needs-human'
          ? this.waiting(runId, statusBeforeStop, null)
          : null;
      default:
        return null;
    }
  }

  /** Plan P34: the version a `/refresh` or a `/restore` already made for this kind, or null. */
  versionFor(
    runId: string,
    kind: DocumentKind,
    triggerCommentId: string,
  ): Promise<TaskDocument | null> {
    return this.prisma.taskDocument.findFirst({
      where: { runId, kind, triggerCommentId },
    });
  }

  /** Plan P34: the action already recorded for this comment, also one with no run, or null. */
  actionFor(
    action: DocumentActionName,
    sourceCommentId: string,
  ): Promise<DocumentAction | null> {
    return this.prisma.documentAction.findUnique({
      where: { action_sourceCommentId: { action, sourceCommentId } },
    });
  }

  /**
   * Tx1 (D13): the version `PENDING_POST` with its full comment. Every earlier version of the same kind in the run
   * that isn't superseded yet is superseded, approved or not; a new Spec also supersedes the run's Plan that waits
   * (not approved, SPW8). So a run has at most one current Spec and one current Plan.
   */
  insertVersion(
    lease: HeldLease,
    record: VersionRecord,
  ): Promise<TaskDocument> {
    return this.write(lease, async (tx) => {
      const now = await dbNow(tx);
      await tx.taskDocument.updateMany({
        where: { runId: record.runId, kind: record.kind, supersededAt: null },
        data: { supersededAt: now },
      });
      if (record.kind === 'spec') {
        await tx.taskDocument.updateMany({
          where: {
            runId: record.runId,
            kind: 'plan',
            supersededAt: null,
            approvedAt: null,
          },
          data: { supersededAt: now },
        });
      }
      return tx.taskDocument.create({
        data: { ...record, taskId: lease.taskId, postState: 'PENDING_POST' },
      });
    });
  }

  /** Tx2: the version's comment is on GitHub. */
  markPosted(
    lease: HeldLease,
    id: string,
    posted: PostedComment,
  ): Promise<TaskDocument> {
    return this.write(lease, (tx) =>
      tx.taskDocument.update({
        where: { id },
        data: { ...posted, postState: 'POSTED' },
      }),
    );
  }

  /** Tx1 of an answered action: the row, with its reply `PENDING_POST` when it has one. */
  insertAction(
    lease: HeldLease,
    record: ActionRecord,
  ): Promise<DocumentAction> {
    return this.write(lease, (tx) =>
      tx.documentAction.create({
        data: {
          ...record,
          taskId: lease.taskId,
          eventId: lease.eventId,
          replyPostState: record.replyBody === null ? null : 'PENDING_POST',
        },
      }),
    );
  }

  /** Tx2 of an answered action: its reply is on GitHub. */
  markReplyPosted(
    lease: HeldLease,
    id: string,
    replyCommentId: string,
  ): Promise<DocumentAction> {
    return this.write(lease, (tx) =>
      tx.documentAction.update({
        where: { id },
        data: { replyCommentId, replyPostState: 'POSTED' },
      }),
    );
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
