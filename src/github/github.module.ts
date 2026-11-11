import { Module } from '@nestjs/common';
import { ISSUE_PROVIDER } from '../contracts/issue-provider.js';
import { GitHubClient } from './github-client.js';
import { GitHubIssueProvider } from './github-issue.provider.js';
import { GitHubStartup } from './github-startup.js';

/** GitHub behind the provider ports (spec 3). Exports only the tokens; Octokit stays in this folder. */
@Module({
  providers: [
    GitHubClient,
    GitHubIssueProvider,
    { provide: ISSUE_PROVIDER, useExisting: GitHubIssueProvider },
    GitHubStartup,
  ],
  exports: [ISSUE_PROVIDER],
})
export class GitHubModule {}
