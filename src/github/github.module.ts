import { Module } from '@nestjs/common';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
} from '../contracts/issue-provider.js';
import {
  REPO_PROVIDER,
  type RepoProvider,
} from '../contracts/repo-provider.js';
import { ScanningIssueProvider } from '../secret-scan/scanning-issue.provider.js';
import { ScanningRepoProvider } from '../secret-scan/scanning-repo.provider.js';
import { SecretScanModule } from '../secret-scan/secret-scan.module.js';
import { SecretScanner } from '../secret-scan/secret-scanner.js';
import { GitHubClient } from './github-client.js';
import { GitHubIssueProvider } from './github-issue.provider.js';
import { GitHubRepoProvider } from './github-repo.provider.js';
import { GitHubStartup } from './github-startup.js';

/**
 * GitHub behind the provider ports (spec 3). Exports only the tokens; Octokit stays in this folder. Both tokens
 * are the adapters wrapped by the secret scanner (spec 4, LW4, plan P4): no caller gets an unscanned port.
 */
@Module({
  imports: [SecretScanModule],
  providers: [
    GitHubClient,
    GitHubIssueProvider,
    GitHubRepoProvider,
    {
      provide: ISSUE_PROVIDER,
      useFactory: (issues: IssueProvider, scanner: SecretScanner) =>
        new ScanningIssueProvider(issues, scanner),
      inject: [GitHubIssueProvider, SecretScanner],
    },
    {
      provide: REPO_PROVIDER,
      useFactory: (repo: RepoProvider, scanner: SecretScanner) =>
        new ScanningRepoProvider(repo, scanner),
      inject: [GitHubRepoProvider, SecretScanner],
    },
    GitHubStartup,
  ],
  exports: [ISSUE_PROVIDER, REPO_PROVIDER],
})
export class GitHubModule {}
