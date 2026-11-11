import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { App, Octokit, RequestError } from 'octokit';
import type { Env } from '../config/env.schema.js';
import type { TaskRef } from '../contracts/issue-provider.js';
import { ProviderError } from '../contracts/provider-error.js';
import type { PullRequestRef } from '../contracts/repo-provider.js';

/** Test seam (plan P1). Production provides nothing: global fetch, 30 s timeout (spec A5). */
export const GITHUB_CLIENT_OPTIONS = Symbol('GITHUB_CLIENT_OPTIONS');
export interface GitHubClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** GitHub's advice for a secondary rate limit that names no wait time. */
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 60;

export interface Installation {
  id: number;
  appSlug: string;
  permissions: Record<string, string | undefined>;
}

export interface BotIdentity {
  login: string; // "<slug>[bot]"
  userId: number;
}

export interface IssueTarget {
  owner: string;
  repo: string;
  issue_number: number;
}

/**
 * The only Octokit import (spec 3). App auth on TARGET_REPO, one installation client, and one
 * error mapping: every failure leaves this class as a ProviderError. Octokit's retry and throttling
 * plugins are off (G5): the worker is the only retry layer.
 */
@Injectable()
export class GitHubClient {
  readonly owner: string;
  readonly repo: string;
  private readonly logger = new Logger(GitHubClient.name);
  private readonly app: App;
  private installation: Octokit | undefined;
  private appSlug = '';
  /** Set by connect() and identifyBot() at startup. */
  installationId = 0;
  bot: BotIdentity = { login: '', userId: 0 };

  constructor(
    config: ConfigService<Env, true>,
    @Optional()
    @Inject(GITHUB_CLIENT_OPTIONS)
    options: GitHubClientOptions = {},
  ) {
    [this.owner, this.repo] = config
      .get('TARGET_REPO', { infer: true })
      .split('/');
    const baseFetch = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const log = {
      debug: () => {},
      info: () => {},
      warn: (message: string) => this.logger.warn(message),
      error: (message: string) => this.logger.error(message),
    };
    this.app = new App({
      appId: config.get('GITHUB_APP_ID', { infer: true }),
      privateKey: readFileSync(
        config.get('GITHUB_APP_PRIVATE_KEY_PATH', { infer: true }),
        'utf8',
      ),
      log,
      Octokit: Octokit.defaults({
        retry: { enabled: false },
        throttle: { enabled: false },
        log,
        request: {
          // A fresh timeout per request (plan P2).
          fetch: (input: string | URL | Request, init?: RequestInit) =>
            baseFetch(input, {
              ...init,
              signal: AbortSignal.timeout(timeoutMs),
            }),
        },
      }),
    });
  }

  get targetRepo(): string {
    return `${this.owner}/${this.repo}`;
  }

  /** Startup step 1: finds the installation of TARGET_REPO as the App (JWT) and keeps its client. */
  async connect(): Promise<Installation> {
    const { data } = await this.requestAsApp((octokit) =>
      octokit.request('GET /repos/{owner}/{repo}/installation', {
        owner: this.owner,
        repo: this.repo,
      }),
    );
    if (!data.app_slug) {
      throw new ProviderError(
        'GitHub installation has no app_slug',
        'permanent',
      );
    }
    this.installation = await this.app.getInstallationOctokit(data.id);
    this.appSlug = data.app_slug;
    this.installationId = data.id;
    return {
      id: data.id,
      appSlug: data.app_slug,
      permissions: { ...data.permissions },
    };
  }

  /** Startup step 3: the bot user (`<slug>[bot]`) whose ID forms the commit email. */
  async identifyBot(): Promise<BotIdentity> {
    const login = `${this.appSlug}[bot]`;
    const { data } = await this.request((octokit) =>
      octokit.request('GET /users/{username}', { username: login }),
    );
    this.bot = { login, userId: Number(data.id) };
    return this.bot;
  }

  /** One GitHub call on the installation client. `send` must make exactly one request (or one paginated read). */
  async request<T>(send: (octokit: Octokit) => Promise<T>): Promise<T> {
    if (!this.installation)
      throw new Error('GitHubClient.connect() has not run');
    try {
      return await send(this.installation);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  /** As `request`, but a `404` is the method's defined "missing" result. */
  async requestOrNull<T>(
    send: (octokit: Octokit) => Promise<T>,
  ): Promise<T | null> {
    try {
      return await this.request(send);
    } catch (error) {
      if (error instanceof ProviderError && error.detail.status === 404)
        return null;
      throw error;
    }
  }

  /** One call authenticated as the App itself (JWT): installation lookup, narrowed tokens. */
  async requestAsApp<T>(send: (octokit: Octokit) => Promise<T>): Promise<T> {
    try {
      return await send(this.app.octokit);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  /** The issue of a task, only if it lives in TARGET_REPO (no request is made otherwise). */
  target(task: TaskRef): IssueTarget {
    const match = /^([^/#\s]+\/[^/#\s]+)#([1-9]\d*)$/.exec(task.externalRef);
    if (!match || match[1].toLowerCase() !== this.targetRepo.toLowerCase()) {
      throw new ProviderError(
        `Task ${task.externalRef} is not an issue of ${this.targetRepo}`,
        'permanent',
      );
    }
    return {
      owner: this.owner,
      repo: this.repo,
      issue_number: Number(match[2]),
    };
  }

  targetPullRequest(pr: PullRequestRef): IssueTarget {
    if (pr.repo.toLowerCase() !== this.targetRepo.toLowerCase()) {
      throw new ProviderError(
        `Pull request ${pr.repo}#${pr.number} is not in ${this.targetRepo}`,
        'permanent',
      );
    }
    return { owner: this.owner, repo: this.repo, issue_number: pr.number };
  }
}

/** Spec 3 "Errors and retries". The message holds method, path, status and GitHub's message only. */
export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (!(error instanceof RequestError)) {
    const reason = error instanceof Error ? error.message : String(error);
    // Octokit rethrows an aborted fetch as is; everything else here is not a network failure.
    const aborted =
      error instanceof Error &&
      ['AbortError', 'TimeoutError'].includes(error.name);
    return aborted
      ? new ProviderError(
          `GitHub request failed, no response: ${reason}`,
          'transient',
        )
      : new ProviderError(`GitHub client error: ${reason}`, 'permanent');
  }

  const where = `GitHub ${error.request.method} ${new URL(error.request.url).pathname}`;
  if (!error.response) {
    return new ProviderError(
      `${where} → no response: ${error.message}`,
      'transient',
    );
  }

  const status = error.status;
  const message = `${where} → ${status}: ${githubMessage(error.response.data)}`;
  if (status >= 500) return new ProviderError(message, 'transient', { status });

  const headers = error.response.headers;
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (headers['retry-after'] !== undefined ||
        headers['x-ratelimit-remaining'] === '0'));
  if (rateLimited) {
    return new ProviderError(message, 'transient', {
      status,
      retryAfterSeconds: waitSeconds(headers),
    });
  }
  return new ProviderError(message, 'permanent', { status });
}

function waitSeconds(
  headers: Record<string, string | number | undefined>,
): number {
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0)
    return Math.ceil(retryAfter);
  const reset = Number(headers['x-ratelimit-reset']);
  if (Number.isFinite(reset) && reset > 0)
    return Math.max(1, Math.ceil(reset - Date.now() / 1000));
  return DEFAULT_RATE_LIMIT_WAIT_SECONDS;
}

function githubMessage(data: unknown): string {
  if (typeof data === 'string') return data || 'no message';
  if (typeof data !== 'object' || data === null) return 'no message';
  const { message, errors } = data as { message?: unknown; errors?: unknown };
  const details = Array.isArray(errors)
    ? errors
        .map((item: unknown) =>
          typeof item === 'string'
            ? item
            : ((item as { message?: unknown; code?: unknown }).message ??
              (item as { code?: unknown }).code),
        )
        .filter((detail): detail is string => typeof detail === 'string')
    : [];
  const text = typeof message === 'string' && message ? message : 'no message';
  return details.length > 0 ? `${text} (${details.join('; ')})` : text;
}
