import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import {
  ISSUE_PROVIDER,
  type AccessLevel,
  type IssueProvider,
} from '../contracts/issue-provider.js';
import type { WorkflowInput } from '../contracts/workflow-input.js';
import type { WebhookEvent } from '../generated/prisma/client.js';
import {
  classifyGitHubEvent,
  senderLoginOf,
  type Needs,
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
        `sender=${senderLoginOf(event.payload) ?? '-'} ${describe(result)}`,
    );
    return result;
  }

  private async decide(event: WebhookEvent): Promise<IntakeResult> {
    const classified = classifyGitHubEvent(event, this.targetRepo, (login) =>
      this.issues.isSelf(login),
    );
    if (classified.outcome === 'ignored') return classified;

    const { input, needs, subject } = classified;
    if (needs === 'self') return accepted(input); // the bot's own PR event

    const level = await this.issues.getAccessLevel(subject, input.sender);
    if (allows(level, needs)) return accepted(input);
    return ignored('unauthorized');
  }
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
