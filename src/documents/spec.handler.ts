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
import { specComment, specMarker } from './document-comments.js';
import { cleanDocument, DOCUMENT_MAX_CHARS } from './document-text.js';
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
    config: ConfigService<Env, true>,
  ) {
    this.base = config.get('TARGET_BASE_BRANCH', { infer: true });
  }

  async run(context: StepContext): Promise<StepOutcome | void> {
    await this.postPending(context);
    switch (context.op) {
      case 'generate':
        return this.generate(context);
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
    await this.post(context, row);
  }

  /** A Spec stored by Tx1 but not posted (a crash before Tx2): find its marker, else post its body; then Tx2. */
  private async postPending(context: StepContext): Promise<void> {
    const pending = await this.store.pendingVersion(context.run.id);
    if (pending?.kind !== 'spec') return;
    await this.post(context, pending);
    this.log(context, `v${pending.version} posted (recovered)`);
  }

  private async post(context: StepContext, row: TaskDocument): Promise<void> {
    const { ref } = context.task;
    const comment =
      (await this.issues.findCommentByMarker(ref, specMarker(row.id))) ??
      (await this.issues.postComment(ref, row.body));
    await this.store.markPosted(context.lease, row.id, {
      commentId: comment.id,
      commentUrl: comment.url,
      postedAt: comment.createdAt,
    });
  }

  private log(context: StepContext, message: string): void {
    this.logger.log(
      `${issueTag(context.task.ref.externalRef)} run ${context.run.number} spec: ${message}`,
    );
  }
}

/** A Spec is written only in `full-sdd` and `spec-code` (overview §3 rows 10, 13, 16). */
function documentLane(lane: Lane): Exclude<Lane, 'code-only'> {
  if (lane === 'code-only')
    throw new Error('spec: a code-only run has no Spec');
  return lane;
}
