// In-memory RepoProvider for specs 4 and later (spec 3, G13). Same rules as the GitHub adapter,
// no network. Files are seeded per ref; a ref with no seeded file does not exist.
import type { CommentRef } from '../../src/contracts/issue-provider.js';
import { ProviderError } from '../../src/contracts/provider-error.js';
import type {
  PullRequestRef,
  PushCredentials,
  RepoFile,
  RepoProvider,
} from '../../src/contracts/repo-provider.js';

const MAX_FILE_BYTES = 1024 * 1024;

interface FakePullRequest {
  ref: PullRequestRef;
  branch: string;
  base: string;
  title: string;
  body: string;
  byBot: boolean;
  state: 'open' | 'closed';
}

export class InMemoryRepoProvider implements RepoProvider {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly pullRequests: FakePullRequest[] = [];
  readonly pullRequestComments: { number: number; body: string }[] = [];
  readonly checkRuns: { sha: string; conclusion: string; summary: string }[] =
    [];
  private readonly refs = new Map<
    string,
    Map<string, { content: string; executable: boolean }>
  >();
  private nextError: ProviderError | undefined;
  private nextToken = 1;
  private nextNumber = 1;

  constructor(readonly repo = 'test-owner/test-repo') {}

  // ── seeding ──

  seedFile(
    ref: string,
    path: string,
    content: string,
    options: { executable?: boolean } = {},
  ): void {
    const files =
      this.refs.get(ref) ??
      new Map<string, { content: string; executable: boolean }>();
    files.set(path, { content, executable: options.executable ?? false });
    this.refs.set(ref, files);
  }

  seedPullRequest(
    branch: string,
    options: { byBot: boolean; state?: 'open' | 'closed' },
  ): PullRequestRef {
    return this.addPullRequest(
      branch,
      'main',
      '',
      '',
      options.byBot,
      options.state ?? 'open',
    );
  }

  /** The next provider call rejects with this error (and changes nothing). */
  failNext(error: ProviderError): void {
    this.nextError = error;
  }

  // ── RepoProvider ──

  getPushCredentials(): Promise<PushCredentials> {
    return this.call('getPushCredentials', [], () => ({
      authorName: 'test-app[bot]',
      authorEmail: '1+test-app[bot]@users.noreply.github.com',
      remoteUrl: `https://github.com/${this.repo}.git`,
      token: `fake-push-token-${this.nextToken++}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }));
  }

  readFile(ref: string, path: string): Promise<string | null> {
    return this.call('readFile', [ref, path], () => {
      const files = this.files(ref, path);
      const file = files.get(path);
      if (!file) return null;
      if (Buffer.byteLength(file.content) > MAX_FILE_BYTES) {
        throw new ProviderError(`readFile ${path}: over 1 MB`, 'permanent');
      }
      return file.content;
    });
  }

  listFiles(ref: string, dir: string): Promise<RepoFile[] | null> {
    return this.call('listFiles', [ref, dir], () => {
      const files = this.files(ref, dir);
      const prefix = dir === '' ? '' : `${dir.replace(/\/+$/, '')}/`;
      const found = [...files.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, file]) => ({
          path,
          size: Buffer.byteLength(file.content),
          executable: file.executable,
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return found.length > 0 ? found : null;
    });
  }

  openPullRequest(
    branch: string,
    base: string,
    title: string,
    body: string,
  ): Promise<PullRequestRef> {
    return this.call('openPullRequest', [branch, base, title, body], () => {
      if (
        this.pullRequests.some(
          (pr) => pr.branch === branch && pr.state === 'open',
        )
      ) {
        throw new ProviderError(
          `GitHub POST /repos/${this.repo}/pulls → 422: A pull request already exists for ${branch}.`,
          'permanent',
          { status: 422 },
        );
      }
      return this.addPullRequest(branch, base, title, body, true, 'open');
    });
  }

  findPullRequest(branch: string): Promise<PullRequestRef | null> {
    return this.call('findPullRequest', [branch], () => {
      const mine = this.pullRequests.filter(
        (pr) => pr.branch === branch && pr.byBot,
      );
      return mine.at(-1)?.ref ?? null;
    });
  }

  postPullRequestComment(
    pr: PullRequestRef,
    body: string,
  ): Promise<CommentRef> {
    return this.call('postPullRequestComment', [pr, body], () => {
      this.pullRequest(pr);
      this.pullRequestComments.push({ number: pr.number, body });
      const id = String(this.pullRequestComments.length);
      return { id, url: `${pr.url}#issuecomment-${id}`, createdAt: new Date() };
    });
  }

  setQualityResult(
    pr: PullRequestRef,
    commitSha: string,
    result: 'success' | 'neutral' | 'failure',
    summary: string,
  ): Promise<void> {
    return this.call(
      'setQualityResult',
      [pr, commitSha, result, summary],
      () => {
        this.pullRequest(pr);
        const existing = this.checkRuns.find((run) => run.sha === commitSha);
        if (existing) {
          existing.conclusion = result;
          existing.summary = summary;
        } else {
          this.checkRuns.push({ sha: commitSha, conclusion: result, summary });
        }
      },
    );
  }

  // ── internals ──

  private call<T>(method: string, args: unknown[], run: () => T): Promise<T> {
    this.calls.push({ method, args });
    const error = this.nextError;
    this.nextError = undefined;
    // The executor turns a thrown error into a rejection.
    return new Promise((resolve) => {
      if (error) throw error;
      resolve(run());
    });
  }

  private files(
    ref: string,
    path: string,
  ): Map<string, { content: string; executable: boolean }> {
    if (path.startsWith('/') || path.split('/').includes('..')) {
      throw new ProviderError(`unsafe path "${path}"`, 'permanent');
    }
    const files = this.refs.get(ref);
    if (!files)
      throw new ProviderError(`unknown ref "${ref}"`, 'permanent', {
        status: 404,
      });
    return files;
  }

  private pullRequest(pr: PullRequestRef): FakePullRequest {
    const found = this.pullRequests.find(
      (existing) => existing.ref.number === pr.number,
    );
    if (pr.repo.toLowerCase() !== this.repo.toLowerCase() || !found) {
      throw new ProviderError(
        `unknown pull request ${pr.repo}#${pr.number}`,
        'permanent',
        { status: 404 },
      );
    }
    return found;
  }

  private addPullRequest(
    branch: string,
    base: string,
    title: string,
    body: string,
    byBot: boolean,
    state: 'open' | 'closed',
  ): PullRequestRef {
    const number = this.nextNumber++;
    const ref: PullRequestRef = {
      platform: 'GITHUB',
      repo: this.repo,
      number,
      url: `https://github.com/${this.repo}/pull/${number}`,
    };
    this.pullRequests.push({ ref, branch, base, title, body, byBot, state });
    return ref;
  }
}
