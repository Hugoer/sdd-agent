import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/contracts/provider-error.js';
import { InMemoryRepoProvider } from './in-memory-repo-provider.js';

const REPO = 'test-owner/test-repo';

describe('InMemoryRepoProvider', () => {
  it('reads a file; a missing path or a directory is null', async () => {
    const repo = new InMemoryRepoProvider(REPO);
    repo.seedFile('main', '.github-agent/workflow.json', '{ "skills": {} }');

    await expect(
      repo.readFile('main', '.github-agent/workflow.json'),
    ).resolves.toBe('{ "skills": {} }');
    await expect(repo.readFile('main', 'missing.md')).resolves.toBeNull();
    await expect(repo.readFile('main', '.github-agent')).resolves.toBeNull();
  });

  it('throws a permanent error for an unknown ref or an unsafe path', async () => {
    const repo = new InMemoryRepoProvider(REPO);
    repo.seedFile('main', 'a.md', 'a');

    await expect(repo.readFile('nope', 'a.md')).rejects.toMatchObject({
      kind: 'permanent',
    });
    await expect(repo.listFiles('nope', 'skills')).rejects.toMatchObject({
      kind: 'permanent',
    });
    await expect(repo.readFile('main', '/a.md')).rejects.toMatchObject({
      kind: 'permanent',
    });
    await expect(repo.readFile('main', 'skills/../a.md')).rejects.toMatchObject(
      { kind: 'permanent' },
    );
  });

  it('lists every file under a directory at any depth, sorted, with the executable flag', async () => {
    const repo = new InMemoryRepoProvider(REPO);
    repo.seedFile('main', 'skills/spec/scripts/run.sh', 'echo', {
      executable: true,
    });
    repo.seedFile('main', 'skills/spec/SKILL.md', '# Spec');
    repo.seedFile('main', 'skills/spec/references/a.md', 'é');
    repo.seedFile('main', 'skills/specs-other/x.md', 'x');

    await expect(repo.listFiles('main', 'skills/spec')).resolves.toEqual([
      { path: 'skills/spec/SKILL.md', size: 6, executable: false },
      { path: 'skills/spec/references/a.md', size: 2, executable: false },
      { path: 'skills/spec/scripts/run.sh', size: 4, executable: true },
    ]);
    await expect(repo.listFiles('main', 'skills/missing')).resolves.toBeNull();
    await expect(
      repo.listFiles('main', 'skills/spec/SKILL.md'),
    ).resolves.toBeNull();
  });

  it('gives a new push token on every call', async () => {
    const repo = new InMemoryRepoProvider(REPO);

    const first = await repo.getPushCredentials();
    const second = await repo.getPushCredentials();

    expect(first.token).not.toBe(second.token);
    expect(first.remoteUrl).toBe(`https://github.com/${REPO}.git`);
  });

  it('opens a PR, finds it, and refuses a second open one for the branch', async () => {
    const repo = new InMemoryRepoProvider(REPO);

    const pr = await repo.openPullRequest('agent/1', 'main', 'T', 'B');

    await expect(repo.findPullRequest('agent/1')).resolves.toEqual(pr);
    await expect(
      repo.openPullRequest('agent/1', 'main', 'T', 'B'),
    ).rejects.toMatchObject({
      kind: 'permanent',
      detail: { status: 422 },
    });
  });

  it('ignores a human PR from the same branch', async () => {
    const repo = new InMemoryRepoProvider(REPO);
    repo.seedPullRequest('agent/1', { byBot: false });

    await expect(repo.findPullRequest('agent/1')).resolves.toBeNull();
  });

  it('keeps one check run per commit', async () => {
    const repo = new InMemoryRepoProvider(REPO);
    const pr = await repo.openPullRequest('agent/1', 'main', 'T', 'B');

    await repo.setQualityResult(pr, 'sha1', 'neutral', 'first');
    await repo.setQualityResult(pr, 'sha1', 'success', 'second');
    await repo.setQualityResult(pr, 'sha2', 'failure', 'third');

    expect(repo.checkRuns).toEqual([
      { sha: 'sha1', conclusion: 'success', summary: 'second' },
      { sha: 'sha2', conclusion: 'failure', summary: 'third' },
    ]);
  });

  it('records every call and fails the next one on demand', async () => {
    const repo = new InMemoryRepoProvider(REPO);
    const error = new ProviderError('rate limited', 'transient', {
      retryAfterSeconds: 60,
    });

    repo.failNext(error);

    await expect(repo.getPushCredentials()).rejects.toBe(error);
    await expect(repo.getPushCredentials()).resolves.toBeDefined();
    expect(repo.calls.map((call) => call.method)).toEqual([
      'getPushCredentials',
      'getPushCredentials',
    ]);
  });
});
