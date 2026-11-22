// Overview §4 (normative), added 2026-11-11 by spec 2. Types only.
import type { Lane, TaskRef } from './issue-provider.js';
import type { PullRequestRef } from './repo-provider.js';

/** A comment as it was created; later edits are ignored. */
export interface TaskComment {
  id: string;
  body: string; // untrusted data
  createdAt: Date;
  url?: string; // 2026-11-17, spec 6 (GMW9): spec 2's signed test requests have none
}

/** What intake hands to the router: one authorized event, platform-neutral. */
export type WorkflowInput = {
  deliveryId: string; // WebhookEvent.deliveryId
  receivedAt: Date; // when the controller stored the event ("received" in overview §3 R1)
  sender: string; // login; the bot's own login only on PR_UPDATED
} & (
  | { type: 'ISSUE_OPENED' | 'SKIP_ADDED'; task: TaskRef }
  | { type: 'LANE_ADDED' | 'LANE_REMOVED'; task: TaskRef; lane: Lane }
  | {
      // RETRY: 2026-11-16, D25; REFRESH, RESTORE: 2026-11-21, spec 7 (D29, D30)
      type: 'COMMENT' | 'APPROVE' | 'RETRY' | 'REFRESH' | 'RESTORE';
      task: TaskRef;
      comment: TaskComment;
    }
  // 2026-11-21, spec 7 (D30): a comment the bot wrote on the issue was deleted; `body` is its text when deleted.
  | { type: 'BOT_COMMENT_DELETED'; task: TaskRef; comment: TaskComment }
  | { type: 'PR_UPDATED'; pr: PullRequestRef; headSha: string }
);
