import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import {
  ISSUE_PROVIDER,
  type AccessLevel,
  type IssueProvider,
  type TaskRef,
} from '../contracts/issue-provider.js';
import type { WorkflowInput } from '../contracts/workflow-input.js';
import type { WebhookEvent } from '../generated/prisma/client.js';
import {
  classifyGitHubEvent,
  senderLoginOf,
  type Needs,
  type Revert,
} from './github-payload.js';
import type { IgnoreReason } from './ignore-reason.js';

/** Spec 2 "Intake's own interface": what spec 5's processor consumes. */
export type IntakeResult =
  | { outcome: 'accepted'; input: WorkflowInput }
  | { outcome: 'ignored'; reason: IgnoreReason };

/**
 * Spec 2: classify (payload only) → authorize (at most one lookup) → result. Catches nothing: a
 * ProviderError goes to the worker's rule, so a failed lookup is never read as an answer (IA9).
 */
@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);
  private readonly targetRepo: string;

  constructor(
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
    config: ConfigService<Env, true>,
  ) {
    this.targetRepo = config.get('TARGET_REPO', { infer: true });
  }

  async intake(event: WebhookEvent): Promise<IntakeResult> {
    const result = await this.decide(event);
    this.logger.log(
      `delivery=${event.deliveryId} event=${event.eventName} action=${event.action ?? '-'} ` +
        `sender=${senderLoginOf(event) ?? '-'} ${describe(result)}`,
    );
    return result;
  }

  private async decide(event: WebhookEvent): Promise<IntakeResult> {
    const classified = classifyGitHubEvent(event, this.targetRepo, (login) =>
      this.issues.isSelf(login),
    );
    if (classified.outcome === 'ignored') return classified;

    const { input, needs, subject, revert } = classified;
    if (needs === 'self') return accepted(input); // the bot's own PR event

    const level = await this.issues.getAccessLevel(subject, input.sender);
    if (allows(level, needs)) return accepted(input);
    if (revert && level === 'none')
      return this.revertLabel(subject, revert, input.sender);
    if (input.type === 'APPROVE' && level === 'participant')
      return this.denyApprove(input.task, input.comment.id, input.sender);
    return ignored('unauthorized');
  }

  /** Spec 2 "`/approve` reply" (IA4): one reply per `/approve` comment, guarded by its marker. */
  private async denyApprove(
    task: TaskRef,
    commentId: string,
    sender: string,
  ): Promise<IntakeResult> {
    const marker = approveDeniedMarker(commentId);
    if (!(await this.issues.findCommentByMarker(task, marker))) {
      await this.issues.postComment(
        task,
        approveDeniedComment(commentId, sender),
      );
    }
    return ignored('approve-denied');
  }

  /**
   * Spec 2 "Label revert" (IA7): remove the label every time; post the comment once per issue and label.
   * A retry is safe: removing a label already gone succeeds, and the marker search stops a second comment.
   */
  private async revertLabel(
    task: TaskRef,
    revert: Revert,
    sender: string,
  ): Promise<IntakeResult> {
    await this.issues.removeLabel(task, revert.label);
    const marker = labelRevertMarker(revert.key);
    if (!(await this.issues.findCommentByMarker(task, marker))) {
      await this.issues.postComment(task, labelRevertComment(revert, sender));
    }
    return ignored('label-reverted');
  }
}

export function labelRevertMarker(key: string): string {
  return `<!-- sdd-agent:label-revert:${key} -->`;
}

/** Fixed text, a validated login and a known label name (AW7). The login has no `@`: nobody is notified (IA11). */
export function labelRevertComment(revert: Revert, login: string): string {
  return (
    `${labelRevertMarker(revert.key)}\n` +
    `The \`${revert.label}\` label was removed. It was added by \`${login}\`, who is not allowed to start or ` +
    'change a workflow on this repository (on GitHub that needs the Triage role or higher).'
  );
}

export function approveDeniedMarker(commentId: string): string {
  return `<!-- sdd-agent:approve-denied:${commentId} -->`;
}

/** Fixed text and a validated login (AW7); it mentions the user, who did ask for something (IA11). */
export function approveDeniedComment(commentId: string, login: string): string {
  return (
    `${approveDeniedMarker(commentId)}\n` +
    `@${login} \`/approve\` needs write access to this repository, so nothing was approved. ` +
    'Ask someone with write access to comment `/approve`.'
  );
}

function allows(level: AccessLevel, needs: Exclude<Needs, 'self'>): boolean {
  return needs === 'participant' ? level !== 'none' : level === 'approver';
}

function accepted(input: WorkflowInput): IntakeResult {
  return { outcome: 'accepted', input };
}

function ignored(reason: IgnoreReason): IntakeResult {
  return { outcome: 'ignored', reason };
}

/** `accepted <TYPE> [lane] <issue or PR>` or `ignored <reason>`. Never a comment's text. */
function describe(result: IntakeResult): string {
  if (result.outcome === 'ignored') return `ignored ${result.reason}`;
  const { input } = result;
  switch (input.type) {
    case 'LANE_ADDED':
    case 'LANE_REMOVED':
      return `accepted ${input.type} ${input.lane} ${input.task.externalRef}`;
    case 'PR_UPDATED':
      return `accepted PR_UPDATED ${input.pr.repo}#${input.pr.number} ${input.headSha}`;
    default:
      return `accepted ${input.type} ${input.task.externalRef}`;
  }
}
