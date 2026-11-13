import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/contracts/provider-error.js';
import { ISSUE_PROVIDER } from '../src/contracts/issue-provider.js';
import { REPO_PROVIDER } from '../src/contracts/repo-provider.js';
import { GitHubStartupError } from '../src/github/github-startup.js';
import { BOT_LABELS, STEPS, modelLabel } from '../src/github/labels.js';
import { ScanningIssueProvider } from '../src/secret-scan/scanning-issue.provider.js';
import { ScanningRepoProvider } from '../src/secret-scan/scanning-repo.provider.js';
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
      expect(t.issues.repoLabels).toHaveLength(16);
      expect(t.app.get(ISSUE_PROVIDER)).toBeInstanceOf(ScanningIssueProvider);
      expect(t.app.get(REPO_PROVIDER)).toBeInstanceOf(ScanningRepoProvider);
      expect(t.repo.calls).toEqual([]);
    } finally {
      await t.app.close();
    }
  });

  it('on a repo with the 11 labels of spec 3, adds the five model labels', async () => {
    const issues = new InMemoryIssueProvider(testEnv.TARGET_REPO);
    const old = BOT_LABELS.map((label) => label.name).filter(
      (name) => !name.startsWith('model: '),
    );
    issues.repoLabels.push(...old);

    const t = await startApp({ issues });
    try {
      expect(old).toHaveLength(11);
      expect(t.issues.repoLabels).toEqual([...old, ...STEPS.map(modelLabel)]);
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
