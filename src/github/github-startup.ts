import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
} from '../contracts/issue-provider.js';
import { ProviderError } from '../contracts/provider-error.js';
import { GitHubClient } from './github-client.js';

/** Startup failed: main.ts prints the message alone and exits with code 1 (plan P9). */
export class GitHubStartupError extends Error {
  override readonly name = 'GitHubStartupError';
}

/** Spec A1: what the App needs on TARGET_REPO. */
const REQUIRED_PERMISSIONS: Record<string, 'read' | 'write'> = {
  issues: 'write',
  pull_requests: 'write',
  contents: 'write',
  checks: 'write',
  metadata: 'read',
};

export function missingPermissions(
  granted: Record<string, string | undefined>,
): string[] {
  return Object.entries(REQUIRED_PERMISSIONS)
    .filter(
      ([name, needed]) =>
        !(
          granted[name] === 'write' ||
          (needed === 'read' && granted[name] === 'read')
        ),
    )
    .map(
      ([name, needed]) => `${name}: ${needed} (has ${granted[name] ?? 'none'})`,
    );
}

/**
 * Spec 3 "Startup" (G3): installation → permissions → bot identity → labels, before the worker starts
 * and the app listens. Any failure stops the process with one message; nothing is retried.
 */
@Injectable()
export class GitHubStartup implements OnModuleInit {
  private readonly logger = new Logger(GitHubStartup.name);

  constructor(
    private readonly github: GitHubClient,
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
  ) {}

  async onModuleInit(): Promise<void> {
    const repo = this.github.targetRepo;

    const installation = await this.step(() => this.github.connect(), {
      401: 'GitHub rejected the App credentials: check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH.',
      404:
        `The GitHub App is not installed on ${repo} (or the repo doesn't exist): ` +
        'install it (setup guide, step 4) or fix TARGET_REPO.',
    });

    const missing = missingPermissions(installation.permissions);
    if (missing.length > 0) {
      throw new GitHubStartupError(
        `The GitHub App is missing permissions on ${repo}: ${missing.join(', ')}. ` +
          'Fix them in the App settings, then accept the new permissions on the installation.',
      );
    }

    const bot = await this.step(() => this.github.identifyBot());

    await this.step(() => this.issues.ensureLabels(), {
      403: `GitHub refused to create a label on ${repo}: the App needs "issues: write".`,
    });

    this.logger.log(
      `GitHub ready: ${bot.login} on ${repo} (installation ${installation.id})`,
    );
  }

  /** Runs one startup step; a failure becomes a GitHubStartupError with the message for its status. */
  private async step<T>(
    run: () => Promise<T>,
    messages: Record<number, string> = {},
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw new GitHubStartupError(explain(error, messages), { cause: error });
    }
  }
}

function explain(error: unknown, messages: Record<number, string>): string {
  if (!(error instanceof ProviderError)) {
    return `GitHub startup failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const status = error.detail.status;
  if (status !== undefined && messages[status]) return messages[status];
  if (error.kind === 'transient' && (status === undefined || status >= 500)) {
    return `GitHub is unreachable (${error.message}); check the connection and start again.`;
  }
  return `GitHub startup failed: ${error.message}`;
}
