import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryIssueProvider } from '../../../test/fakes/in-memory-issue-provider.js';
import { InMemoryRepoProvider } from '../../../test/fakes/in-memory-repo-provider.js';
import type { TaskRef } from '../../contracts/issue-provider.js';
import { ProviderError } from '../../contracts/provider-error.js';
import { runSmoke } from './run-smoke.js';

const REPO = 'test-owner/test-repo';

afterEach(() => vi.restoreAllMocks());

/**
 * The matrix preconditions: an issue with `grill: skip` and `bug`, opened by a developer with write access;
 * `.github-agent/workflow.json` and `smoke-skill/` on main.
 */
function setup(
  options: {
    dir?: string;
    commentStatus?: number;
    branch?: string;
    sha?: string;
  } = {},
) {
  const issues = new InMemoryIssueProvider(REPO);
  const task: TaskRef = issues.seedIssue({
    number: 5,
    title: 'Smoke target',
    labels: ['grill: skip', 'bug'],
    author: 'dev',
  });
  issues.setPermission('dev', 'admin');
  const repo = new InMemoryRepoProvider(REPO);
  repo.seedFile('main', '.github-agent/workflow.json', '{"steps":{}}');
  repo.seedFile('main', 'smoke-skill/SKILL.md', '# Smoke skill\n');
  repo.seedFile('main', 'smoke-skill/references/a.md', 'A\n');
  repo.seedFile('main', 'smoke-skill/scripts/run.sh', 'echo hi\n', {
    executable: true,
  });
  // Stands in for api.github.com: the comment attempt made with the push token.
  const fetchCalls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({
      url: url instanceof Request ? url.url : url.toString(),
      init,
    });
    return Promise.resolve(
      new Response('{}', { status: options.commentStatus ?? 403 }),
    );
  };
  const lines: string[] = [];
  const run = (runId = 'run-1') =>
    runSmoke(
      { issues, repo, fetch },
      {
        targetRepo: REPO,
        issue: 5,
        runId,
        base: 'main',
        dir: options.dir ?? '.github-agent',
        branch: options.branch,
        sha: options.sha,
      },
      (line) => lines.push(line),
    );
  return { issues, repo, task, lines, run, fetchCalls };
}

const statusLabels = (labels: string[]) =>
  labels.filter((label) => label.startsWith('status: '));

describe('runSmoke (issue checks)', () => {
  it('passes every check against the fake and leaves the issue as the matrix expects', async () => {
    const { issues, task, lines, run } = setup();

    await expect(run()).resolves.toBe(true);

    expect(lines.length).toBeGreaterThanOrEqual(12);
    expect(lines.filter((line) => !line.startsWith('PASS '))).toEqual([]);
    expect(issues.labelsOf(task).sort()).toEqual([
      'bug',
      'status: spec-review',
    ]);
    expect(issues.commentsOf(task)).toEqual([
      expect.objectContaining({
        byBot: true,
        body: expect.stringContaining(
          '<!-- sdd-agent:smoke:run-1 -->',
        ) as string,
      }),
    ]);
    expect(lines).toContainEqual(expect.stringMatching(/dev.*true/));
    expect(lines).toContainEqual(expect.stringMatching(/octocat.*false/));
  });

  it('passes again on a second run: still one status label, one more comment', async () => {
    const { issues, task, run } = setup();

    await run('run-1');
    await expect(run('run-2')).resolves.toBe(true);

    expect(statusLabels(issues.labelsOf(task))).toEqual([
      'status: spec-review',
    ]);
    expect(issues.commentsOf(task)).toHaveLength(2);
  });

  it('reports a provider error as FAIL with its message and stops', async () => {
    const { issues, lines, run } = setup();
    issues.failNext(
      new ProviderError('GitHub GET … → 404: Not Found', 'permanent', {
        status: 404,
      }),
    );

    await expect(run()).resolves.toBe(false);

    expect(lines[0]).toBe('FAIL getTaskDetails: GitHub GET … → 404: Not Found');
    // Only the issue group stops; the other groups still run.
    expect(lines.slice(1).every((line) => line.startsWith('PASS '))).toBe(true);
    expect(lines.some((line) => line.includes('postComment'))).toBe(false);
  });

  it('reports FAIL when the marker search misses the posted comment', async () => {
    const { issues, lines, run } = setup();
    vi.spyOn(issues, 'findCommentByMarker').mockResolvedValue(null);

    await expect(run()).resolves.toBe(false);

    expect(lines).toContainEqual(
      expect.stringMatching(/^FAIL findCommentByMarker: .*null/),
    );
  });

  it('reports FAIL when removeLabel("bug") is not refused', async () => {
    const { issues, lines, run } = setup();
    const removeLabel = issues.removeLabel.bind(issues);
    vi.spyOn(issues, 'removeLabel').mockImplementation((task, label) =>
      label === 'bug' ? Promise.resolve() : removeLabel(task, label),
    );

    await expect(run()).resolves.toBe(false);

    expect(lines).toContainEqual(
      expect.stringMatching(/^FAIL removeLabel bug/),
    );
  });

  it('reports FAIL when octocat has write access', async () => {
    const { issues, lines, run } = setup();
    issues.setPermission('octocat', 'write');

    await expect(run()).resolves.toBe(false);

    expect(lines).toContainEqual(
      expect.stringMatching(/^FAIL hasWriteAccess octocat/),
    );
  });
});

describe('runSmoke (repo checks)', () => {
  it('prints the file, the null cases, the unknown-ref error and the listing', async () => {
    const { lines, run } = setup();

    await expect(run()).resolves.toBe(true);

    expect(
      lines.filter((line) => /^PASS (readFile|listFiles)/.test(line)),
    ).toEqual([
      'PASS readFile main:.github-agent/workflow.json: 12 B: {"steps":{}}',
      'PASS readFile (missing file): main:.github-agent/no-such-file-run-1.md → null',
      'PASS readFile (unknown ref): no-such-ref-run-1:.github-agent/workflow.json → error: unknown ref "no-such-ref-run-1"',
      'PASS listFiles main:.github-agent: 1 file: .github-agent/workflow.json (12 B)',
      'PASS listFiles (missing directory): main:no-such-dir-run-1 → null',
    ]);
  });

  it('lists a nested skill directory with the executable bit', async () => {
    const { lines, run } = setup({ dir: 'smoke-skill' });

    await expect(run()).resolves.toBe(true);

    expect(lines).toContainEqual(
      'PASS listFiles main:smoke-skill: 3 files: smoke-skill/SKILL.md (14 B), smoke-skill/references/a.md (2 B), smoke-skill/scripts/run.sh (8 B, executable)',
    );
  });

  it('reports FAIL when the directory to list is missing', async () => {
    const { lines, run } = setup({ dir: 'no-such-skill' });

    await expect(run()).resolves.toBe(false);

    expect(lines).toContainEqual(
      expect.stringMatching(/^FAIL listFiles main:no-such-skill: .*null/),
    );
  });

  it('reports FAIL when an unknown ref is not an error', async () => {
    const { repo, lines, run } = setup();
    const readFile = repo.readFile.bind(repo);
    vi.spyOn(repo, 'readFile').mockImplementation((ref, path) =>
      ref === 'main' ? readFile(ref, path) : Promise.resolve(null),
    );

    await expect(run()).resolves.toBe(false);

    expect(lines).toContainEqual(
      expect.stringMatching(/^FAIL readFile \(unknown ref\)/),
    );
  });
});

describe('runSmoke (push credentials)', () => {
  it('shows the identity, two different tokens by length only, and a refused comment', async () => {
    const { lines, run, fetchCalls } = setup();

    await expect(run()).resolves.toBe(true);

    expect(lines).toContainEqual(
      expect.stringMatching(
        /^PASS getPushCredentials \(twice\): test-app\[bot\] <1\+test-app\[bot\]@users\.noreply\.github\.com>, https:\/\/github\.com\/test-owner\/test-repo\.git, expires in (59|60) min, two different tokens \(17 and 17 chars\)$/,
      ),
    );
    expect(lines).toContainEqual(
      'PASS push token cannot comment (403): GitHub answered 403',
    );
    expect(lines.join('\n')).not.toContain('fake-push-token');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      'https://api.github.com/repos/test-owner/test-repo/issues/5/comments',
    );
    expect(fetchCalls[0].init?.method).toBe('POST');
    expect(new Headers(fetchCalls[0].init?.headers).get('authorization')).toBe(
      'token fake-push-token-2',
    );
  });

  it('reports FAIL when the push token could comment', async () => {
    const { lines, run } = setup({ commentStatus: 201 });

    await expect(run()).resolves.toBe(false);

    expect(lines).toContainEqual(
      'FAIL push token cannot comment (403): GitHub answered 201',
    );
  });

  it('reports FAIL when two calls give the same token', async () => {
    const { repo, lines, run } = setup();
    const same = await repo.getPushCredentials();
    vi.spyOn(repo, 'getPushCredentials').mockResolvedValue(same);

    await expect(run()).resolves.toBe(false);

    expect(lines).toContainEqual(
      expect.stringMatching(
        /^FAIL getPushCredentials \(twice\): the same token twice$/,
      ),
    );
  });
});

describe('runSmoke (pull request)', () => {
  const SHA = 'b'.repeat(40);

  it('is skipped without --branch and --sha', async () => {
    const { repo, lines, run } = setup();

    await expect(run()).resolves.toBe(true);

    expect(lines.some((line) => /PullRequest|QualityResult/.test(line))).toBe(
      false,
    );
    expect(repo.pullRequests).toEqual([]);
  });

  it('opens the PR once over two runs, comments each time, and leaves one Quality Gate run at success', async () => {
    const { repo, lines, run } = setup({ branch: 'smoke/spec-3', sha: SHA });

    await expect(run('run-1')).resolves.toBe(true);
    await expect(run('run-2')).resolves.toBe(true);

    expect(repo.pullRequests).toHaveLength(1);
    expect(repo.pullRequestComments).toHaveLength(2);
    expect(repo.checkRuns).toEqual([
      expect.objectContaining({ sha: SHA, conclusion: 'success' }),
    ]);
    expect(lines).toContainEqual(
      expect.stringMatching(/^PASS openPullRequest \(if missing\): opened #1 /),
    );
    expect(lines).toContainEqual(
      'PASS openPullRequest (if missing): not needed: #1 exists',
    );
  });

  it('reports FAIL when the opened PR is not found again', async () => {
    const { repo, lines, run } = setup({ branch: 'smoke/spec-3', sha: SHA });
    vi.spyOn(repo, 'findPullRequest').mockResolvedValue(null);

    await expect(run()).resolves.toBe(false);

    expect(lines).toContainEqual(
      'FAIL findPullRequest (again): expected #1, got null',
    );
  });
});
