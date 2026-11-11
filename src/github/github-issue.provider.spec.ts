import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskRef, UnifiedTask } from '../contracts/issue-provider.js';
import {
  FakeGitHubFetch,
  TEST_APP_ID,
  TEST_REPO,
  connectedTestClient,
} from '../../test/fakes/fake-github-fetch.js';
import { GitHubIssueProvider } from './github-issue.provider.js';
import { BOT_LABELS } from './labels.js';

const LABELS = `/repos/${TEST_REPO}/labels`;
const ISSUE_5 = `/repos/${TEST_REPO}/issues/5`;
const COMMENTS_5 = `${ISSUE_5}/comments`;
const task5: TaskRef = {
  platform: 'GITHUB',
  id: '1005',
  externalRef: `${TEST_REPO}#5`,
};

afterEach(() => vi.restoreAllMocks());

async function providerWith(
  fake: FakeGitHubFetch,
): Promise<GitHubIssueProvider> {
  return new GitHubIssueProvider(await connectedTestClient(fake));
}

function postedLabelNames(fake: FakeGitHubFetch): string[] {
  return fake
    .to(LABELS, 'POST')
    .map((request) => (request.body as { name: string }).name);
}

describe('GitHubIssueProvider.ensureLabels', () => {
  it('creates every label of an empty repo with its color and description', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake
      .on('GET', LABELS, { body: [] })
      .on('POST', LABELS, { status: 201, body: {} });

    await issues.ensureLabels();

    expect(fake.to(LABELS, 'POST').map((request) => request.body)).toEqual(
      BOT_LABELS,
    );
  });

  it('creates only the missing labels, comparing names case-insensitively over all pages', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake
      .on('GET', LABELS, (request) =>
        request.query.get('page') === '2'
          ? { body: [{ name: 'Status: Grilling' }, { name: 'grill: skip' }] }
          : {
              body: [{ name: 'bug' }, { name: 'status: draft' }],
              headers: {
                link: `<https://api.github.com${LABELS}?per_page=100&page=2>; rel="next"`,
              },
            },
      )
      .on('POST', LABELS, { status: 201, body: {} });

    await issues.ensureLabels();

    expect(postedLabelNames(fake)).toEqual(
      BOT_LABELS.map((label) => label.name).filter(
        (name) =>
          !['status: draft', 'status: grilling', 'grill: skip'].includes(name),
      ),
    );
    expect(fake.to(LABELS, 'GET')).toHaveLength(2);
  });

  it('never edits or deletes a label', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', LABELS, {
      body: BOT_LABELS.map((label) => ({ ...label, color: '000000' })),
    });

    await issues.ensureLabels();

    expect(
      fake.requests.filter((request) =>
        ['PATCH', 'DELETE', 'POST'].includes(request.method),
      ),
    ).toEqual(fake.to(/access_tokens$/));
  });

  it('counts a label created meanwhile ("already exists") as present', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', LABELS, { body: [] }).on('POST', LABELS, {
      status: 422,
      body: {
        message: 'Validation Failed',
        errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }],
      },
    });

    await expect(issues.ensureLabels()).resolves.toBeUndefined();
  });

  it('throws a permanent error when GitHub refuses to create a label', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', LABELS, { body: [] }).on('POST', LABELS, {
      status: 403,
      body: { message: 'Resource not accessible by integration' },
    });

    await expect(issues.ensureLabels()).rejects.toMatchObject({
      kind: 'permanent',
      detail: { status: 403 },
    });
    expect(fake.to(LABELS, 'POST')).toHaveLength(1);
  });
});

describe('GitHubIssueProvider.readControls', () => {
  const issues = new GitHubIssueProvider(undefined as never);
  const task = (labels: string[]): UnifiedTask => ({
    platform: 'GITHUB',
    id: '1',
    externalRef: `${TEST_REPO}#1`,
    title: 't',
    description: '',
    labels,
    author: 'a',
    url: '',
  });

  it('finds no lane and no skip on a plain issue', () => {
    expect(issues.readControls(task(['bug']))).toEqual({
      lanes: [],
      grillSkip: false,
    });
  });

  it('finds one lane', () => {
    expect(issues.readControls(task(['workflow: spec-code']))).toEqual({
      lanes: ['spec-code'],
      grillSkip: false,
    });
  });

  it('returns two lanes in the fixed order', () => {
    expect(
      issues.readControls(task(['workflow: code-only', 'workflow: full-sdd']))
        .lanes,
    ).toEqual(['full-sdd', 'code-only']);
  });

  it('reads the skip modifier and ignores letter case', () => {
    expect(
      issues.readControls(task(['Workflow: Full-SDD', 'GRILL: Skip'])),
    ).toEqual({
      lanes: ['full-sdd'],
      grillSkip: true,
    });
  });

  it('ignores an unknown workflow label', () => {
    expect(issues.readControls(task(['workflow: yolo'])).lanes).toEqual([]);
  });
});

/** A comment as GitHub returns it; `app` is the App that wrote it (none for a human). */
function comment(
  id: number,
  body: string | null,
  { app, issue = 5 }: { app?: number; issue?: number } = {},
) {
  return {
    id,
    body,
    html_url: `https://github.com/${TEST_REPO}/issues/${issue}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/${TEST_REPO}/issues/${issue}`,
    created_at: `2026-11-11T10:00:${String(id % 60).padStart(2, '0')}Z`,
    user: { login: app ? 'test-app[bot]' : 'someone' },
    performed_via_github_app: app ? { id: app, slug: 'test-app' } : null,
  };
}

describe('GitHubIssueProvider.getTaskDetails', () => {
  it('maps the issue: ID as a string, label names, author and URL', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', ISSUE_5, {
      body: {
        id: 3456789012,
        number: 5,
        title: 'Add a dark mode',
        body: 'Please.',
        labels: [{ name: 'bug' }, { name: 'workflow: spec-code' }],
        user: { login: 'octocat' },
        html_url: `https://github.com/${TEST_REPO}/issues/5`,
      },
    });

    await expect(issues.getTaskDetails(task5)).resolves.toEqual({
      platform: 'GITHUB',
      id: '3456789012',
      externalRef: `${TEST_REPO}#5`,
      title: 'Add a dark mode',
      description: 'Please.',
      labels: ['bug', 'workflow: spec-code'],
      author: 'octocat',
      url: `https://github.com/${TEST_REPO}/issues/5`,
    });
    expect(fake.to(ISSUE_5)).toHaveLength(1);
  });

  it("gives '' for an issue without a body", async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', ISSUE_5, {
      body: {
        id: 1,
        title: 't',
        body: null,
        labels: [],
        user: { login: 'octocat' },
        html_url: 'u',
      },
    });

    const details = await issues.getTaskDetails(task5);

    expect(details.description).toBe('');
  });

  it('throws a permanent error for a missing issue', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', ISSUE_5, { status: 404, body: { message: 'Not Found' } });

    await expect(issues.getTaskDetails(task5)).rejects.toMatchObject({
      kind: 'permanent',
      detail: { status: 404 },
    });
  });
});

describe('GitHubIssueProvider.postComment', () => {
  it('sends the body unchanged and returns the new comment', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    const body = '<!-- sdd-agent:spec:v1 -->\n## Spec\n\n`code` & ünïcode ✓';
    fake.on('POST', COMMENTS_5, { status: 201, body: comment(91, body) });

    const posted = await issues.postComment(task5, body);

    expect(posted).toEqual({
      id: '91',
      url: `https://github.com/${TEST_REPO}/issues/5#issuecomment-91`,
      createdAt: new Date('2026-11-11T10:00:31Z'),
    });
    expect(fake.to(COMMENTS_5, 'POST').map((r) => r.body)).toEqual([{ body }]);
  });

  it('logs the issue and the comment ID, never the body', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('POST', COMMENTS_5, {
      status: 201,
      body: comment(92, 'secret-ish body'),
    });
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    await issues.postComment(task5, 'secret-ish body');

    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toEqual([expect.stringMatching(/#5.*92/)]);
    expect(lines.join()).not.toContain('secret-ish');
  });

  it('sends a comment that failed with a 500 only once', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('POST', COMMENTS_5, { status: 500, body: { message: 'boom' } });

    await expect(issues.postComment(task5, 'hi')).rejects.toMatchObject({
      kind: 'transient',
    });
    expect(fake.to(COMMENTS_5, 'POST')).toHaveLength(1);
  });
});

describe('GitHubIssueProvider.getComment', () => {
  const COMMENT_91 = `/repos/${TEST_REPO}/issues/comments/91`;

  it('returns the body and creation time of a comment on the issue', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', COMMENT_91, { body: comment(91, 'hello') });

    await expect(issues.getComment(task5, '91')).resolves.toEqual({
      body: 'hello',
      createdAt: new Date('2026-11-11T10:00:31Z'),
    });
  });

  it("gives '' for a comment without a body", async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', COMMENT_91, { body: comment(91, null) });

    await expect(issues.getComment(task5, '91')).resolves.toMatchObject({
      body: '',
    });
  });

  it('returns null for a comment that does not exist', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', COMMENT_91, { status: 404, body: { message: 'Not Found' } });

    await expect(issues.getComment(task5, '91')).resolves.toBeNull();
  });

  it('returns null for a comment of another issue', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', COMMENT_91, { body: comment(91, 'hello', { issue: 50 }) });

    await expect(issues.getComment(task5, '91')).resolves.toBeNull();
  });
});

describe('GitHubIssueProvider.findCommentByMarker', () => {
  const MARKER = '<!-- sdd-agent:hello:v1 -->';

  it("reads every page and returns the oldest of the App's own comments with the marker", async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', COMMENTS_5, (request) =>
      request.query.get('page') === '2'
        ? {
            body: [
              comment(140, `${MARKER} first`, { app: TEST_APP_ID }),
              comment(141, `${MARKER} second`, { app: TEST_APP_ID }),
            ],
          }
        : {
            body: [
              comment(101, `pasted by a human: ${MARKER}`),
              comment(102, `${MARKER} by another App`, { app: 1 }),
              comment(103, 'the App, no marker', { app: TEST_APP_ID }),
            ],
            headers: {
              link: `<https://api.github.com${COMMENTS_5}?per_page=100&page=2>; rel="next"`,
            },
          },
    );

    await expect(issues.findCommentByMarker(task5, MARKER)).resolves.toEqual({
      id: '140',
      url: `https://github.com/${TEST_REPO}/issues/5#issuecomment-140`,
      createdAt: new Date('2026-11-11T10:00:20Z'),
    });
    expect(fake.to(COMMENTS_5).map((r) => r.query.get('per_page'))).toEqual([
      '100',
      '100',
    ]);
  });

  it('returns null when no App comment holds the marker', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', COMMENTS_5, {
      body: [comment(101, `pasted by a human: ${MARKER}`)],
    });

    await expect(issues.findCommentByMarker(task5, MARKER)).resolves.toBeNull();
  });

  it('throws a permanent error for an empty marker, without a request', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);

    await expect(issues.findCommentByMarker(task5, '')).rejects.toMatchObject({
      kind: 'permanent',
    });
    expect(fake.to(/\/issues/)).toHaveLength(0);
  });
});

const ISSUE_5_LABELS = `${ISSUE_5}/labels`;

/** Method and decoded path of each request to issue #5's labels. */
function labelRequests(fake: FakeGitHubFetch): string[] {
  return fake
    .to(/\/issues\/5\/labels/)
    .map((r) => `${r.method} ${decodeURIComponent(r.path)}`);
}

const labelsOn5 = (...names: string[]) => ({
  body: names.map((name) => ({ name })),
});

describe('GitHubIssueProvider.setStatusLabel', () => {
  it('adds the new status label first, then removes the other status labels only', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake
      .on(
        'GET',
        ISSUE_5_LABELS,
        labelsOn5('bug', 'status: draft', 'Status: Grilling'),
      )
      .on('POST', ISSUE_5_LABELS, { body: [] })
      .on('DELETE', /\/issues\/5\/labels\/.+/, { body: [] });

    await issues.setStatusLabel(task5, 'spec-review');

    expect(labelRequests(fake)).toEqual([
      `GET ${ISSUE_5_LABELS}`,
      `POST ${ISSUE_5_LABELS}`,
      `DELETE ${ISSUE_5_LABELS}/status: draft`,
      `DELETE ${ISSUE_5_LABELS}/Status: Grilling`,
    ]);
    expect(fake.to(ISSUE_5_LABELS, 'POST')[0].body).toEqual({
      labels: ['status: spec-review'],
    });
  });

  it('writes nothing when the issue already has only that status (any case)', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', ISSUE_5_LABELS, labelsOn5('bug', 'Status: Executing'));

    await issues.setStatusLabel(task5, 'executing');

    expect(labelRequests(fake)).toEqual([`GET ${ISSUE_5_LABELS}`]);
  });

  it('reduces two status labels to one without adding (a crash left both)', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake
      .on('GET', ISSUE_5_LABELS, labelsOn5('status: draft', 'status: grilling'))
      .on('DELETE', /\/issues\/5\/labels\/.+/, { body: [] });

    await issues.setStatusLabel(task5, 'grilling');

    expect(labelRequests(fake)).toEqual([
      `GET ${ISSUE_5_LABELS}`,
      `DELETE ${ISSUE_5_LABELS}/status: draft`,
    ]);
  });

  it('removes nothing when adding the label fails', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake
      .on('GET', ISSUE_5_LABELS, labelsOn5('status: draft'))
      .on('POST', ISSUE_5_LABELS, { status: 500, body: { message: 'boom' } });

    await expect(
      issues.setStatusLabel(task5, 'grilling'),
    ).rejects.toMatchObject({ kind: 'transient' });
    expect(labelRequests(fake)).toEqual([
      `GET ${ISSUE_5_LABELS}`,
      `POST ${ISSUE_5_LABELS}`,
    ]);
  });
});

describe('GitHubIssueProvider.removeLabel', () => {
  it.each(['workflow: full-sdd', 'Workflow: Code-Only', 'grill: skip'])(
    'removes "%s" with one request',
    async (label) => {
      const fake = new FakeGitHubFetch();
      const issues = await providerWith(fake);
      fake.on('DELETE', /\/issues\/5\/labels\/.+/, { body: [] });

      await issues.removeLabel(task5, label);

      expect(labelRequests(fake)).toEqual([
        `DELETE ${ISSUE_5_LABELS}/${label}`,
      ]);
    },
  );

  it('succeeds when the label is not on the issue (404)', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('DELETE', /\/issues\/5\/labels\/.+/, {
      status: 404,
      body: { message: 'Label does not exist' },
    });

    await expect(
      issues.removeLabel(task5, 'grill: skip'),
    ).resolves.toBeUndefined();
  });

  it.each(['status: draft', 'bug', 'workflow', 'grill: skipped'])(
    'refuses "%s" without a request',
    async (label) => {
      const fake = new FakeGitHubFetch();
      const issues = await providerWith(fake);

      await expect(issues.removeLabel(task5, label)).rejects.toMatchObject({
        kind: 'permanent',
      });
      expect(fake.to(/\/issues/)).toHaveLength(0);
    },
  );

  it('throws on any other failure', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('DELETE', /\/issues\/5\/labels\/.+/, {
      status: 403,
      body: { message: 'Resource not accessible by integration' },
    });

    await expect(
      issues.removeLabel(task5, 'grill: skip'),
    ).rejects.toMatchObject({ kind: 'permanent', detail: { status: 403 } });
  });
});

describe('GitHubIssueProvider.hasWriteAccess', () => {
  const PERMISSION = `/repos/${TEST_REPO}/collaborators/octocat/permission`;

  it.each([
    ['admin', true],
    ['write', true],
    ['read', false],
    ['none', false],
  ])('%s → %s, with one request', async (permission, expected) => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', PERMISSION, { body: { permission } });

    await expect(issues.hasWriteAccess(task5, 'octocat')).resolves.toBe(
      expected,
    );
    expect(fake.to(PERMISSION)).toHaveLength(1);
  });

  it('no such user (404) → false', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', PERMISSION, { status: 404, body: { message: 'Not Found' } });

    await expect(issues.hasWriteAccess(task5, 'octocat')).resolves.toBe(false);
  });

  it('throws on a failure instead of answering false', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', PERMISSION, { status: 503, body: { message: 'down' } });

    await expect(issues.hasWriteAccess(task5, 'octocat')).rejects.toMatchObject(
      { kind: 'transient' },
    );
  });

  it('asks again on every call (no cache)', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', PERMISSION, { body: { permission: 'write' } });

    await issues.hasWriteAccess(task5, 'octocat');
    await issues.hasWriteAccess(task5, 'octocat');

    expect(fake.to(PERMISSION)).toHaveLength(2);
  });
});

describe('GitHubIssueProvider on another repo', () => {
  const elsewhere: TaskRef = {
    platform: 'GITHUB',
    id: '1',
    externalRef: 'someone/else#5',
  };

  it.each<[string, (issues: GitHubIssueProvider) => Promise<unknown>]>([
    ['getTaskDetails', (issues) => issues.getTaskDetails(elsewhere)],
    ['postComment', (issues) => issues.postComment(elsewhere, 'hi')],
    ['getComment', (issues) => issues.getComment(elsewhere, '91')],
    [
      'findCommentByMarker',
      (issues) => issues.findCommentByMarker(elsewhere, 'm'),
    ],
    ['setStatusLabel', (issues) => issues.setStatusLabel(elsewhere, 'draft')],
    ['removeLabel', (issues) => issues.removeLabel(elsewhere, 'grill: skip')],
    ['hasWriteAccess', (issues) => issues.hasWriteAccess(elsewhere, 'octocat')],
  ])('%s throws a permanent error and sends nothing', async (_name, call) => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);

    await expect(call(issues)).rejects.toMatchObject({ kind: 'permanent' });
    expect(fake.to(/\/issues/)).toHaveLength(0);
  });
});
