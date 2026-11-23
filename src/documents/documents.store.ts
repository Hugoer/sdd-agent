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

/** Spec "Approving" step 4: what an approval stores (approved at PostgreSQL's clock). */
export interface ApprovalRecord {
  /** The text between the markers at `/approve`, `redact()`ed (SPW5, SPW21). */
  approvedText: string;
  approvedBy: string;
  approveCommentId: string;
  /** The base-branch commit at the approval; null for the go-signal (it read no files). */
  approvedCommit: string | null;
  /** Changed since `checkedCommit` or `commit` and read by its calls (SP3). */
  staleFiles: string[];
  /** How many changed in all; null when not compared (the same commit, or the comparison failed). */
  changedFiles: number | null;
  /** Every changed path (plan P33). */
  changedPaths: string[];
  /** False when the host cut the list; null when not compared. */
  changedComplete: boolean | null;
  /** Posted text → approved text (SPW14); null for the go-signal (it has no text). */
  linesAdded: number | null;
  linesRemoved: number | null;
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

  /** The version of this kind a written document based on `basedOnId` already has (the Plan of an approved Spec). */
  writtenFrom(
    runId: string,
    kind: DocumentKind,
    basedOnId: string,
  ): Promise<TaskDocument | null> {
    return this.prisma.taskDocument.findFirst({
      where: { runId, kind, basedOnId, origin: 'written' },
    });
  }

  /** The next version number of this kind in the run: 1, 2, … (a restore keeps its number, SPW18). */
  async nextVersion(runId: string, kind: DocumentKind): Promise<number> {
    const { _max } = await this.prisma.taskDocument.aggregate({
      where: { runId, kind },
      _max: { version: true },
    });
    return (_max.version ?? 0) + 1;
  }

  /** SPW19: the run's first Spec (v1, written right after Grill Me), or null. */
  firstSpec(runId: string): Promise<TaskDocument | null> {
    return this.prisma.taskDocument.findFirst({
      where: { runId, kind: 'spec', origin: 'written', version: 1 },
    });
  }

  /** Plan P38: the hint a waiting document already got (one per document, enforced here under the lease). */
  hintFor(documentId: string): Promise<DocumentAction | null> {
    return this.prisma.documentAction.findFirst({
      where: { documentId, action: 'approve-hint' },
    });
  }

  byId(id: string): Promise<TaskDocument | null> {
    return this.prisma.taskDocument.findUnique({ where: { id } });
  }

  /** The run's documents this event approved (`approve_event_id`): how the gate knows a retried `/approve`. */
  approvedByEvent(runId: string, eventId: string): Promise<TaskDocument[]> {
    return this.prisma.taskDocument.findMany({
      where: { runId, approveEventId: eventId },
    });
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
   * (not approved, SPW8). So a run has at most one current Spec and one current Plan. A refresh's version comes with
   * its `/refresh` row, in the same transaction (plan P28).
   */
  insertVersion(
    lease: HeldLease,
    record: VersionRecord,
    action?: ActionRecord,
  ): Promise<TaskDocument> {
    return this.write(lease, async (tx) => {
      const row = await createVersion(tx, lease, record);
      // The row names the version it made, so it comes after it.
      if (action)
        await tx.documentAction.create({ data: actionData(lease, action) });
      return row;
    });
  }

  /**
   * Plan P28: the Plan's step answers a `/refresh` the Spec's step already recorded (in `ready-for-dev`): its result,
   * its call and its reply go on that row, in one transaction with the Plan's new version or its "checked" mark.
   */
  finishRefresh(
    lease: HeldLease,
    actionId: string,
    answer: Pick<ActionRecord, 'result' | 'documentId' | 'replyBody'> & {
      logIds: string[];
    },
    write: {
      version?: VersionRecord;
      checked?: { id: string; commit: string };
    },
  ): Promise<{ action: DocumentAction; version: TaskDocument | null }> {
    return this.write(lease, async (tx) => {
      const version = write.version
        ? await createVersion(tx, lease, write.version)
        : null;
      if (write.checked)
        await tx.taskDocument.update({
          where: { id: write.checked.id },
          data: { checkedCommit: write.checked.commit },
        });
      const action = await tx.documentAction.update({
        where: { id: actionId },
        data: {
          ...answer,
          replyPostState: answer.replyBody === null ? null : 'PENDING_POST',
        },
      });
      return { action, version };
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

  /**
   * Spec "`/approve`", the `deleted` verdict: the bot hadn't seen the deletion (the app was stopped), so it is
   * recorded now, without its text; a deletion already recorded stays as it was.
   */
  async recordMissedDeletion(lease: HeldLease, id: string): Promise<void> {
    await this.write(lease, async (tx) =>
      tx.taskDocument.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: await dbNow(tx) },
      }),
    );
  }

  /**
   * Spec "Approving" step 4: one transaction stores the approval, with the event that made it (a retry knows it),
   * and (SPW13) the warning reply that answers it, stored before it is posted.
   */
  approve(
    lease: HeldLease,
    id: string,
    record: ApprovalRecord,
    warning: ActionRecord | null = null,
  ): Promise<{ row: TaskDocument; warning: DocumentAction | null }> {
    return this.write(lease, async (tx) => {
      const row = await tx.taskDocument.update({
        where: { id },
        data: {
          ...record,
          approvedAt: await dbNow(tx),
          approveEventId: lease.eventId,
        },
      });
      return {
        row,
        warning:
          warning &&
          (await tx.documentAction.create({
            data: actionData(lease, warning),
          })),
      };
    });
  }

  /**
   * SPW11: a refresh found the document up to date at `commit`, which becomes its starting point; its `/refresh` row
   * (with the reply, when this step answers) in the same transaction (plan P28).
   */
  markUpToDate(
    lease: HeldLease,
    id: string,
    commit: string,
    action: ActionRecord,
  ): Promise<DocumentAction> {
    return this.write(lease, async (tx) => {
      await tx.taskDocument.update({
        where: { id },
        data: { checkedCommit: commit },
      });
      return tx.documentAction.create({ data: actionData(lease, action) });
    });
  }

  /** Tx1 of an answered action: the row, with its reply `PENDING_POST` when it has one. */
  insertAction(
    lease: HeldLease,
    record: ActionRecord,
  ): Promise<DocumentAction> {
    return this.write(lease, (tx) =>
      tx.documentAction.create({ data: actionData(lease, record) }),
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

/** An action's row: its task and event from the lease; its reply `PENDING_POST` when it has one. */
function actionData(lease: HeldLease, record: ActionRecord) {
  return {
    ...record,
    taskId: lease.taskId,
    eventId: lease.eventId,
    replyPostState: record.replyBody === null ? null : 'PENDING_POST',
  };
}

/**
 * Tx1 of a version (D13): every earlier version of the same kind in the run that isn't superseded yet is superseded,
 * approved or not; a new Spec also supersedes the run's Plan that waits (not approved, SPW8).
 */
async function createVersion(
  tx: Prisma.TransactionClient,
  lease: HeldLease,
  record: VersionRecord,
): Promise<TaskDocument> {
  const now = await dbNow(tx);
  await tx.taskDocument.updateMany({
    where: { runId: record.runId, kind: record.kind, supersededAt: null },
    data: { supersededAt: now },
  });
  if (record.kind === 'spec')
    await tx.taskDocument.updateMany({
      where: {
        runId: record.runId,
        kind: 'plan',
        supersededAt: null,
        approvedAt: null,
      },
      data: { supersededAt: now },
    });
  return tx.taskDocument.create({
    data: { ...record, taskId: lease.taskId, postState: 'PENDING_POST' },
  });
}

/** PostgreSQL's clock, as spec 5 uses it for every time it writes (its plan P7). */
async function dbNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return now;
}
