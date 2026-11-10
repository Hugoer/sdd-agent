import { Injectable } from '@nestjs/common';
import type { WebhookEvent } from '../generated/prisma/client.js';
import { HelloCommentService } from './hello/hello-comment.service.js';

export type ProcessResult =
  { status: 'DONE' } | { status: 'IGNORED'; reason: string };

/** The fields of an `issues.opened` payload the hello comment needs. */
interface IssuesOpenedPayload {
  installation?: { id?: number };
  repository: { name: string; owner: { login: string } };
  issue: { number: number };
}

/**
 * Decides what a stored event means. Throwing means "retry" (worker rules).
 * Specs 2 and 5 replace this seam.
 */
@Injectable()
export class EventProcessor {
  constructor(private readonly hello: HelloCommentService) {}

  async process(event: WebhookEvent): Promise<ProcessResult> {
    if (event.eventName === 'ping') return ignored('ping');
    if (event.eventName !== 'issues' || event.action !== 'opened') {
      return ignored('not-handled');
    }

    const payload = event.payload as unknown as IssuesOpenedPayload;
    const installationId = payload.installation?.id;
    if (!installationId) return ignored('no-installation');

    await this.hello.postHello({
      installationId,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issueNumber: payload.issue.number,
      deliveryId: event.deliveryId,
    });
    return { status: 'DONE' };
  }
}

function ignored(reason: string): ProcessResult {
  return { status: 'IGNORED', reason };
}
