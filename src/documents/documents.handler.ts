// Spec 7: the `documents` handler of spec 5's step-handler registry: the replies to commands and comments about the
// documents (spec "`/approve`", "`/approve please`", "A comment written while the bot writes the Spec", "Replies
// where nothing waits"). Every reply is a `document_actions` row stored with its text first, then posted once by its
// marker (DocumentPosts); a retried event replays the row (plan P34). After a reply the event ends `IGNORED` with its
// reason; a comment that needs nothing ends `no-transition` (plan P6).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
  type Lane,
} from '../contracts/issue-provider.js';
import type { TaskComment } from '../contracts/workflow-input.js';
import type { TaskDocument } from '../generated/prisma/client.js';
import { GrillService } from '../grill/grill.service.js';
import { isApproveNearMiss } from '../intake/approve-command.js';
import { SecretScanner } from '../secret-scan/secret-scanner.js';
import type { StepOutcome } from '../workflow/decide.js';
import type {
  CancelContext,
  StepContext,
  StepHandler,
} from '../workflow/step-handler.registry.js';
import {
  approveHintReply,
  documentDeletedComment,
  lateCommentReply,
  planComment,
  restoreRefusedReply,
  runEndedLine,
  specComment,
  nothingWaitsReply,
  type NothingWaits,
} from './document-comments.js';
import {
  APPROVE_REFUSED,
  DocumentPosts,
  REFRESH_REFUSED,
} from './document-posts.js';
import { cleanDocument, documentText } from './document-text.js';
import { DocumentsStore } from './documents.store.js';

const NO_TRANSITION: StepOutcome = { type: 'IGNORED', reason: 'no-transition' };
const RESTORE_REFUSED: StepOutcome = {
  type: 'IGNORED',
  reason: 'restore-refused',
};
/** Plan P35: the `/restore` results that did nothing; a replayed one ends `IGNORED` again (P34). */
const RESTORE_REFUSALS = new Set(['nothing-deleted', 'approved']);
const APPROVE_HINT: StepOutcome = { type: 'IGNORED', reason: 'approve-hint' };
const LATE_COMMENT: StepOutcome = { type: 'IGNORED', reason: 'late-comment' };

/** Rows 35, 36: a command in a status where nothing waits, by the result its row records. */
const NOTHING_WAITS: Partial<Record<StepContext['status'], NothingWaits>> = {
  draft: 'starting',
  grilling: 'grilling',
  'ready-for-dev': 'code-only', // a `/refresh` in `code-only` (decide() sends `full-sdd`'s to the steps)
  executing: 'executing',
  'in-review': 'in-review',
  'needs-human': 'stopped',
};

@Injectable()
export class DocumentsHandler implements StepHandler {
  private readonly base: string;

  constructor(
    private readonly store: DocumentsStore,
    private readonly posts: DocumentPosts,
    private readonly grill: GrillService,
    private readonly scanner: SecretScanner,
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
    config: ConfigService<Env, true>,
  ) {
    this.base = config.get('TARGET_BASE_BRANCH', { infer: true });
  }

  async run(context: StepContext): Promise<StepOutcome | void> {
    switch (context.op) {
      case 'reply':
        return this.reply(context);
      case 'deleted':
        return this.deleted(context);
      case 'restore':
        return this.restore(context);
      default:
        throw new Error(`documents: no ${context.op} op`);
    }
  }

  /**
   * Row 33 (SP9, D30): a deleted bot comment that is the waiting document's, not approved (P15) → its deletion stored
   * (when, by whom, its last text between the markers, redacted) and one explanation. Any other deleted bot comment
   * (the explanation, a Grill round, an older version, an approved document, the go-signal) → nothing. Plan P34: the
   * event run again replays its row.
   */
  private async deleted(context: StepContext): Promise<StepOutcome | void> {
    const { input, run, status, statusBeforeStop, lease } = context;
    if (input.type !== 'BOT_COMMENT_DELETED')
      throw new Error(`documents deleted: a ${input.type} event`);
    const recorded = await this.store.actionFor('deleted', input.comment.id);
    if (recorded) return this.posts.postReply(context, recorded);
    const waiting = await this.store.waiting(run.id, status, statusBeforeStop);
    if (
      !waiting ||
      waiting.commentId !== input.comment.id ||
      waiting.approvedAt ||
      (waiting.kind !== 'spec' && waiting.kind !== 'plan')
    )
      return NO_TRANSITION;
    const row = await this.store.recordDeletion(
      lease,
      waiting.id,
      {
        deletedBy: input.sender,
        deletedText: this.scanner.redact(documentText(input.comment.body)).text,
      },
      {
        id: randomUUID(),
        runId: run.id,
        documentId: waiting.id,
        action: 'deleted',
        result: waiting.kind,
        sourceCommentId: input.comment.id,
        sender: input.sender,
        replyBody: documentDeletedComment(input.comment.id, {
          kind: waiting.kind,
          version: waiting.version,
          by: input.sender,
          lane: run.lane,
          stoppedRun: status === 'needs-human' ? run.number : null,
        }),
      },
    );
    this.posts.log(
      context,
      `${waiting.kind} v${waiting.version} deleted by ${input.sender}`,
    );
    await this.posts.postReply(context, row);
  }

  /**
   * Row 34 (SP9, the spec's `/restore` table, plan P12, P24): the waiting document deleted → a new row with the same
   * version number posted from its last text, or (a deletion the bot missed) from its own text with the lost-edits
   * line; still there → one reply with its link; approved (or, with the Plan waiting, the approved Spec's comment
   * gone) → one reply. No model call. Plan P34: a `/restore` already answered replays its row.
   */
  private async restore(context: StepContext): Promise<StepOutcome | void> {
    const { input, run, status, statusBeforeStop, lease, task } = context;
    if (input.type !== 'RESTORE')
      throw new Error(`documents restore: a ${input.type} event`);
    const recorded = await this.store.actionFor('restore', input.comment.id);
    if (recorded) {
      const made = recorded.documentId
        ? await this.store.byId(recorded.documentId)
        : null;
      if (recorded.replyBody === null && made?.postState === 'PENDING_POST')
        await this.posts.postVersion(context, made);
      await this.posts.postReply(context, recorded);
      return RESTORE_REFUSALS.has(recorded.result)
        ? RESTORE_REFUSED
        : undefined;
    }
    const waiting = await this.store.waiting(run.id, status, statusBeforeStop);
    if (waiting?.kind !== 'spec' && waiting?.kind !== 'plan')
      throw new Error(
        `documents restore: no waiting Spec or Plan in ${status}`,
      );
    if (waiting.approvedAt)
      return this.refuseRestore(context, 'approved', waiting);
    const there =
      waiting.deletedAt || !waiting.commentId
        ? null
        : await this.issues.getComment(task.ref, waiting.commentId);
    const spec =
      waiting.kind === 'plan' ? await this.store.current(run.id, 'spec') : null;
    if (there) {
      // The waiting Plan is there; the comment gone may be the approved Spec's, whose text the bot keeps.
      if (
        spec?.commentId &&
        !(await this.issues.getComment(task.ref, spec.commentId))
      )
        return this.refuseRestore(context, 'approved', spec);
      return this.refuseRestore(context, 'nothing-deleted', waiting);
    }

    if (!waiting.deletedAt)
      await this.store.recordMissedDeletion(lease, waiting.id);
    // The deletion's last text; a deletion the bot missed (or one that left no text): its own last version.
    const lost = !waiting.deletedText;
    const text = cleanDocument(waiting.deletedText || waiting.text);
    const versionId = randomUUID();
    const origin = {
      kind: 'restored' as const,
      by: input.sender,
      command: input.comment,
      lost,
    };
    const common = {
      versionId,
      version: waiting.version,
      base: this.base,
      commit: waiting.commit ?? '',
      text,
      notes: waiting.notes,
      origin,
    };
    const body =
      waiting.kind === 'spec'
        ? specComment({
            ...common,
            run: { number: run.number, lane: documentLane(run.lane) },
          })
        : planComment({
            ...common,
            run: { number: run.number },
            specVersion: spec?.version ?? 1,
            warning: null,
          });
    const row = await this.store.insertVersion(
      lease,
      {
        id: versionId,
        runId: run.id,
        kind: waiting.kind,
        version: waiting.version,
        origin: 'restored',
        basedOnId: waiting.id,
        commit: waiting.commit,
        logId: null,
        text,
        notes: waiting.notes,
        triggerCommentId: input.comment.id,
        body,
      },
      {
        id: randomUUID(),
        runId: run.id,
        documentId: versionId,
        action: 'restore',
        result: lost ? 'restored-last-version' : 'restored',
        sourceCommentId: input.comment.id,
        sender: input.sender,
        replyBody: null,
      },
    );
    this.posts.log(
      context,
      `/restore → ${waiting.kind} v${waiting.version} restored (${lost ? 'its last version' : 'as deleted'})`,
    );
    await this.posts.postVersion(context, row);
  }

  /** The spec's `/restore` table: still there, or approved → one reply, `IGNORED` `restore-refused` (plan P35). */
  private async refuseRestore(
    context: StepContext,
    refusal: 'nothing-deleted' | 'approved',
    doc: TaskDocument,
  ): Promise<StepOutcome> {
    if (context.input.type !== 'RESTORE')
      throw new Error(`a /restore reply for a ${context.input.type} event`);
    await this.posts.answer(
      context,
      {
        documentId: doc.id,
        action: 'restore',
        result: refusal,
        replyBody: restoreRefusedReply(context.input.comment, refusal, {
          kind: doc.kind as 'spec' | 'plan',
          version: doc.version,
          url: doc.commentUrl,
        }),
      },
      `/restore refused (${refusal})`,
    );
    return RESTORE_REFUSED;
  }

  /**
   * SPW10 (spec 5's RL18 seam): when the run is cancelled or replaced, one line linking its current Spec and Plan
   * (not superseded, not deleted, approved or not), or null. Built from the rows only, with no write, so the second
   * call when the comment is posted later (spec 5's plan Q1) gives the same line.
   */
  async onCancel(context: CancelContext): Promise<string | null> {
    const documents = [];
    for (const kind of ['spec', 'plan'] as const) {
      const doc = await this.store.current(context.run.id, kind);
      if (doc && !doc.deletedAt)
        documents.push({ kind, version: doc.version, url: doc.commentUrl });
    }
    return runEndedLine({
      run: context.run.number,
      end: context.end,
      documents,
    });
  }

  private reply(context: StepContext): Promise<StepOutcome> {
    const { input } = context;
    switch (input.type) {
      case 'APPROVE':
        return context.approval === null
          ? this.nothingWaits(context, 'approve', input.comment)
          : this.refuseApprove(context);
      case 'REFRESH':
        return this.nothingWaits(context, 'refresh', input.comment);
      case 'RESTORE':
        return this.nothingWaits(context, 'restore', input.comment);
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

  /** Rows 35, 36 (SPW16): a command where nothing waits: one reply why, worded by the run's state (plan P14). */
  private async nothingWaits(
    context: StepContext,
    command: 'approve' | 'refresh' | 'restore',
    comment: TaskComment,
  ): Promise<StepOutcome> {
    const situation = NOTHING_WAITS[context.status];
    if (!situation)
      throw new Error(`documents reply: a /${command} in ${context.status}`);
    await this.posts.answer(
      context,
      {
        documentId: null,
        action: `${command}-refused`,
        result: situation,
        replyBody: nothingWaitsReply(
          command,
          comment,
          situation,
          context.run.number,
        ),
      },
      `/${command} refused (${situation})`,
    );
    return {
      approve: APPROVE_REFUSED,
      refresh: REFRESH_REFUSED,
      restore: RESTORE_REFUSED,
    }[command];
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
            replyBody: lateCommentReply(comment, context.input.sender),
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
        replyBody: approveHintReply(waiting.id, comment),
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

/** A Spec or a Plan belongs to `full-sdd` or `spec-code` (a restore never reaches `code-only`). */
function documentLane(lane: Lane): Exclude<Lane, 'code-only'> {
  if (lane === 'code-only')
    throw new Error('documents: a code-only run has no Spec or Plan');
  return lane;
}
