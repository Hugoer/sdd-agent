import { Injectable, Logger } from '@nestjs/common';
import type {
  CommentRef,
  IssueProvider,
  Lane,
  UnifiedTask,
} from '../contracts/issue-provider.js';
import { ProviderError } from '../contracts/provider-error.js';
import { GitHubClient } from './github-client.js';
import {
  BOT_LABELS,
  GRILL_SKIP,
  LANES,
  laneLabel,
  sameLabel,
} from './labels.js';

/** IssueProvider on GitHub (spec 3). A defined "missing" result is a value; every other failure a ProviderError. */
@Injectable()
export class GitHubIssueProvider implements IssueProvider {
  private readonly logger = new Logger(GitHubIssueProvider.name);

  constructor(private readonly github: GitHubClient) {}

  getTaskDetails(): Promise<UnifiedTask> {
    return Promise.reject(new Error('not implemented yet (spec 3, T7)'));
  }

  postComment(): Promise<CommentRef> {
    return Promise.reject(new Error('not implemented yet (spec 3, T7)'));
  }

  getComment(): Promise<{ body: string; createdAt: Date } | null> {
    return Promise.reject(new Error('not implemented yet (spec 3, T7)'));
  }

  findCommentByMarker(): Promise<CommentRef | null> {
    return Promise.reject(new Error('not implemented yet (spec 3, T7)'));
  }

  setStatusLabel(): Promise<void> {
    return Promise.reject(new Error('not implemented yet (spec 3, T10)'));
  }

  removeLabel(): Promise<void> {
    return Promise.reject(new Error('not implemented yet (spec 3, T10)'));
  }

  hasWriteAccess(): Promise<boolean> {
    return Promise.reject(new Error('not implemented yet (spec 3, T10)'));
  }

  readControls(task: UnifiedTask): { lanes: Lane[]; grillSkip: boolean } {
    const has = (name: string) =>
      task.labels.some((label) => sameLabel(label, name));
    return {
      lanes: LANES.filter((lane) => has(laneLabel(lane))),
      grillSkip: has(GRILL_SKIP),
    };
  }

  /** G10: creates each missing bot label; never edits or deletes one. */
  async ensureLabels(): Promise<void> {
    const { owner, repo } = this.github;
    const existing = await this.github.request((octokit) =>
      octokit.paginate('GET /repos/{owner}/{repo}/labels', {
        owner,
        repo,
        per_page: 100,
      }),
    );
    const missing = BOT_LABELS.filter(
      (label) => !existing.some((found) => sameLabel(found.name, label.name)),
    );
    let created = 0;
    for (const label of missing) {
      try {
        await this.github.request((octokit) =>
          octokit.request('POST /repos/{owner}/{repo}/labels', {
            owner,
            repo,
            ...label,
          }),
        );
        created++;
      } catch (error) {
        if (!(error instanceof ProviderError && isAlreadyExists(error)))
          throw error;
      }
    }
    this.logger.log(
      `Labels on ${this.github.targetRepo}: ${created} created, ${BOT_LABELS.length - created} already present`,
    );
  }
}

function isAlreadyExists(error: ProviderError): boolean {
  return (
    error.detail.status === 422 && error.message.includes('already_exists')
  );
}
