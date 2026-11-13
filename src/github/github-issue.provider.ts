import { Injectable, Logger } from '@nestjs/common';
import type {
  AccessLevel,
  CommentRef,
  IssueProvider,
  Lane,
  TaskRef,
  TaskStatus,
  UnifiedTask,
} from '../contracts/issue-provider.js';
import { ProviderError } from '../contracts/provider-error.js';
import type { StepName } from '../contracts/step.js';
import { GitHubClient } from './github-client.js';
import {
  BOT_LABELS,
  GRILL_SKIP,
  LANES,
  STEPS,
  isHumanControlLabel,
  isStatusLabel,
  laneLabel,
  modelLabel,
  sameLabel,
  statusLabel,
} from './labels.js';

/** IssueProvider on GitHub (spec 3). A defined "missing" result is a value; every other failure a ProviderError. */
@Injectable()
export class GitHubIssueProvider implements IssueProvider {
  private readonly logger = new Logger(GitHubIssueProvider.name);

  constructor(private readonly github: GitHubClient) {}

  async getTaskDetails(task: TaskRef): Promise<UnifiedTask> {
    const target = this.github.target(task);
    const { data } = await this.github.request((octokit) =>
      octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        ...target,
      }),
    );
    return {
      platform: 'GITHUB',
      id: String(data.id),
      externalRef: task.externalRef,
      title: data.title,
      description: data.body ?? '',
      labels: data.labels
        .map((label) => (typeof label === 'string' ? label : label.name))
        .filter((name): name is string => !!name),
      author: data.user?.login ?? '',
      url: data.html_url,
    };
  }

  async postComment(task: TaskRef, body: string): Promise<CommentRef> {
    const target = this.github.target(task);
    const { data } = await this.github.request((octokit) =>
      octokit.request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        { ...target, body },
      ),
    );
    this.logger.log(`postComment ${task.externalRef} → comment ${data.id}`);
    return commentRef(data);
  }

  async getComment(
    task: TaskRef,
    commentId: string,
  ): Promise<{ body: string; createdAt: Date } | null> {
    const { owner, repo, issue_number } = this.github.target(task);
    const found = await this.github.requestOrNull((octokit) =>
      octokit.request(
        'GET /repos/{owner}/{repo}/issues/comments/{comment_id}',
        {
          owner,
          repo,
          comment_id: Number(commentId),
        },
      ),
    );
    // A comment ID is repo-wide: one of another issue is "missing" for this task.
    if (!found || !found.data.issue_url.endsWith(`/issues/${issue_number}`))
      return null;
    return {
      body: found.data.body ?? '',
      createdAt: new Date(found.data.created_at),
    };
  }

  /** G11: only comments this App wrote count, so a pasted marker can't fake a posted step. */
  async findCommentByMarker(
    task: TaskRef,
    marker: string,
  ): Promise<CommentRef | null> {
    const target = this.github.target(task);
    if (marker === '')
      throw new ProviderError('findCommentByMarker: empty marker', 'permanent');
    const comments = await this.github.request((octokit) =>
      octokit.paginate(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
        { ...target, per_page: 100 },
      ),
    );
    // GitHub lists comments oldest first.
    const found = comments.find(
      (comment) =>
        comment.performed_via_github_app?.id === this.github.appId &&
        (comment.body ?? '').includes(marker),
    );
    return found ? commentRef(found) : null;
  }

  /** G9: add first, then remove the other status labels, so the issue is never left without one. */
  async setStatusLabel(task: TaskRef, status: TaskStatus): Promise<void> {
    const target = this.github.target(task);
    const wanted = statusLabel(status);
    const current = await this.github.request((octokit) =>
      octokit.paginate(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/labels',
        { ...target, per_page: 100 },
      ),
    );
    const names = current.map((label) => label.name);
    if (!names.some((name) => sameLabel(name, wanted))) {
      await this.github.request((octokit) =>
        octokit.request(
          'POST /repos/{owner}/{repo}/issues/{issue_number}/labels',
          { ...target, labels: [wanted] },
        ),
      );
      this.logger.log(`setStatusLabel ${task.externalRef} → added "${wanted}"`);
    }
    for (const name of names) {
      if (!isStatusLabel(name) || sameLabel(name, wanted)) continue;
      await this.github.request((octokit) =>
        octokit.request(
          'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}',
          { ...target, name },
        ),
      );
      this.logger.log(`setStatusLabel ${task.externalRef} → removed "${name}"`);
    }
  }

  /** A4: only lane, modifier and model labels (spec 4); a label already gone counts as removed. */
  async removeLabel(task: TaskRef, label: string): Promise<void> {
    if (!isHumanControlLabel(label)) {
      throw new ProviderError(
        `removeLabel refuses "${label}": only workflow: *, grill: skip and the five model: max-* labels`,
        'permanent',
      );
    }
    const target = this.github.target(task);
    await this.github.requestOrNull((octokit) =>
      octokit.request(
        'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}',
        { ...target, name: label },
      ),
    );
    this.logger.log(`removeLabel ${task.externalRef} → "${label}"`);
  }

  /**
   * Spec 2 AW4: `permission` admin or write (GitHub reports maintain as write) → approver; otherwise
   * `user.permissions.triage` → participant; anything else, a missing field or no such user (404) → none.
   * No cache (spec 3, G6): a failure throws, it is never read as "no access".
   */
  async getAccessLevel(task: TaskRef, login: string): Promise<AccessLevel> {
    const { owner, repo } = this.github.target(task);
    const found = await this.github.requestOrNull((octokit) =>
      octokit.request(
        'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
        { owner, repo, username: login },
      ),
    );
    if (!found) return 'none';
    const { permission, user } = found.data;
    if (permission === 'admin' || permission === 'write') return 'approver';
    if (user?.permissions?.triage === true) return 'participant';
    return 'none';
  }

  /** The bot login (`<slug>[bot]`) is resolved at startup; a human login can't contain `[`. */
  isSelf(login: string): boolean {
    const bot = this.github.bot.login;
    return bot !== '' && login.toLowerCase() === bot.toLowerCase();
  }

  readControls(task: UnifiedTask): {
    lanes: Lane[];
    grillSkip: boolean;
    maxModelSteps: StepName[];
  } {
    const has = (name: string) =>
      task.labels.some((label) => sameLabel(label, name));
    return {
      lanes: LANES.filter((lane) => has(laneLabel(lane))),
      grillSkip: has(GRILL_SKIP),
      maxModelSteps: STEPS.filter((step) => has(modelLabel(step))),
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

function commentRef(comment: {
  id: number | bigint;
  html_url: string;
  created_at: string;
}): CommentRef {
  return {
    id: String(comment.id),
    url: comment.html_url,
    createdAt: new Date(comment.created_at),
  };
}

function isAlreadyExists(error: ProviderError): boolean {
  return (
    error.detail.status === 422 && error.message.includes('already_exists')
  );
}
