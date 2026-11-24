// Spec 7 "Approving" (SP3, SPW5, SPW14, SPW21; plan P4, P16, P20, P33): an `/approve` the gate found valid becomes
// the approved snapshot. Spec 14 (UA1–UA3, UAW3, UAW5, UAW9): first the comment is read again; then, when `main`
// moved since the document's starting point, the files it read are compared, and a question is asked instead when
// one changed, GitHub can't compare, or the change is large. An approval that counts stores the full range.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
} from '../contracts/issue-provider.js';
import { ProviderError } from '../contracts/provider-error.js';
import {
  REPO_PROVIDER,
  type RepoProvider,
} from '../contracts/repo-provider.js';
import type { TaskDocument } from '../generated/prisma/client.js';
import { ContextLoadService } from '../llm/context-load.service.js';
import { SecretScanner } from '../secret-scan/secret-scanner.js';
import type { StepContext } from '../workflow/step-handler.registry.js';
import {
  chainReads,
  flaggedFiles,
  questionFor,
  startOf,
  type ChainVersion,
  type FlaggedFile,
  type Question,
  type Read,
  type StartingPoint,
} from './commit-check.js';
import { approveAskedReply } from './document-comments.js';
import { DocumentPosts } from './document-posts.js';
import { documentText, lineCounts } from './document-text.js';
import { DocumentsStore } from './documents.store.js';

/** Spec 14 "Contracts": what an `/approve` the gate found valid came to. */
export type ApprovalResult =
  | {
      kind: 'approved';
      row: TaskDocument;
      flagged: FlaggedFile[];
      /** False when GitHub couldn't compare the full range (stored as not compared). */
      compared: boolean;
    }
  | { kind: 'asked'; result: Question['result'] }
  /** Spec 7 plan P16: gone or empty since the gate read it. */
  | { kind: 'refused' };

type Changed = { paths: string[]; complete: boolean } | 'not-compared';

@Injectable()
export class DocumentApprovals {
  private readonly base: string;
  private readonly largeChange: number;

  constructor(
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
    @Inject(REPO_PROVIDER) private readonly repo: RepoProvider,
    private readonly store: DocumentsStore,
    private readonly loads: ContextLoadService,
    private readonly scanner: SecretScanner,
    private readonly posts: DocumentPosts,
    config: ConfigService<Env, true>,
  ) {
    this.base = config.get('TARGET_BASE_BRANCH', { infer: true });
    this.largeChange = config.get('APPROVAL_LARGE_CHANGE_FILES', {
      infer: true,
    });
  }

  /**
   * The waiting Spec or Plan. Spec 7 plan P16: the comment is read again and that text is approved; gone or empty
   * since the gate read it → the refusal reply. Spec 14: `main` moved since the starting point and a file it read
   * changed, GitHub can't compare, or more than `APPROVAL_LARGE_CHANGE_FILES` changed → one question instead (UAW9:
   * `asked_commit` and its row in one transaction, then the reply). Else the approval, with the full range since
   * `checked_commit ?? commit` (UAW3, plan UP9); no reply (UAW10).
   */
  async approve(
    context: StepContext,
    doc: TaskDocument,
  ): Promise<ApprovalResult> {
    const { input, lease, task } = context;
    if (input.type !== 'APPROVE')
      throw new Error(`an approval for a ${input.type} event`);
    const comment = doc.commentId
      ? await this.issues.getComment(task.ref, doc.commentId)
      : null;
    const text = comment
      ? this.scanner.redact(documentText(comment.body)).text
      : '';
    if (text === '') {
      await this.posts.refuseApprove(
        context,
        comment ? 'empty' : 'deleted',
        doc,
      );
      return { kind: 'refused' };
    }

    const now = await this.repo.resolveRef(this.base);
    const start = startOf(doc);
    const from = doc.checkedCommit ?? doc.commit;
    if (start === null || from === null)
      throw new Error(`approval: ${doc.kind} ${doc.id} has no commit`);
    let reads: Read[] | null = null;
    const readsOnce = async () => (reads ??= await this.readsOf(doc));
    let sinceStart: Changed | null = null;
    if (start.commit !== now) {
      sinceStart = await this.changedSince(start.commit, now);
      const question = questionFor({
        changed: sinceStart,
        reads: await readsOnce(),
        threshold: this.largeChange,
      });
      if (question) {
        await this.ask(context, doc, start, now, question);
        return { kind: 'asked', result: question.result };
      }
    }

    // The full range: the decision's own list when it started there too (no question before), else one more compare.
    const changed =
      from === now
        ? null
        : from === start.commit
          ? sinceStart
          : await this.changedSince(from, now);
    const listed =
      changed === null || changed === 'not-compared' ? null : changed;
    const flagged = listed ? flaggedFiles(listed.paths, await readsOnce()) : [];
    const compared = changed !== 'not-compared';
    const { linesAdded, linesRemoved } = lineCounts(doc.text, text);
    const row = await this.store.approve(lease, doc.id, {
      approvedText: text,
      approvedBy: input.sender,
      approveCommentId: input.comment.id,
      approvedCommit: now,
      approvedFromCommit: from,
      staleFiles: flagged.map(({ path }) => path),
      changedFiles: listed?.paths.length ?? null,
      changedPaths: listed?.paths ?? [],
      changedComplete: listed?.complete ?? null,
      linesAdded,
      linesRemoved,
    });
    const files = compared
      ? `${flagged.length} file${flagged.length === 1 ? '' : 's'} flagged`
      : 'not compared';
    this.posts.log(
      context,
      `v${doc.version} approved by ${input.sender} (${files}, +${linesAdded} −${linesRemoved} lines)`,
      doc.kind,
    );
    return { kind: 'approved', row, flagged, compared };
  }

  /** Spec 14 "The question": `asked_commit` and the `approve-asked` row in one transaction, the log line, the reply. */
  private async ask(
    context: StepContext,
    doc: TaskDocument,
    start: StartingPoint,
    now: string,
    question: Question,
  ): Promise<void> {
    const { input, run } = context;
    if (input.type !== 'APPROVE')
      throw new Error(`a question for a ${input.type} event`);
    const kind = doc.kind as 'spec' | 'plan';
    const last =
      start.kind === 'asked' ? await this.store.lastQuestion(doc.id) : null;
    const spec =
      kind === 'plan' ? await this.store.current(run.id, 'spec') : null;
    const counted = question.result !== 'not-compared';
    const row = await this.store.ask(context.lease, doc.id, now, {
      id: randomUUID(),
      runId: run.id,
      documentId: doc.id,
      action: 'approve-asked',
      result: question.result,
      sourceCommentId: input.comment.id,
      sender: input.sender,
      fromCommit: start.commit,
      toCommit: now,
      files: question.result === 'stale' ? question.flagged : [],
      changedFiles: counted ? question.changedFiles : null,
      filesComplete: counted ? question.complete : null,
      replyBody: approveAskedReply({
        approve: input.comment,
        document: { kind, version: doc.version },
        ...(spec && { specVersion: spec.version }),
        base: this.base,
        start,
        questionUrl: last?.replyCommentUrl ?? null,
        question,
        compareUrl: this.repo.compareUrl(start.commit, now),
      }),
    });
    this.posts.log(
      context,
      `v${doc.version} /approve asked (${questionLog(question, start)})`,
      kind,
    );
    await this.posts.postReply(context, row);
  }

  /**
   * Plan P4: what the document's calls read, and every version it is based on (`basedOnId`, back to the first
   * writer; a Plan's chain goes on into its approved Spec's), each with who read it.
   */
  async readsOf(doc: TaskDocument): Promise<Read[]> {
    const chain: ChainVersion[] = [];
    for (
      let version: TaskDocument | null = doc;
      version;
      version = version.basedOnId
        ? await this.store.byId(version.basedOnId)
        : null
    )
      chain.push({ kind: version.kind, logId: version.logId });
    const logIds = chain.flatMap(({ logId }) => (logId ? [logId] : []));
    return chainReads(doc.kind, chain, await this.loads.loadedPaths(logIds));
  }

  /**
   * The files changed from one commit to another (an approval's commit check, a refresh's list). Plan P32: only
   * GitHub's "unknown commit" (404, 422) counts as not compared; any other error passes through.
   */
  async changedSince(from: string, to: string): Promise<Changed> {
    try {
      return await this.repo.changedFiles(from, to);
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.kind === 'permanent' &&
        (error.detail.status === 404 || error.detail.status === 422)
      )
        return 'not-compared';
      throw error;
    }
  }
}

/** UP19: "stale, 1 file read changed since 4f2c1ab", "not-compared", "large-change, 42 files". */
function questionLog(question: Question, start: StartingPoint): string {
  switch (question.result) {
    case 'stale': {
      const count = question.flagged.length;
      return `stale, ${count} file${count === 1 ? '' : 's'} read changed since ${start.commit.slice(0, 7)}`;
    }
    case 'not-compared':
      return 'not-compared';
    case 'large-change':
      return `large-change, ${question.complete ? '' : 'more than '}${question.changedFiles} files`;
  }
}
