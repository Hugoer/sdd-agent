import { Logger } from '@nestjs/common';
import type { CommentRef } from '../contracts/issue-provider.js';
import type {
  PullRequestRef,
  PushCredentials,
  RepoFile,
  RepoProvider,
} from '../contracts/repo-provider.js';
import { redactAtPort, type SecretScanner } from './secret-scanner.js';

/**
 * `REPO_PROVIDER` as every caller gets it (spec 4, LW4): the pull request title and body, a pull request
 * comment and a Quality Gate summary are sent redacted; every other method passes through unchanged.
 */
export class ScanningRepoProvider implements RepoProvider {
  private readonly logger = new Logger(ScanningRepoProvider.name);

  constructor(
    private readonly inner: RepoProvider,
    private readonly scanner: SecretScanner,
  ) {}

  openPullRequest(
    branch: string,
    base: string,
    title: string,
    body: string,
  ): Promise<PullRequestRef> {
    const [cleanTitle, cleanBody] = redactAtPort(
      this.scanner,
      this.logger,
      'openPullRequest',
      `branch ${branch}`,
      [title, body],
    );
    return this.inner.openPullRequest(branch, base, cleanTitle, cleanBody);
  }

  postPullRequestComment(
    pr: PullRequestRef,
    body: string,
  ): Promise<CommentRef> {
    const [clean] = redactAtPort(
      this.scanner,
      this.logger,
      'postPullRequestComment',
      pullRequestOf(pr),
      [body],
    );
    return this.inner.postPullRequestComment(pr, clean);
  }

  setQualityResult(
    pr: PullRequestRef,
    commitSha: string,
    result: 'success' | 'neutral' | 'failure',
    summary: string,
  ): Promise<void> {
    const [clean] = redactAtPort(
      this.scanner,
      this.logger,
      'setQualityResult',
      pullRequestOf(pr),
      [summary],
    );
    return this.inner.setQualityResult(pr, commitSha, result, clean);
  }

  getPushCredentials(): Promise<PushCredentials> {
    return this.inner.getPushCredentials();
  }

  readFile(ref: string, path: string): Promise<string | null> {
    return this.inner.readFile(ref, path);
  }

  listFiles(ref: string, dir: string): Promise<RepoFile[] | null> {
    return this.inner.listFiles(ref, dir);
  }

  resolveRef(ref: string): Promise<string> {
    return this.inner.resolveRef(ref);
  }

  findPullRequest(branch: string): Promise<PullRequestRef | null> {
    return this.inner.findPullRequest(branch);
  }
}

function pullRequestOf(pr: PullRequestRef): string {
  return `${pr.repo}#${pr.number}`;
}
