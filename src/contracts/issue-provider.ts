// Overview §4 (normative). Types and the DI token only; GitHub implementation: src/github.

export type Platform = 'GITHUB' | 'JIRA' | 'AZURE_DEVOPS';
export type Lane = 'full-sdd' | 'spec-code' | 'code-only';
export type TaskStatus =
  | 'draft'
  | 'grilling'
  | 'spec-review'
  | 'ready-for-dev'
  | 'executing'
  | 'in-review'
  | 'needs-human';
/** What a user may do with the bot, lowest first (D19, added 2026-11-11). Never a platform's role name. */
export type AccessLevel = 'none' | 'participant' | 'approver';

/** DB identity = platform + id. externalRef is what adapters call the API with; it may change. */
export interface TaskRef {
  platform: Platform;
  id: string; // stable platform ID (GitHub: issue.id)
  externalRef: string; // e.g. "owner/repo#123", "PROJ-123"; refreshed from every event
}

export interface UnifiedTask extends TaskRef {
  title: string;
  description: string;
  labels: string[]; // always read from the API, never from a webhook payload
  author: string;
  url: string;
}

export interface CommentRef {
  id: string;
  url: string;
  createdAt: Date;
}

export interface IssueProvider {
  getTaskDetails(task: TaskRef): Promise<UnifiedTask>;
  /** body is already secret-scanned and carries its hidden marker */
  postComment(task: TaskRef, body: string): Promise<CommentRef>;
  getComment(
    task: TaskRef,
    commentId: string,
  ): Promise<{ body: string; createdAt: Date } | null>;
  /** exactly-once recovery: the bot's comment carrying this marker, if it was already posted */
  findCommentByMarker(
    task: TaskRef,
    marker: string,
  ): Promise<CommentRef | null>;
  /** projection of Task.status: sets this status label and removes any other `status: *` label */
  setStatusLabel(task: TaskRef, status: TaskStatus): Promise<void>;
  /** only to revert a lane/modifier label added by a sender with no access (D21) */
  removeLabel(task: TaskRef, label: string): Promise<void>;
  /** the user's level on the task's repo or project, asked on every call (spec 2, 2026-11-11).
   *  GitHub: Write or higher → 'approver', Triage → 'participant', anything else or unknown user → 'none' */
  getAccessLevel(task: TaskRef, login: string): Promise<AccessLevel>;
  /** true when login is the bot's own account (added 2026-11-11, spec 2) */
  isSelf(login: string): boolean;
  /** platform label names → neutral controls; returns every lane found, so callers can detect two */
  readControls(task: UnifiedTask): { lanes: Lane[]; grillSkip: boolean };
  /** creates missing status / workflow / modifier labels (startup) */
  ensureLabels(): Promise<void>;
}

export const ISSUE_PROVIDER = Symbol('ISSUE_PROVIDER');
