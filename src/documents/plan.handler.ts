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
import type {
  DocumentAction,
  TaskDocument,
} from '../generated/prisma/client.js';
import { LlmService } from '../llm/llm.service.js';
import { StepConfigService } from '../llm/step-config.service.js';
import { SecretScanner } from '../secret-scan/secret-scanner.js';
import type { StepOutcome } from '../workflow/decide.js';
import type {
  StepContext,
  StepHandler,
} from '../workflow/step-handler.registry.js';
import { issueTag } from '../workflow/task.service.js';
import {
  planComment,
  refreshNothingChangedReply,
  refreshRefusedReply,
  refreshUpToDateReply,
} from './document-comments.js';
import { DocumentApprovals } from './document-approval.js';
import {
  APPROVE_ASKED,
  APPROVED,
  APPROVE_REFUSED,
  DocumentPosts,
  REFRESH_REFUSED,
} from './document-posts.js';
import { DocumentRefreshes, REFRESH_REFUSALS } from './document-refresh.js';
import {
  cleanDocument,
  diffBlock,
  DOCUMENT_MAX_CHARS,
} from './document-text.js';
import { DocumentsStore } from './documents.store.js';
import {
  planFrame,
  planTurns,
  type PlanChanges,
  type PlanNotCompared,
} from './plan-frame.js';

@Injectable()
export class PlanHandler implements StepHandler {
  private readonly base: string;

  constructor(
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
    private readonly store: DocumentsStore,
    private readonly stepConfig: StepConfigService,
    private readonly llm: LlmService,
    private readonly scanner: SecretScanner,
    private readonly posts: DocumentPosts,
    private readonly approvals: DocumentApprovals,
    private readonly refreshes: DocumentRefreshes,
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
      case 'refresh':
        return this.refresh(context);
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
   * Row 19 (spec "Approving", spec 14): the waiting Plan becomes the approved snapshot, or the bot asks first. This
   * event already asked (a retried event) → its question posted if it isn't yet (UAW9); its approval already
   * recorded (a retry after a failure in the step that follows, a `/retry` of the `workspace` stop) → nothing more
   * (UAW8, plan UP8).
   */
  private async approve(context: StepContext): Promise<StepOutcome | void> {
    const { run, status, statusBeforeStop, lease } = context;
    if (await this.posts.replayQuestion(context)) return APPROVE_ASKED;
    const waiting = await this.store.waiting(run.id, status, statusBeforeStop);
    if (waiting?.kind !== 'plan')
      throw new Error(`plan approve: no waiting Plan in ${status}`);
    if (waiting.approveEventId === lease.eventId) return APPROVED;
    const result = await this.approvals.approve(context, waiting);
    if (result.kind === 'asked') return APPROVE_ASKED;
    if (result.kind === 'refused') return APPROVE_REFUSED;
    return APPROVED;
  }

  /**
   * Row 32, `plan-review` (spec 13; was `ready-for-dev`), the second call (spec 7 "In `ready-for-dev`, `full-sdd`"): the Spec's call recorded its
   * result on the `/refresh` row (P28); the Plan's comment as it reads now; `main` unmoved since the Plan's starting
   * commit → no call, one reply for both; still right → "both still up to date"; changed → Plan v(M+1). Exactly one
   * comment or reply answers the `/refresh`. An answer already on the row (a retried event) is replayed (P34).
   */
  private async refresh(context: StepContext): Promise<StepOutcome | void> {
    const { input, run, lease } = context;
    if (input.type !== 'REFRESH')
      throw new Error(`plan refresh: a ${input.type} event`);
    const row = await this.store.actionFor('refresh', input.comment.id);
    if (!row) throw new Error('plan refresh: the Spec step recorded nothing');
    if (row.replyBody !== null || row.result === 'plan-changed') {
      await this.posts.postReply(context, row);
      return REFRESH_REFUSALS.has(row.result) ? REFRESH_REFUSED : undefined;
    }
    const plan = await this.store.waiting(run.id, 'plan-review', null);
    const spec = await this.store.current(run.id, 'spec');
    if (plan?.kind !== 'plan' || !spec?.approvedAt)
      throw new Error('plan refresh: no waiting Plan with an approved Spec');
    const now = await this.refreshes.readNow(context, plan);
    if ('refusal' in now) {
      // Gone or emptied since the Spec's call looked, a moment ago: the same reply as there.
      if (now.refusal === 'deleted' && !plan.deletedAt)
        await this.store.recordMissedDeletion(lease, plan.id);
      await this.answer(
        context,
        row,
        {
          result: now.refusal,
          documentId: plan.id,
          logIds: row.logIds,
          replyBody: refreshRefusedReply(input.comment, now.refusal, {
            kind: 'plan',
            version: plan.version,
          }),
        },
        `/refresh refused (${now.refusal})`,
      );
      return REFRESH_REFUSED;
    }

    const check = await this.refreshes.check(context, plan, now.text, spec);
    const documents = [
      { kind: 'spec' as const, version: spec.version },
      { kind: 'plan' as const, version: plan.version },
    ];
    switch (check.kind) {
      case 'nothing-changed':
        // The Plan was written (or last found up to date) at B: no call; the reply speaks for both.
        await this.answer(
          context,
          row,
          {
            result: row.result,
            documentId: plan.id,
            logIds: row.logIds,
            replyBody:
              row.result === 'nothing-changed'
                ? refreshNothingChangedReply(input.comment, {
                    documents,
                    base: this.base,
                    commit: check.to,
                    checked:
                      spec.checkedCommit !== null ||
                      plan.checkedCommit !== null,
                  })
                : refreshUpToDateReply(
                    input.comment,
                    this.base,
                    check.to,
                    {
                      kind: 'plan-at-commit',
                      spec: spec.version,
                      plan: plan.version,
                    },
                    [],
                  ),
          },
          row.result === 'nothing-changed'
            ? '/refresh → nothing changed'
            : '/refresh → up to date',
        );
        return;
      case 'up-to-date':
        await this.answer(
          context,
          row,
          {
            result: 'up-to-date',
            documentId: plan.id,
            logIds: [...row.logIds, check.logId],
            replyBody: refreshUpToDateReply(
              input.comment,
              this.base,
              check.to,
              { kind: 'both', spec: spec.version, plan: plan.version },
              check.notes,
            ),
          },
          '/refresh → up to date',
          { id: plan.id, commit: check.to },
        );
        return;
      case 'changed': {
        const versionId = randomUUID();
        const version = await this.store.nextVersion(run.id, 'plan');
        const { version: made } = await this.store.finishRefresh(
          lease,
          row.id,
          {
            result: 'plan-changed',
            documentId: versionId,
            logIds: [...row.logIds, check.logId],
            replyBody: null,
          },
          {
            version: {
              id: versionId,
              runId: run.id,
              kind: 'plan',
              version,
              origin: 'refreshed',
              basedOnId: plan.id,
              commit: check.to,
              logId: check.logId,
              text: check.text,
              changes: check.changes,
              notes: check.notes,
              triggerCommentId: input.comment.id,
              body: planComment({
                versionId,
                version,
                run: { number: run.number },
                base: this.base,
                commit: check.to,
                specVersion: spec.version,
                text: check.text,
                notes: check.notes,
                origin: {
                  kind: 'refreshed',
                  previous: { version: plan.version, from: check.from },
                  compareUrl: check.compareUrl,
                  by: input.sender,
                  command: input.comment,
                  changes: check.changes,
                  diff: diffBlock(now.text, check.text),
                },
              }),
            },
          },
        );
        this.posts.log(context, `/refresh → plan v${version}`);
        if (made) await this.posts.postVersion(context, made);
        return;
      }
    }
  }

  /** The Plan's answer on the `/refresh` row (and its "checked" mark), then its reply posted once. */
  private async answer(
    context: StepContext,
    row: DocumentAction,
    answer: {
      result: string;
      documentId: string;
      logIds: string[];
      replyBody: string;
    },
    logLine: string,
    checked?: { id: string; commit: string },
  ): Promise<void> {
    const { action } = await this.store.finishRefresh(
      context.lease,
      row.id,
      answer,
      {
        ...(checked && { checked }),
      },
    );
    this.posts.log(context, logLine);
    await this.posts.postReply(context, action);
  }

  /** A Plan stored by Tx1 but not posted (a crash before Tx2): find its marker, else post its body; then Tx2. */
  private async postPending(context: StepContext): Promise<void> {
    const pending = await this.store.pendingVersion(context.run.id);
    if (pending?.kind !== 'plan') return;
    await this.posts.postVersion(context, pending);
    this.posts.log(context, `v${pending.version} posted (recovered)`, 'plan');
  }
}

/**
 * Plan P33: the paths the Spec's approval stored, the ones it read marked; none changed → no paragraph. Spec 14: the
 * range starts at `approved_from_commit` (a later refresh may move `checked_commit`; an approval stored before
 * spec 14 has none: `checked_commit ?? commit`, plan UP10); an approval that couldn't compare → not compared (UAW3).
 */
function changesOf(spec: TaskDocument): PlanChanges | PlanNotCompared | null {
  const from = spec.approvedFromCommit ?? spec.checkedCommit ?? spec.commit;
  if (!from) return null;
  if (spec.changedComplete === null)
    return spec.approvedCommit && from !== spec.approvedCommit
      ? { specCommit: from, notCompared: true }
      : null;
  if (spec.changedPaths.length === 0) return null;
  return {
    specCommit: from,
    paths: spec.changedPaths,
    read: spec.staleFiles,
    complete: spec.changedComplete ?? true,
  };
}
