// Overview §4 (normative), added 2026-11-11 by spec 2. Types only.
import type { Lane, TaskRef } from './issue-provider.js';
import type { PullRequestRef } from './repo-provider.js';

/** A comment as it was created; later edits are ignored. */
export interface TaskComment {
  id: string;
  body: string; // untrusted data
  createdAt: Date;
}

/** What intake hands to the router: one authorized event, platform-neutral. */
export type WorkflowInput = {
  deliveryId: string; // WebhookEvent.deliveryId
  receivedAt: Date; // when the controller stored the event ("received" in overview §3 R1)
  sender: string; // login; the bot's own login only on PR_UPDATED
} & (
  | { type: 'ISSUE_OPENED' | 'SKIP_ADDED'; task: TaskRef }
  | { type: 'LANE_ADDED' | 'LANE_REMOVED'; task: TaskRef; lane: Lane }
  | { type: 'COMMENT' | 'APPROVE'; task: TaskRef; comment: TaskComment }
  | { type: 'PR_UPDATED'; pr: PullRequestRef; headSha: string }
);
