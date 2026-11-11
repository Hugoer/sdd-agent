import { Injectable, Logger } from '@nestjs/common';
import type { CommentRef } from '../contracts/issue-provider.js';
import { ProviderError } from '../contracts/provider-error.js';
import type {
  PullRequestRef,
  PushCredentials,
  RepoFile,
  RepoProvider,
} from '../contracts/repo-provider.js';
import { GitHubClient } from './github-client.js';

/** GitHub's JSON form of the Contents API carries files up to 1 MB (plan P8). */
const MAX_FILE_BYTES = 1024 * 1024;
const QUALITY_GATE = 'Quality Gate';

/** RepoProvider on GitHub (spec 3). Filled in task by task (T12–T14). */
@Injectable()
export class GitHubRepoProvider implements RepoProvider {
  private readonly logger = new Logger(GitHubRepoProvider.name);

  constructor(private readonly github: GitHubClient) {}

  /** G8: a separate token for git push, limited to TARGET_REPO and contents: write; new on every call. */
  async getPushCredentials(): Promise<PushCredentials> {
    const { data } = await this.github.requestAsApp((octokit) =>
      octokit.request(
        'POST /app/installations/{installation_id}/access_tokens',
        {
          installation_id: this.github.installationId,
          repositories: [this.github.repo],
          permissions: { contents: 'write' },
        },
      ),
    );
    const { login, userId } = this.github.bot;
    return {
      authorName: login,
      authorEmail: `${userId}+${login}@users.noreply.github.com`,
      remoteUrl: `https://github.com/${this.github.targetRepo}.git`,
      token: data.token,
      expiresAt: new Date(data.expires_at),
    };
  }

  /** `null` for a missing path or anything that isn't a file; an unknown ref is an error (A3). */
  async readFile(ref: string, path: string): Promise<string | null> {
    assertSafePath(path);
    const { owner, repo } = this.github;
    let data;
    try {
      ({ data } = await this.github.request((octokit) =>
        octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
          owner,
          repo,
          path,
          ref,
        }),
      ));
    } catch (error) {
      // Both answer 404; only GitHub's message tells a missing path from an unknown ref (plan P7).
      if (
        error instanceof ProviderError &&
        error.detail.status === 404 &&
        !error.message.includes('No commit found for the ref')
      )
        return null;
      throw error;
    }
    if (Array.isArray(data) || data.type !== 'file') return null;
    if (data.encoding !== 'base64' || data.size > MAX_FILE_BYTES) {
      throw new ProviderError(
        `readFile ${path} at ${ref}: over 1 MB (${data.size} bytes)`,
        'permanent',
      );
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(data.content, 'base64'),
      );
    } catch {
      throw new ProviderError(
        `readFile ${path} at ${ref}: not valid UTF-8`,
        'permanent',
      );
    }
  }

  /** G7: a step skill is its whole directory, at any depth. */
  async listFiles(ref: string, dir: string): Promise<RepoFile[] | null> {
    assertSafePath(dir);
    const { owner, repo } = this.github;
    // An unknown ref fails here (422), before any tree is read.
    const { data: commit } = await this.github.request((octokit) =>
      octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
        owner,
        repo,
        ref,
      }),
    );
    const { data: tree } = await this.github.request((octokit) =>
      octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
        owner,
        repo,
        tree_sha: commit.commit.tree.sha,
        recursive: '1',
      }),
    );
    if (tree.truncated) {
      throw new ProviderError(
        `listFiles ${dir} at ${ref}: GitHub truncated the tree listing`,
        'permanent',
      );
    }
    const root = dir.replace(/\/+$/, '');
    if (
      root !== '' &&
      !tree.tree.some((entry) => entry.type === 'tree' && entry.path === root)
    )
      return null;
    const prefix = root === '' ? '' : `${root}/`;
    return tree.tree
      .filter(
        (entry) =>
          (entry.mode === '100644' || entry.mode === '100755') &&
          entry.path.startsWith(prefix),
      )
      .map((entry) => ({
        path: entry.path,
        size: entry.size ?? 0,
        executable: entry.mode === '100755',
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** A normal PR. No lookup first: a retry runs findPullRequest before this (overview §7 rule 7). */
  async openPullRequest(
    branch: string,
    base: string,
    title: string,
    body: string,
  ): Promise<PullRequestRef> {
    const { owner, repo } = this.github;
    const { data } = await this.github.request((octokit) =>
      octokit.request('POST /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        head: branch,
        base,
        title,
        body,
        draft: false,
      }),
    );
    this.logger.log(`openPullRequest ${branch} → #${data.number}`);
    return this.pullRequestRef(data);
  }

  /** The newest PR of the branch opened by this App, in any state; a human's PR doesn't count. */
  async findPullRequest(branch: string): Promise<PullRequestRef | null> {
    const { owner, repo } = this.github;
    const pulls = await this.github.request((octokit) =>
      octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        head: `${owner}:${branch}`,
        state: 'all',
        per_page: 100,
      }),
    );
    const mine = pulls
      .filter((pull) => pull.user?.id === this.github.bot.userId)
      .sort((a, b) => b.number - a.number);
    return mine.length > 0 ? this.pullRequestRef(mine[0]) : null;
  }

  async postPullRequestComment(
    pr: PullRequestRef,
    body: string,
  ): Promise<CommentRef> {
    const target = this.github.targetPullRequest(pr);
    const { data } = await this.github.request((octokit) =>
      octokit.request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        { ...target, body },
      ),
    );
    this.logger.log(
      `postPullRequestComment #${pr.number} → comment ${data.id}`,
    );
    return {
      id: String(data.id),
      url: data.html_url,
      createdAt: new Date(data.created_at),
    };
  }

  /** G12: one Quality Gate check run per commit; the same commit again updates it. */
  async setQualityResult(
    pr: PullRequestRef,
    commitSha: string,
    result: 'success' | 'neutral' | 'failure',
    summary: string,
  ): Promise<void> {
    const { owner, repo } = this.github.targetPullRequest(pr);
    const appId = this.github.appId;
    const { data } = await this.github.request((octokit) =>
      octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
        owner,
        repo,
        ref: commitSha,
        check_name: QUALITY_GATE,
        app_id: appId,
      }),
    );
    const existing = data.check_runs.find(
      (run) => run.name === QUALITY_GATE && run.app?.id === appId,
    );
    const completed = {
      status: 'completed' as const,
      conclusion: result,
      completed_at: new Date().toISOString(),
      output: { title: QUALITY_GATE, summary },
    };
    if (existing) {
      await this.github.request((octokit) =>
        octokit.request(
          'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}',
          { owner, repo, check_run_id: existing.id, ...completed },
        ),
      );
      this.logger.log(
        `setQualityResult #${pr.number} ${commitSha} → updated check run ${existing.id} (${result})`,
      );
      return;
    }
    const { data: created } = await this.github.request((octokit) =>
      octokit.request('POST /repos/{owner}/{repo}/check-runs', {
        owner,
        repo,
        name: QUALITY_GATE,
        head_sha: commitSha,
        ...completed,
      }),
    );
    this.logger.log(
      `setQualityResult #${pr.number} ${commitSha} → created check run ${created.id} (${result})`,
    );
  }

  private pullRequestRef(pull: {
    number: number;
    html_url: string;
  }): PullRequestRef {
    return {
      platform: 'GITHUB',
      repo: this.github.targetRepo,
      number: pull.number,
      url: pull.html_url,
    };
  }
}

/** Repo-relative only: no leading `/`, no `..` segment (checked before any request). */
function assertSafePath(path: string): void {
  if (path.startsWith('/') || path.split('/').includes('..')) {
    throw new ProviderError(`unsafe path "${path}"`, 'permanent');
  }
}
