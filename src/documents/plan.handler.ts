// Spec 7 "Writing the Plan" (SP1): the `plan` handler of spec 5's step-handler registry (`full-sdd` only). Every op
// first finishes what a crash left (a Plan stored by Tx1 but not posted), then does its own work.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
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
import type { StepOutcome } from '../workflow/decide.js';
import type {
  StepContext,
  StepHandler,
} from '../workflow/step-handler.registry.js';
import { issueTag } from '../workflow/task.service.js';
import { planComment, type SpecWarning } from './document-comments.js';
import { DocumentApprovals } from './document-approval.js';
import { APPROVE_REFUSED, DocumentPosts } from './document-posts.js';
import { cleanDocument, DOCUMENT_MAX_CHARS } from './document-text.js';
import { DocumentsStore } from './documents.store.js';
import { planFrame, planTurns, type PlanChanges } from './plan-frame.js';

@Injectable()
export class PlanHandler implements StepHandler {
  private readonly base: string;

  constructor(
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
    @Inject(REPO_PROVIDER) private readonly repo: RepoProvider,
    private readonly store: DocumentsStore,
    private readonly stepConfig: StepConfigService,
    private readonly llm: LlmService,
    private readonly scanner: SecretScanner,
    private readonly posts: DocumentPosts,
    private readonly approvals: DocumentApprovals,
    config: ConfigService<Env, true>,
  ) {
    this.base = config.get('TARGET_BASE_BRANCH', { infer: true });
  }

  async run(context: StepContext): Promise<StepOutcome | void> {
    await this.postPending(context);
    switch (context.op) {
      case 'generate':
        return this.generate(context);
      case 'approve':
        return this.approve(context);
      default:
        throw new Error(`plan: no ${context.op} op`);
    }
  }

  /**
   * Row 17, in the job of the Spec's approval: the Plan of the approved Spec, once. A Plan written from it already
   * (posted, or just posted by the recovery above) → nothing, no model call. Else: the skill and the model at one
   * base-branch commit, one call with the title and the approved Spec only (SP1); cleaned, redacted; Tx1, post, Tx2.
   */
  private async generate(context: StepContext): Promise<void> {
    const { task, run } = context;
    const spec = await this.store.current(run.id, 'spec');
    if (!spec?.approvedAt || spec.approvedText === null || !spec.approvedBy)
      throw new Error('plan generate: the run has no approved Spec');
    if (await this.store.writtenFrom(run.id, 'plan', spec.id)) return;
    const details = await this.issues.getTaskDetails(task.ref);
    const setup = await this.stepConfig.prepare('plan', details);
    const result = await this.llm.call<string>({
      context: { task: task.ref, step: 'plan', lane: run.lane, runId: run.id },
      setup,
      frame: planFrame({ commit: setup.commit, changes: changesOf(spec) }),
      turns: planTurns({
        issue: issueTag(task.ref.externalRef),
        title: details.title,
        spec: {
          id: spec.id,
          version: spec.version,
          approvedBy: spec.approvedBy,
          text: spec.approvedText,
        },
      }),
      output: { text: { maxChars: DOCUMENT_MAX_CHARS } },
      repoFiles: true,
    });
    const text = this.scanner.redact(cleanDocument(result.output)).text;
    if (text === '') {
      throw new LlmError(
        `model \`${result.model.name}\` gave no valid answer: the answer is empty once cleaned`,
        'permanent',
        'invalid-answer',
      );
    }
    const versionId = randomUUID();
    const version = await this.store.nextVersion(run.id, 'plan');
    const row = await this.store.insertVersion(context.lease, {
      id: versionId,
      runId: run.id,
      kind: 'plan',
      version,
      origin: 'written',
      basedOnId: spec.id,
      commit: setup.commit,
      logId: result.logId,
      text,
      notes: result.notes,
      body: planComment({
        versionId,
        version,
        run: { number: run.number },
        base: this.base,
        commit: setup.commit,
        specVersion: spec.version,
        warning: this.warningOf(spec),
        text,
        notes: result.notes,
      }),
    });
    this.posts.log(
      context,
      `v${version} written (${setup.commit.slice(0, 7)})`,
      'plan',
    );
    await this.posts.postVersion(context, row);
  }

  /**
   * Row 19 (spec "Approving", SPW13): the waiting Plan becomes the approved snapshot; it is the last document before
   * code, so files it or the approved Spec read that changed since it was written get one warning reply. This
   * event's approval already recorded (a `/retry` of the `workspace` stop) → only a warning still to post.
   */
  private async approve(context: StepContext): Promise<StepOutcome | void> {
    const { run, status, statusBeforeStop, lease } = context;
    const waiting = await this.store.waiting(run.id, status, statusBeforeStop);
    if (waiting?.kind !== 'plan')
      throw new Error(`plan approve: no waiting Plan in ${status}`);
    if (waiting.approveEventId === lease.eventId)
      return this.approvals.postPendingWarning(context);
    const approved = await this.approvals.approve(context, waiting, {
      last: true,
    });
    if (!approved) return APPROVE_REFUSED;
  }

  /** SP3: the Spec's approval flagged files (with GitHub's compare link), or couldn't compare; else no line. */
  private warningOf(spec: TaskDocument): SpecWarning | null {
    const from = spec.checkedCommit ?? spec.commit;
    if (!from || !spec.approvedCommit || from === spec.approvedCommit)
      return null;
    if (spec.changedComplete === null) return { kind: 'not-compared', from };
    if (spec.staleFiles.length === 0) return null;
    return {
      kind: 'stale',
      from,
      files: spec.staleFiles,
      complete: spec.changedComplete,
      compareUrl: this.repo.compareUrl(from, spec.approvedCommit),
    };
  }

  /** A Plan stored by Tx1 but not posted (a crash before Tx2): find its marker, else post its body; then Tx2. */
  private async postPending(context: StepContext): Promise<void> {
    const pending = await this.store.pendingVersion(context.run.id);
    if (pending?.kind !== 'plan') return;
    await this.posts.postVersion(context, pending);
    this.posts.log(context, `v${pending.version} posted (recovered)`, 'plan');
  }
}

/** Plan P33: the paths the Spec's approval stored, the ones it read marked; none changed → no paragraph. */
function changesOf(spec: TaskDocument): PlanChanges | null {
  const from = spec.checkedCommit ?? spec.commit;
  if (!from || spec.changedPaths.length === 0) return null;
  return {
    specCommit: from,
    paths: spec.changedPaths,
    read: spec.staleFiles,
    complete: spec.changedComplete ?? true,
  };
}
