// Spec 7 "Writing the Spec": the `spec` handler of spec 5's step-handler registry. Every op first finishes what a
// crash left (a version stored by Tx1 but not posted), then does its own work.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
  type Lane,
} from '../contracts/issue-provider.js';
import { LlmError } from '../contracts/llm-error.js';
import type { TaskComment } from '../contracts/workflow-input.js';
import type { TaskDocument } from '../generated/prisma/client.js';
import { GrillService } from '../grill/grill.service.js';
import { LlmService } from '../llm/llm.service.js';
import { StepConfigService } from '../llm/step-config.service.js';
import { SecretScanner } from '../secret-scan/secret-scanner.js';
import type { StepOutcome } from '../workflow/decide.js';
import type {
  StepContext,
  StepHandler,
} from '../workflow/step-handler.registry.js';
import { issueTag } from '../workflow/task.service.js';
import { DocumentApprovals } from './document-approval.js';
import {
  refreshNothingChangedReply,
  refreshUpToDateReply,
  specComment,
} from './document-comments.js';
import {
  APPROVE_ASKED,
  APPROVED,
  APPROVE_REFUSED,
  DocumentPosts,
  REFRESH_REFUSED,
} from './document-posts.js';
import {
  DocumentRefreshes,
  REFRESH_REFUSALS,
  refreshRow,
  type RefreshCheck,
} from './document-refresh.js';
import {
  cleanDocument,
  diffBlock,
  DOCUMENT_MAX_CHARS,
} from './document-text.js';
import { DocumentsStore } from './documents.store.js';
import { specFrame, specTurns } from './spec-frame.js';

@Injectable()
export class SpecHandler implements StepHandler {
  private readonly logger = new Logger(SpecHandler.name);
  private readonly base: string;

  constructor(
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
    private readonly store: DocumentsStore,
    private readonly stepConfig: StepConfigService,
    private readonly llm: LlmService,
    private readonly grill: GrillService,
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
        throw new Error(`spec: no ${context.op} op`);
    }
  }

  /**
   * Rows 10, 13, 16: the run's first Spec, once. A Spec already stored for the run (posted, or just posted by the
   * recovery above) → nothing, no model call. Else: the issue as it is now, the skill and the model at one
   * base-branch commit, Grill Me's transcript, one call; the text cleaned (SPW20) and redacted (L17); Tx1, post, Tx2.
   * The router then sets `spec-review`.
   */
  private async generate(context: StepContext): Promise<void> {
    const { task, run } = context;
    if (await this.store.current(run.id, 'spec')) return;
    const lane = documentLane(run.lane);
    const details = await this.issues.getTaskDetails(task.ref);
    const setup = await this.stepConfig.prepare('spec', details);
    const result = await this.llm.call<string>({
      context: { task: task.ref, step: 'spec', lane, runId: run.id },
      setup,
      frame: specFrame({ lane, commit: setup.commit }),
      turns: specTurns({
        issue: issueTag(task.ref.externalRef),
        title: details.title,
        description: details.description,
        grill: await this.grill.transcript(run.id),
      }),
      output: { text: { maxChars: DOCUMENT_MAX_CHARS } },
      repoFiles: true,
    });
    const text = this.scanner.redact(cleanDocument(result.output)).text;
    if (text === '') {
      // SP10: the model wrote only what cleaning removes (hidden markers); nothing to post.
      throw new LlmError(
        `model \`${result.model.name}\` gave no valid answer: the answer is empty once cleaned`,
        'permanent',
        'invalid-answer',
      );
    }
    const versionId = randomUUID();
    const row = await this.store.insertVersion(context.lease, {
      id: versionId,
      runId: run.id,
      kind: 'spec',
      version: 1,
      origin: 'written',
      commit: setup.commit,
      logId: result.logId,
      text,
      notes: result.notes,
      body: specComment({
        versionId,
        version: 1,
        run: { number: run.number, lane },
        base: this.base,
        commit: setup.commit,
        text,
        notes: result.notes,
      }),
    });
    this.log(
      context,
      `v1 written (${setup.commit.slice(0, 7)}, ${text.length.toLocaleString('en-US')} characters)`,
    );
    await this.posts.postVersion(context, row);
  }

  /**
   * Rows 17, 18 (spec "Approving", spec 14): the waiting Spec becomes the approved snapshot, or the bot asks first. This
   * event already asked (a retried event) → its question posted if it isn't yet (UAW9); its approval already
   * recorded (a retry after a failure in the step that follows, a `/retry` of the `workspace` stop) → nothing more
   * (UAW8, plan UP8).
   */
  private async approve(context: StepContext): Promise<StepOutcome | void> {
    const { run, status, statusBeforeStop, lease } = context;
    if (await this.posts.replayQuestion(context)) return APPROVE_ASKED;
    const waiting = await this.store.waiting(run.id, status, statusBeforeStop);
    if (waiting?.kind !== 'spec')
      throw new Error(`spec approve: no waiting Spec in ${status}`);
    if (waiting.approveEventId === lease.eventId) return APPROVED;
    const result = await this.approvals.approve(context, waiting);
    if (result.kind === 'asked') return APPROVE_ASKED;
    if (result.kind === 'refused') return APPROVE_REFUSED;
    return APPROVED;
  }

  /**
   * Row 32 (spec "`/refresh`"): in `spec-review` the waiting Spec; in `plan-review` (spec 13; was `ready-for-dev`)
   * the approved Spec, first of the two calls. Plan P34: a `/refresh` already answered (a retried event) replays its row, so the model is never asked
   * twice for a step that already answered (P28).
   */
  private async refresh(context: StepContext): Promise<StepOutcome | void> {
    const { input, status } = context;
    if (input.type !== 'REFRESH')
      throw new Error(`spec refresh: a ${input.type} event`);
    const recorded = await this.store.actionFor('refresh', input.comment.id);
    if (recorded) {
      await this.posts.postReply(context, recorded);
      if (REFRESH_REFUSALS.has(recorded.result)) return REFRESH_REFUSED;
      if (recorded.result === 'spec-changed')
        return this.refreshedOutcome(recorded.documentId);
      return;
    }
    switch (status) {
      case 'spec-review':
        return this.refreshWaiting(context, input.comment);
      case 'plan-review':
        return this.refreshApproved(context);
      default:
        throw new Error(`spec refresh in ${status}`);
    }
  }

  /**
   * Steps 1–6 in `spec-review`: the waiting Spec's comment as it reads now; approved, deleted or empty → one reply;
   * `main` unmoved → one reply, no call; else the call: up to date → its starting point moves to B (SPW11) and one
   * reply; changed → Spec v(N+1).
   */
  private async refreshWaiting(
    context: StepContext,
    comment: TaskComment,
  ): Promise<StepOutcome | void> {
    const { run, status, statusBeforeStop, lease } = context;
    const waiting = await this.store.waiting(run.id, status, statusBeforeStop);
    if (waiting?.kind !== 'spec')
      throw new Error(`spec refresh: no waiting Spec in ${status}`);
    if (waiting.approvedAt)
      return this.posts.refuseRefresh(context, 'already-approved', waiting);
    const now = await this.refreshes.readNow(context, waiting);
    if ('refusal' in now)
      return this.posts.refuseRefresh(context, now.refusal, waiting);

    const check = await this.refreshes.check(context, waiting, now.text);
    switch (check.kind) {
      case 'nothing-changed':
        await this.posts.answer(
          context,
          {
            documentId: waiting.id,
            action: 'refresh',
            result: 'nothing-changed',
            replyBody: refreshNothingChangedReply(comment, {
              documents: [{ kind: 'spec', version: waiting.version }],
              base: this.base,
              commit: check.to,
              checked: waiting.checkedCommit !== null,
            }),
          },
          '/refresh → nothing changed',
        );
        return;
      case 'up-to-date': {
        const row = await this.store.markUpToDate(lease, waiting.id, check.to, {
          ...refreshRow(context),
          documentId: waiting.id,
          result: 'up-to-date',
          logIds: [check.logId],
          replyBody: refreshUpToDateReply(
            comment,
            this.base,
            check.to,
            {
              kind: 'spec',
              spec: waiting.version,
              from: check.from,
              changed: check.changed && {
                files: check.changed.paths.length,
                complete: check.changed.complete,
                compareUrl: check.compareUrl ?? '',
              },
            },
            check.notes,
          ),
        });
        this.posts.log(context, '/refresh → up to date');
        await this.posts.postReply(context, row);
        return;
      }
      case 'changed':
        await this.postRefreshed(context, waiting, now.text, check, null);
    }
  }

  /**
   * `plan-review` (spec 13; was `ready-for-dev`, `full-sdd`: the Plan waits), the Spec's call: the waiting Plan deleted, empty or approved → one
   * reply and nothing more, before any model call (P35 stops the list). Then from the approved text (SPW17):
   * `main` unmoved or still right → recorded on the row for the Plan's call, nothing posted; changed → Spec v(K+1),
   * which supersedes the approved one and the waiting Plan (SPW8), and `SPEC_REFRESHED` sends the issue back to
   * `spec-review`.
   */
  private async refreshApproved(
    context: StepContext,
  ): Promise<StepOutcome | void> {
    const { run, lease } = context;
    const plan = await this.store.waiting(run.id, 'plan-review', null);
    if (plan?.kind !== 'plan')
      throw new Error('spec refresh: no waiting Plan in plan-review');
    if (plan.approvedAt)
      return this.posts.refuseRefresh(context, 'already-approved', plan);
    const planNow = await this.refreshes.readNow(context, plan);
    if ('refusal' in planNow)
      return this.posts.refuseRefresh(context, planNow.refusal, plan);
    const spec = await this.store.current(run.id, 'spec');
    if (!spec?.approvedAt || spec.approvedText === null)
      throw new Error('spec refresh: the Plan waits without an approved Spec');

    const check = await this.refreshes.check(context, spec, spec.approvedText);
    switch (check.kind) {
      case 'nothing-changed':
        await this.store.insertAction(lease, {
          ...refreshRow(context),
          documentId: spec.id,
          result: 'nothing-changed',
          logIds: [],
          replyBody: null,
        });
        return;
      case 'up-to-date':
        await this.store.markUpToDate(lease, spec.id, check.to, {
          ...refreshRow(context),
          documentId: spec.id,
          result: 'up-to-date',
          logIds: [check.logId],
          replyBody: null,
        });
        return;
      case 'changed':
        await this.postRefreshed(
          context,
          spec,
          spec.approvedText,
          check,
          plan.version,
        );
        return SPEC_REFRESHED;
    }
  }

  /** Step 6: Spec v(N+1), `refreshed`, with its `/refresh` row in one transaction (P28); then posted once. */
  private async postRefreshed(
    context: StepContext,
    replaced: TaskDocument,
    before: string,
    check: Extract<RefreshCheck, { kind: 'changed' }>,
    planNoLongerCounts: number | null,
  ): Promise<void> {
    const { run, input, lease } = context;
    if (input.type !== 'REFRESH')
      throw new Error(`spec refresh: a ${input.type} event`);
    const lane = documentLane(run.lane);
    const versionId = randomUUID();
    const version = await this.store.nextVersion(run.id, 'spec');
    const row = await this.store.insertVersion(
      lease,
      {
        id: versionId,
        runId: run.id,
        kind: 'spec',
        version,
        origin: 'refreshed',
        basedOnId: replaced.id,
        commit: check.to,
        logId: check.logId,
        text: check.text,
        changes: check.changes,
        notes: check.notes,
        triggerCommentId: input.comment.id,
        body: specComment({
          versionId,
          version,
          run: { number: run.number, lane },
          base: this.base,
          commit: check.to,
          text: check.text,
          notes: check.notes,
          origin: {
            kind: 'refreshed',
            previous: { version: replaced.version, from: check.from },
            compareUrl: check.compareUrl,
            by: input.sender,
            command: input.comment,
            changes: check.changes,
            diff: diffBlock(before, check.text),
          },
          ...(planNoLongerCounts !== null && { planNoLongerCounts }),
        }),
      },
      {
        ...refreshRow(context),
        documentId: versionId,
        result: 'spec-changed',
        logIds: [check.logId],
        replyBody: null,
      },
    );
    this.posts.log(context, `/refresh → spec v${version}`);
    await this.posts.postVersion(context, row);
  }

  /**
   * Plan P34: a replayed `spec-changed` sends the issue back to `spec-review` when the Spec it replaced was approved
   * (the Plan waited), as the first answer did; in `spec-review` it changes nothing.
   */
  private async refreshedOutcome(
    versionId: string | null,
  ): Promise<StepOutcome | void> {
    const made = versionId ? await this.store.byId(versionId) : null;
    const replaced = made?.basedOnId
      ? await this.store.byId(made.basedOnId)
      : null;
    return replaced?.approvedAt ? SPEC_REFRESHED : undefined;
  }

  /** A Spec stored by Tx1 but not posted (a crash before Tx2): find its marker, else post its body; then Tx2. */
  private async postPending(context: StepContext): Promise<void> {
    const pending = await this.store.pendingVersion(context.run.id);
    if (pending?.kind !== 'spec') return;
    await this.posts.postVersion(context, pending);
    this.log(context, `v${pending.version} posted (recovered)`);
  }

  private log(context: StepContext, message: string): void {
    this.logger.log(
      `${issueTag(context.task.ref.externalRef)} run ${context.run.number} spec: ${message}`,
    );
  }
}

const SPEC_REFRESHED: StepOutcome = { type: 'SPEC_REFRESHED' };

/** A Spec is written only in `full-sdd` and `spec-code` (overview §3 rows 10, 13, 16). */
function documentLane(lane: Lane): Exclude<Lane, 'code-only'> {
  if (lane === 'code-only')
    throw new Error('spec: a code-only run has no Spec');
  return lane;
}
