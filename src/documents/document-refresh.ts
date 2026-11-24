// Spec 7 "`/refresh`" steps 2–4 (SP4, SP5, SPW11, SPW17, SPW22; plan P32, P41): a refresh of one document, the same
// for the Spec and the Plan. The base branch's commit now (B) against the document's starting commit; the changed
// files with the ones it read marked; one call with the four tools at B; the answer cleaned and redacted. It writes
// nothing: the handlers store the outcome with the `/refresh` row in one transaction (plan P28).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
} from '../contracts/issue-provider.js';
import { LlmError } from '../contracts/llm-error.js';
import {
  REPO_PROVIDER,
  type RepoProvider,
} from '../contracts/repo-provider.js';
import type { TaskDocument } from '../generated/prisma/client.js';
import { LlmService } from '../llm/llm.service.js';
import { StepConfigService } from '../llm/step-config.service.js';
import { SecretScanner } from '../secret-scan/secret-scanner.js';
import type { StepContext } from '../workflow/step-handler.registry.js';
import { issueTag } from '../workflow/task.service.js';
import { flaggedFiles } from './commit-check.js';
import { DocumentApprovals } from './document-approval.js';
import { cleanDocument, documentText } from './document-text.js';
import {
  methodChange,
  refreshFrame,
  refreshTurns,
  type RefreshChanges,
  type RefreshKind,
} from './refresh-frame.js';
import { refreshOutputSchema, type RefreshOutput } from './refresh-output.js';

interface Checked {
  /** The document's starting commit (`checkedCommit` or `commit`). */
  from: string;
  /** The base branch's commit now (B). */
  to: string;
}

interface Called extends Checked {
  /** Null when GitHub couldn't compare (plan P32). */
  changed: RefreshChanges | null;
  compareUrl: string | null;
  logId: string;
  notes: string[];
}

export type RefreshCheck =
  /** B is the starting commit: no call. */
  | ({ kind: 'nothing-changed' } & Checked)
  | ({ kind: 'up-to-date' } & Called)
  | ({
      kind: 'changed';
      /** The whole updated document, cleaned and redacted. */
      text: string;
      /** The model's change lines, cleaned and redacted. */
      changes: string[];
    } & Called);

@Injectable()
export class DocumentRefreshes {
  constructor(
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
    @Inject(REPO_PROVIDER) private readonly repo: RepoProvider,
    private readonly stepConfig: StepConfigService,
    private readonly llm: LlmService,
    private readonly scanner: SecretScanner,
    private readonly approvals: DocumentApprovals,
  ) {}

  /**
   * One document's refresh from its text now (SPW17: between the markers; a Plan's refresh also gets the approved
   * Spec). The step's skill and model are read at B, so B is the commit the call reads.
   */
  async check(
    context: StepContext,
    doc: TaskDocument,
    text: string,
    approvedSpec?: TaskDocument,
  ): Promise<RefreshCheck> {
    const { task, run } = context;
    const kind = refreshKind(doc);
    const details = await this.issues.getTaskDetails(task.ref);
    const setup = await this.stepConfig.prepare(kind, details);
    const to = setup.commit;
    const from = doc.checkedCommit ?? doc.commit;
    if (from === null)
      throw new Error(`refresh: ${kind} ${doc.id} has no commit`);
    if (from === to) return { kind: 'nothing-changed', from, to };

    const listed = await this.approvals.changedSince(from, to);
    const changed =
      listed === 'not-compared'
        ? null
        : {
            ...listed,
            // The frame marks the files this document's own calls read.
            read: flaggedFiles(listed.paths, await this.approvals.readsOf(doc))
              .filter(({ readers }) => readers.includes('own'))
              .map(({ path }) => path),
          };
    const result = await this.llm.call<RefreshOutput>({
      context: { task: task.ref, step: kind, lane: run.lane, runId: run.id },
      setup,
      frame: refreshFrame({
        kind,
        from,
        to,
        changes: changed,
        method: methodChange(changed, setup.skill.path),
      }),
      turns: refreshTurns({
        issue: issueTag(task.ref.externalRef),
        title: details.title,
        document: { kind, id: doc.id, version: doc.version, text },
        ...(approvedSpec && {
          approvedSpec: {
            id: approvedSpec.id,
            version: approvedSpec.version,
            approvedBy: approvedSpec.approvedBy ?? 'someone',
            text: approvedSpec.approvedText ?? approvedSpec.text,
          },
        }),
      }),
      output: refreshOutputSchema,
      repoFiles: true,
    });
    const called: Called = {
      from,
      to,
      changed,
      compareUrl: changed ? this.repo.compareUrl(from, to) : null,
      logId: result.logId,
      notes: result.notes,
    };
    const answer = result.output;
    if (answer.upToDate) return { kind: 'up-to-date', ...called };
    const updated = this.clean(answer.document);
    if (updated === '')
      // SP10, as for a written document: only what cleaning removes is no document.
      throw new LlmError(
        `model \`${result.model.name}\` gave no valid answer: the document is empty once cleaned`,
        'permanent',
        'invalid-answer',
      );
    return {
      kind: 'changed',
      ...called,
      text: updated,
      changes: answer.changes
        .map((change) => this.clean(change))
        .filter((change) => change !== ''),
    };
  }

  /**
   * SPW17 with SPW23 and plan P5: the document's comment as it reads now, its text between the markers redacted; or
   * why there is nothing to refresh (gone, or no text left).
   */
  async readNow(
    context: StepContext,
    doc: TaskDocument,
  ): Promise<{ text: string } | { refusal: 'deleted' | 'empty' }> {
    const comment =
      doc.commentId && !doc.deletedAt
        ? await this.issues.getComment(context.task.ref, doc.commentId)
        : null;
    if (!comment) return { refusal: 'deleted' };
    const text = this.scanner.redact(documentText(comment.body)).text;
    return text === '' ? { refusal: 'empty' } : { text };
  }

  /** SPW20 and SPW21: model text is cleaned, then redacted, before it is stored or posted. */
  private clean(text: string): string {
    return this.scanner.redact(cleanDocument(text)).text;
  }
}

function refreshKind(doc: TaskDocument): RefreshKind {
  if (doc.kind !== 'spec' && doc.kind !== 'plan')
    throw new Error(`refresh: a ${doc.kind} has no text to refresh`);
  return doc.kind;
}

/** Plan P35: the `/refresh` results that did nothing; a replayed one ends `IGNORED` again (P34). */
export const REFRESH_REFUSALS = new Set([
  'deleted',
  'empty',
  'already-approved',
]);

/** The `/refresh` row's fields the event gives. */
export function refreshRow(context: StepContext) {
  const { input, run } = context;
  if (input.type !== 'REFRESH')
    throw new Error(`a /refresh row for a ${input.type} event`);
  return {
    id: randomUUID(),
    runId: run.id,
    action: 'refresh' as const,
    sourceCommentId: input.comment.id,
    sender: input.sender,
  };
}
