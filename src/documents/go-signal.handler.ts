// Spec 7 "The go-signal" (SPW6; plan P37): the `go-signal` handler of spec 5's step-handler registry. A `code-only`
// run gets one "Ready to code" comment; its `/approve` stores the issue's title and description as they read then.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
} from '../contracts/issue-provider.js';
import { SecretScanner } from '../secret-scan/secret-scanner.js';
import type { StepOutcome } from '../workflow/decide.js';
import type {
  StepContext,
  StepHandler,
} from '../workflow/step-handler.registry.js';
import { goSignalComment } from './document-comments.js';
import { DocumentPosts } from './document-posts.js';
import { DocumentsStore } from './documents.store.js';

@Injectable()
export class GoSignalHandler implements StepHandler {
  constructor(
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
    private readonly store: DocumentsStore,
    private readonly scanner: SecretScanner,
    private readonly posts: DocumentPosts,
  ) {}

  async run(context: StepContext): Promise<StepOutcome | void> {
    switch (context.op) {
      case 'post':
        return this.post(context);
      case 'approve':
        return this.approve(context);
      default:
        throw new Error(`go-signal: no ${context.op} op`);
    }
  }

  /**
   * Row 11: the comment once, as a `go-signal` row (version 1, no commit, no text: P37) through the two
   * transactions; a row stored by Tx1 and not posted (a crash) is posted now. The router then sets `ready-for-dev`.
   */
  private async post(context: StepContext): Promise<void> {
    const { run } = context;
    const found = await this.store.current(run.id, 'go-signal');
    if (found?.postState === 'POSTED') return;
    const row =
      found ??
      (await this.store.insertVersion(context.lease, {
        id: randomUUID(),
        runId: run.id,
        kind: 'go-signal',
        version: 1,
        origin: 'written',
        commit: null,
        logId: null,
        text: '',
        notes: [],
        body: goSignalComment(run),
      }));
    await this.posts.postVersion(context, row);
    this.posts.log(
      context,
      found ? 'posted (recovered)' : 'posted',
      'go-signal',
    );
  }

  /**
   * Row 19 (SPW6, P37): the issue's title, a blank line and the description, as they read now, redacted, are the
   * approved text; no comment is read (a deleted go-signal still counts). This event's approval already recorded (a
   * `/retry` of the `workspace` stop) → nothing.
   */
  private async approve(context: StepContext): Promise<void> {
    const { run, status, statusBeforeStop, lease, input, task } = context;
    if (input.type !== 'APPROVE')
      throw new Error(`go-signal approve: a ${input.type} event`);
    const waiting = await this.store.waiting(run.id, status, statusBeforeStop);
    if (waiting?.kind !== 'go-signal')
      throw new Error(`go-signal approve: no go-signal in ${status}`);
    if (waiting.approveEventId === lease.eventId) return;
    const details = await this.issues.getTaskDetails(task.ref);
    await this.store.approve(lease, waiting.id, {
      approvedText: this.scanner.redact(
        `${details.title}\n\n${details.description}`,
      ).text,
      approvedBy: input.sender,
      approveCommentId: input.comment.id,
      approvedCommit: null,
      staleFiles: [],
      changedFiles: null,
      changedPaths: [],
      changedComplete: null,
      linesAdded: null,
      linesRemoved: null,
    });
    this.posts.log(context, `approved by ${input.sender}`, 'go-signal');
  }
}
