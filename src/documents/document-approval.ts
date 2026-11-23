// Spec 7 "Approving" (SP3, SPW5, SPW14, SPW21, SPW22; plan P4, P16, P20, P32, P33): an `/approve` the gate found
// valid becomes the approved snapshot. The comment is read again, its text between the markers redacted; the base
// branch is compared with the commit the document read; the edits are counted; one transaction stores all of it.
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
  type ChainVersion,
  type FlaggedFile,
} from './commit-check.js';
import {
  approveWarningReply,
  type ApproveWarning,
} from './document-comments.js';
import { DocumentPosts } from './document-posts.js';
import { documentText, lineCounts } from './document-text.js';
import { DocumentsStore } from './documents.store.js';

/** What an approval found: the stored row, the files it flagged (with who read them), whether it compared. */
export interface Approved {
  row: TaskDocument;
  flagged: FlaggedFile[];
  /** False when GitHub couldn't compare the two commits (SPW22). */
  compared: boolean;
}

@Injectable()
export class DocumentApprovals {
  private readonly base: string;

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
  }

  /**
   * Steps 1–4 for the waiting document. Plan P16: the comment is read again and that text is approved; gone or empty
   * since the gate read it → the refusal reply and null (nothing approved, the next step isn't called). `last`: the
   * last document before code (`spec-code`'s Spec, `full-sdd`'s Plan), whose approval gets SPW13's warning reply
   * when files it read changed or the comparison failed.
   */
  async approve(
    context: StepContext,
    doc: TaskDocument,
    { last }: { last: boolean },
  ): Promise<Approved | null> {
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
      return null;
    }

    // Step 2: the commit check (SP3), from where the document was last found up to date (SPW11).
    const now = await this.repo.resolveRef(this.base);
    const from = doc.checkedCommit ?? doc.commit;
    if (from === null)
      throw new Error(`approval: ${doc.kind} ${doc.id} has no commit`);
    const changed = from === now ? null : await this.changed(from, now);
    const flagged =
      changed === null || changed === 'not-compared'
        ? []
        : flaggedFiles(changed.paths, await this.readsOf(doc));
    const compared = changed !== 'not-compared';
    const listed =
      changed === null || changed === 'not-compared' ? null : changed;

    const warning: ApproveWarning | null = !last
      ? null
      : !compared
        ? { kind: 'not-compared', from }
        : flagged.length > 0
          ? {
              kind: 'stale',
              from,
              flagged,
              complete: listed?.complete ?? true,
              compareUrl: this.repo.compareUrl(from, now),
            }
          : null;
    const { linesAdded, linesRemoved } = lineCounts(doc.text, text);
    const { row, warning: reply } = await this.store.approve(
      lease,
      doc.id,
      {
        approvedText: text,
        approvedBy: input.sender,
        approveCommentId: input.comment.id,
        approvedCommit: now,
        staleFiles: flagged.map(({ path }) => path),
        changedFiles: listed?.paths.length ?? null,
        changedPaths: listed?.paths ?? [],
        changedComplete: listed?.complete ?? null,
        linesAdded,
        linesRemoved,
      },
      warning && {
        id: randomUUID(),
        runId: context.run.id,
        documentId: doc.id,
        action: 'approve-warning',
        result: warning.kind,
        sourceCommentId: input.comment.id,
        sender: input.sender,
        replyBody: approveWarningReply({
          versionId: doc.id,
          approve: input.comment,
          document: { kind: doc.kind as 'spec' | 'plan', version: doc.version },
          lane: context.run.lane,
          base: this.base,
          warning,
        }),
      },
    );
    const files = compared
      ? `${flagged.length} file${flagged.length === 1 ? '' : 's'} flagged`
      : 'not compared';
    this.posts.log(
      context,
      `v${doc.version} approved by ${input.sender} (${files}, +${linesAdded} −${linesRemoved} lines)`,
      doc.kind,
    );
    if (reply) await this.posts.postReply(context, reply);
    return { row, flagged, compared };
  }

  /** SPW13: a warning reply this event stored and didn't post (a crash, then the event again): posted once now. */
  async postPendingWarning(context: StepContext): Promise<void> {
    if (context.input.type !== 'APPROVE') return;
    const warning = await this.store.actionFor(
      'approve-warning',
      context.input.comment.id,
    );
    if (warning) await this.posts.postReply(context, warning);
  }

  /**
   * Plan P4: what the document's calls read, and every version it is based on (`basedOnId`, back to the first
   * writer; a Plan's chain goes on into its approved Spec's), each with who read it.
   */
  async readsOf(doc: TaskDocument): Promise<ReturnType<typeof chainReads>> {
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

  /** Plan P32: only GitHub's "unknown commit" (404, 422) counts as not compared; any other error passes through. */
  private async changed(
    from: string,
    to: string,
  ): Promise<{ paths: string[]; complete: boolean } | 'not-compared'> {
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
