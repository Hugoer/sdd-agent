import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/contracts/provider-error.js';
import { ISSUE_PROVIDER } from '../src/contracts/issue-provider.js';
import { REPO_PROVIDER } from '../src/contracts/repo-provider.js';
import { GitHubStartupError } from '../src/github/github-startup.js';
import { STEPS, modelLabel } from '../src/github/labels.js';
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
      expect(t.issues.repoLabels).toHaveLength(18);
      expect(t.app.get(ISSUE_PROVIDER)).toBeInstanceOf(ScanningIssueProvider);
      expect(t.app.get(REPO_PROVIDER)).toBeInstanceOf(ScanningRepoProvider);
      expect(t.repo.calls).toEqual([]);
    } finally {
      await t.app.close();
    }
  });

  it('on a repo with the 11 labels of spec 3, adds the labels added since', async () => {
    const issues = new InMemoryIssueProvider(testEnv.TARGET_REPO);
    // Spec 3's eleven, named (so later specs' labels don't change this fixture).
    const old = [
      'status: draft',
      'status: grilling',
      'status: spec-review',
      'status: ready-for-dev',
      'status: executing',
      'status: in-review',
      'status: needs-human',
      'workflow: full-sdd',
      'workflow: spec-code',
      'workflow: code-only',
      'grill: skip',
    ];
    issues.repoLabels.push(...old);

    const t = await startApp({ issues });
    try {
      expect(old).toHaveLength(11);
      expect(t.issues.repoLabels).toEqual([
        ...old,
        'status: plan-review',
        'bot: working',
        ...STEPS.map(modelLabel),
      ]);
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
