import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
} from '../contracts/issue-provider.js';
import type { WebhookEvent } from '../generated/prisma/client.js';

export type ProcessResult =
  { status: 'DONE' } | { status: 'IGNORED'; reason: string };

/** The fields of an `issues.opened` payload the hello comment needs. */
interface IssuesOpenedPayload {
  repository: { full_name: string };
  issue: { id: number; number: number };
}

/** Fixed text: contains no issue content, so nothing needs secret scanning. */
export function helloCommentBody(deliveryId: string): string {
  return `👋 Hello from the GitHub AI Agent (walking skeleton). Webhook round trip OK — delivery \`${deliveryId}\`.`;
}

/**
 * Decides what a stored event means. A thrown error goes to the worker's failure rule
 * (a permanent ProviderError fails at once, anything else is retried).
 * Specs 2 and 5 replace this seam.
 */
@Injectable()
export class EventProcessor {
  private readonly targetRepo: string;

  constructor(
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
    config: ConfigService<Env, true>,
  ) {
    this.targetRepo = config.get('TARGET_REPO', { infer: true });
  }

  async process(event: WebhookEvent): Promise<ProcessResult> {
    if (event.eventName === 'ping') return ignored('ping');
    if (event.eventName !== 'issues' || event.action !== 'opened') {
      return ignored('not-handled');
    }

    const payload = event.payload as unknown as IssuesOpenedPayload;
    const fullName = payload.repository.full_name;
    if (fullName.toLowerCase() !== this.targetRepo.toLowerCase()) {
      return ignored('other-repo');
    }

    await this.issues.postComment(
      {
        platform: 'GITHUB',
        id: String(payload.issue.id),
        externalRef: `${fullName}#${payload.issue.number}`,
      },
      helloCommentBody(event.deliveryId),
    );
    return { status: 'DONE' };
  }
}

function ignored(reason: string): ProcessResult {
  return { status: 'IGNORED', reason };
}
