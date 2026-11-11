import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/contracts/provider-error.js';
import { REPO_PROVIDER } from '../src/contracts/repo-provider.js';
import { GitHubStartupError } from '../src/github/github-startup.js';
import { startApp } from './app.js';
import { InMemoryIssueProvider } from './fakes/in-memory-issue-provider.js';
import { testEnv } from './test-env.js';

describe('GitHub startup (spec 3, offline)', () => {
  it('boots with the fakes and ensures the labels once', async () => {
    const t = await startApp();
    try {
      expect(t.issues.calls.map((call) => call.method)).toEqual([
        'ensureLabels',
      ]);
      expect(t.issues.repoLabels).toHaveLength(11);
      expect(t.app.get(REPO_PROVIDER)).toBe(t.repo);
      expect(t.repo.calls).toEqual([]);
    } finally {
      await t.app.close();
    }
  });

  it('does not start when the label bootstrap fails', async () => {
    const issues = new InMemoryIssueProvider(testEnv.TARGET_REPO);
    issues.failNext(
      new ProviderError(
        'GitHub POST /repos/o/r/labels → 403: Resource not accessible by integration',
        'permanent',
        {
          status: 403,
        },
      ),
    );

    const boot = startApp({ issues });

    await expect(boot).rejects.toBeInstanceOf(GitHubStartupError);
    await expect(boot).rejects.toThrow(/issues: write/);
  });
});
