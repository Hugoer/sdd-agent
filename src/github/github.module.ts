import { Module } from '@nestjs/common';
import { ISSUE_PROVIDER } from '../contracts/issue-provider.js';
import { REPO_PROVIDER } from '../contracts/repo-provider.js';
import { GitHubClient } from './github-client.js';
import { GitHubIssueProvider } from './github-issue.provider.js';
import { GitHubRepoProvider } from './github-repo.provider.js';
import { GitHubStartup } from './github-startup.js';

/** GitHub behind the provider ports (spec 3). Exports only the tokens; Octokit stays in this folder. */
@Module({
  providers: [
    GitHubClient,
    GitHubIssueProvider,
    { provide: ISSUE_PROVIDER, useExisting: GitHubIssueProvider },
    GitHubRepoProvider,
    { provide: REPO_PROVIDER, useExisting: GitHubRepoProvider },
    GitHubStartup,
  ],
  exports: [ISSUE_PROVIDER, REPO_PROVIDER],
})
export class GitHubModule {}
