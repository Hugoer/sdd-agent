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
  /** only to revert a lane/modifier label added by a sender without write access */
  removeLabel(task: TaskRef, label: string): Promise<void>;
  /** write or higher (GitHub: collaborator permission on the target repo) */
  hasWriteAccess(task: TaskRef, login: string): Promise<boolean>;
  /** platform label names → neutral controls; returns every lane found, so callers can detect two */
  readControls(task: UnifiedTask): { lanes: Lane[]; grillSkip: boolean };
  /** creates missing status / workflow / modifier labels (startup) */
  ensureLabels(): Promise<void>;
}

export const ISSUE_PROVIDER = Symbol('ISSUE_PROVIDER');
