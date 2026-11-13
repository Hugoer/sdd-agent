import { Logger } from '@nestjs/common';
import type {
  AccessLevel,
  CommentRef,
  IssueProvider,
  TaskRef,
  TaskStatus,
  UnifiedTask,
} from '../contracts/issue-provider.js';
import { redactAtPort, type SecretScanner } from './secret-scanner.js';

/**
 * `ISSUE_PROVIDER` as every caller gets it (spec 4, LW4): `postComment` sends the redacted body; every other
 * method passes through unchanged. Hidden markers are not affected.
 */
export class ScanningIssueProvider implements IssueProvider {
  private readonly logger = new Logger(ScanningIssueProvider.name);

  constructor(
    private readonly inner: IssueProvider,
    private readonly scanner: SecretScanner,
  ) {}

  postComment(task: TaskRef, body: string): Promise<CommentRef> {
    const [clean] = redactAtPort(
      this.scanner,
      this.logger,
      'postComment',
      task.externalRef,
      [body],
    );
    return this.inner.postComment(task, clean);
  }

  getTaskDetails(task: TaskRef): Promise<UnifiedTask> {
    return this.inner.getTaskDetails(task);
  }

  getComment(
    task: TaskRef,
    commentId: string,
  ): Promise<{ body: string; createdAt: Date } | null> {
    return this.inner.getComment(task, commentId);
  }

  findCommentByMarker(
    task: TaskRef,
    marker: string,
  ): Promise<CommentRef | null> {
    return this.inner.findCommentByMarker(task, marker);
  }

  setStatusLabel(task: TaskRef, status: TaskStatus): Promise<void> {
    return this.inner.setStatusLabel(task, status);
  }

  removeLabel(task: TaskRef, label: string): Promise<void> {
    return this.inner.removeLabel(task, label);
  }

  getAccessLevel(task: TaskRef, login: string): Promise<AccessLevel> {
    return this.inner.getAccessLevel(task, login);
  }

  isSelf(login: string): boolean {
    return this.inner.isSelf(login);
  }

  readControls(task: UnifiedTask): ReturnType<IssueProvider['readControls']> {
    return this.inner.readControls(task);
  }

  ensureLabels(): Promise<void> {
    return this.inner.ensureLabels();
  }
}
