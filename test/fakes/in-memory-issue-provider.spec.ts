import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/contracts/provider-error.js';
import { InMemoryIssueProvider } from './in-memory-issue-provider.js';

const REPO = 'test-owner/test-repo';

describe('InMemoryIssueProvider', () => {
  it('returns the seeded issue with its labels', async () => {
    const issues = new InMemoryIssueProvider(REPO);
    const task = issues.seedIssue({
      number: 7,
      labels: ['bug'],
      author: 'alice',
    });

    await expect(issues.getTaskDetails(task)).resolves.toMatchObject({
      platform: 'GITHUB',
      externalRef: `${REPO}#7`,
      labels: ['bug'],
      author: 'alice',
    });
  });

  it('throws a permanent 404 for an unknown issue', async () => {
    const issues = new InMemoryIssueProvider(REPO);
    const missing = {
      platform: 'GITHUB' as const,
      id: '1',
      externalRef: `${REPO}#99`,
    };

    await expect(issues.getTaskDetails(missing)).rejects.toMatchObject({
      kind: 'permanent',
      detail: { status: 404 },
    });
  });

  it('refuses a task of another repo', async () => {
    const issues = new InMemoryIssueProvider(REPO);
    const other = {
      platform: 'GITHUB' as const,
      id: '1',
      externalRef: 'someone/else#1',
    };

    await expect(issues.postComment(other, 'x')).rejects.toMatchObject({
      kind: 'permanent',
    });
  });

  it('posts a bot comment and reads it back; another issue sees null', async () => {
    const issues = new InMemoryIssueProvider(REPO);
    const task = issues.seedIssue({ number: 1 });
    const other = issues.seedIssue({ number: 2 });

    const ref = await issues.postComment(task, 'hello');

    await expect(issues.getComment(task, ref.id)).resolves.toMatchObject({
      body: 'hello',
    });
    await expect(issues.getComment(other, ref.id)).resolves.toBeNull();
    await expect(issues.getComment(task, 'nope')).resolves.toBeNull();
  });

  it('matches a marker only on bot comments, oldest first', async () => {
    const issues = new InMemoryIssueProvider(REPO);
    const task = issues.seedIssue({ number: 1 });
    issues.seedComment(task, { body: 'copied <!-- m1 -->', byBot: false });
    const first = await issues.postComment(task, 'a <!-- m1 -->');
    await issues.postComment(task, 'b <!-- m1 -->');

    await expect(
      issues.findCommentByMarker(task, '<!-- m1 -->'),
    ).resolves.toEqual(first);
    await expect(
      issues.findCommentByMarker(task, '<!-- m2 -->'),
    ).resolves.toBeNull();
  });

  it('throws on an empty marker', async () => {
    const issues = new InMemoryIssueProvider(REPO);
    const task = issues.seedIssue({ number: 1 });

    await expect(issues.findCommentByMarker(task, '')).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('sets one status label and keeps the other labels', async () => {
    const issues = new InMemoryIssueProvider(REPO);
    const task = issues.seedIssue({
      number: 1,
      labels: ['bug', 'status: draft', 'Status: Executing'],
    });

    await issues.setStatusLabel(task, 'grilling');

    expect(issues.labelsOf(task)).toEqual(['bug', 'status: grilling']);
  });

  it('removes only workflow and grill-skip labels; a missing one is fine', async () => {
    const issues = new InMemoryIssueProvider(REPO);
    const task = issues.seedIssue({
      number: 1,
      labels: ['bug', 'grill: skip', 'workflow: full-sdd'],
    });

    await issues.removeLabel(task, 'grill: skip');
    await issues.removeLabel(task, 'grill: skip');
    await issues.removeLabel(task, 'workflow: full-sdd');
    await expect(issues.removeLabel(task, 'bug')).rejects.toMatchObject({
      kind: 'permanent',
    });

    expect(issues.labelsOf(task)).toEqual(['bug']);
  });

  it('grants write access to admin and write only', async () => {
    const issues = new InMemoryIssueProvider(REPO);
    const task = issues.seedIssue({ number: 1 });
    issues.setPermission('admin-user', 'admin');
    issues.setPermission('writer', 'write');
    issues.setPermission('reader', 'read');

    await expect(issues.hasWriteAccess(task, 'admin-user')).resolves.toBe(true);
    await expect(issues.hasWriteAccess(task, 'writer')).resolves.toBe(true);
    await expect(issues.hasWriteAccess(task, 'reader')).resolves.toBe(false);
    await expect(issues.hasWriteAccess(task, 'stranger')).resolves.toBe(false);
  });

  it('reads lanes in fixed order, the skip modifier, and ignores case and unknown lanes', () => {
    const issues = new InMemoryIssueProvider(REPO);
    const task = (labels: string[]) => ({
      platform: 'GITHUB' as const,
      id: '1',
      externalRef: `${REPO}#1`,
      title: '',
      description: '',
      labels,
      author: 'a',
      url: '',
    });

    expect(issues.readControls(task([]))).toEqual({
      lanes: [],
      grillSkip: false,
    });
    expect(
      issues.readControls(
        task([
          'Workflow: Code-Only',
          'workflow: full-sdd',
          'workflow: other',
          'GRILL: SKIP',
        ]),
      ),
    ).toEqual({ lanes: ['full-sdd', 'code-only'], grillSkip: true });
  });

  it('creates the repo labels once', async () => {
    const issues = new InMemoryIssueProvider(REPO);

    await issues.ensureLabels();
    await issues.ensureLabels();

    expect(issues.repoLabels).toHaveLength(11);
  });

  it('records every call and fails the next one on demand', async () => {
    const issues = new InMemoryIssueProvider(REPO);
    const task = issues.seedIssue({ number: 1 });
    const error = new ProviderError('boom', 'transient');

    issues.failNext(error);

    await expect(issues.postComment(task, 'x')).rejects.toBe(error);
    await expect(issues.postComment(task, 'x')).resolves.toBeDefined();
    expect(issues.calls.map((call) => call.method)).toEqual([
      'postComment',
      'postComment',
    ]);
    expect(issues.commentsOf(task)).toHaveLength(1);
  });
});
