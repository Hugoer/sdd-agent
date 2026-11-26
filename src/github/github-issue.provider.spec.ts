import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskRef, UnifiedTask } from '../contracts/issue-provider.js';
import {
  FakeGitHubFetch,
  TEST_APP_ID,
  TEST_REPO,
  TEST_SLUG,
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

/** A label as GitHub lists it, with BOT_LABELS' description (spec 13: a differing one is updated). */
function listed(name: string): { name: string; description: string | null } {
  const label = BOT_LABELS.find(
    (item) => item.name.toLowerCase() === name.toLowerCase(),
  );
  return { name, description: label?.description ?? null };
}

const LABEL_PATCH = new RegExp(`^${LABELS}/`);

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
          ? { body: [listed('Status: Grilling'), listed('grill: skip')] }
          : {
              body: [listed('bug'), listed('status: draft')],
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

  it('never edits a colour or a name, never deletes a label', async () => {
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

  it("updates only a bot-managed label's differing description (spec 13 BFW7), description only", async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    // Spec 4's 16 labels with their old descriptions: ready-for-dev's differs, the two new labels are missing.
    const before = BOT_LABELS.filter(
      (label) => !['status: plan-review', 'bot: working'].includes(label.name),
    ).map((label) =>
      label.name === 'status: ready-for-dev'
        ? {
            ...label,
            color: '0e8a17',
            description:
              'Bot-managed: waiting for /approve to start the Coder.',
          }
        : label.name === 'grill: skip'
          ? { ...label, description: 'A team wrote its own text.' }
          : label.name === 'status: draft'
            ? { ...label, description: null }
            : label,
    );
    fake
      .on('GET', LABELS, { body: before })
      .on('POST', LABELS, { status: 201, body: {} })
      .on('PATCH', LABEL_PATCH, { body: {} });

    await issues.ensureLabels();

    expect(postedLabelNames(fake)).toEqual([
      'status: plan-review',
      'bot: working',
    ]);
    expect(
      fake
        .to(LABEL_PATCH, 'PATCH')
        .map((request) => [
          decodeURIComponent(request.path.slice(LABELS.length + 1)),
          request.body,
        ]),
    ).toEqual([
      ['status: draft', { description: listed('status: draft').description }],
      [
        'status: ready-for-dev',
        { description: listed('status: ready-for-dev').description },
      ],
    ]);
    expect(fake.requests.some((request) => request.method === 'DELETE')).toBe(
      false,
    );
    expect(log).toHaveBeenCalledWith(
      `Labels on ${TEST_REPO}: 2 created, 2 updated, 14 already present`,
    );
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
    open: true,
  });

  it('finds no lane and no skip on a plain issue', () => {
    expect(issues.readControls(task(['bug']))).toEqual({
      lanes: [],
      grillSkip: false,
      maxModelSteps: [],
    });
  });

  it('finds one lane', () => {
    expect(issues.readControls(task(['workflow: spec-code']))).toEqual({
      lanes: ['spec-code'],
      grillSkip: false,
      maxModelSteps: [],
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
      maxModelSteps: [],
    });
  });

  it('ignores an unknown workflow label', () => {
    expect(issues.readControls(task(['workflow: yolo'])).lanes).toEqual([]);
  });

  it('lists the steps of the model labels in the fixed step order, in any letter case', () => {
    expect(
      issues.readControls(
        task([
          'model: max-quality-gate',
          'Model: Max-Spec',
          'model: turbo',
          'model: max-qualityGate',
          'workflow: spec-code',
          'MODEL: MAX-GRILL',
          'grill: skip',
        ]),
      ),
    ).toEqual({
      lanes: ['spec-code'],
      grillSkip: true,
      maxModelSteps: ['grill', 'spec', 'qualityGate'],
    });
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
        state: 'open',
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
      open: true,
    });
    expect(fake.to(ISSUE_5)).toHaveLength(1);
  });

  it('maps a closed issue to open: false', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', ISSUE_5, {
      body: {
        id: 1,
        title: 't',
        body: 'b',
        labels: [],
        user: { login: 'octocat' },
        html_url: 'u',
        state: 'closed',
      },
    });

    const details = await issues.getTaskDetails(task5);

    expect(details.open).toBe(false);
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
  it.each([
    'workflow: full-sdd',
    'Workflow: Code-Only',
    'grill: skip',
    'model: max-grill',
    'model: max-spec',
    'model: max-plan',
    'model: max-code',
    'Model: Max-Quality-Gate',
  ])('removes "%s" with one request', async (label) => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('DELETE', /\/issues\/5\/labels\/.+/, { body: [] });

    await issues.removeLabel(task5, label);

    expect(labelRequests(fake)).toEqual([`DELETE ${ISSUE_5_LABELS}/${label}`]);
  });

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

  it.each([
    'status: draft',
    'bot: working',
    'bug',
    'workflow',
    'grill: skipped',
    'model: turbo',
    'model: max-',
    'model: max-qualityGate',
  ])('refuses "%s" without a request', async (label) => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);

    await expect(issues.removeLabel(task5, label)).rejects.toMatchObject({
      kind: 'permanent',
    });
    expect(fake.to(/\/issues/)).toHaveLength(0);
  });

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

describe('GitHubIssueProvider.acknowledgeComment', () => {
  const REACTIONS_91 = `/repos/${TEST_REPO}/issues/comments/91/reactions`;
  /** The bot's login is known after `identifyBot()` (startup), as in production. */
  async function identified(fake: FakeGitHubFetch) {
    const client = await connectedTestClient(fake);
    await client.identifyBot();
    return new GitHubIssueProvider(client);
  }

  it.each([201, 200])(
    'adds an eyes reaction to the comment (%i)',
    async (status) => {
      const fake = new FakeGitHubFetch();
      const issues = await providerWith(fake);
      fake
        .on('POST', REACTIONS_91, { status, body: { content: 'eyes' } })
        .on('GET', REACTIONS_91, { body: [] });

      await expect(
        issues.acknowledgeComment(task5, '91'),
      ).resolves.toBeUndefined();

      expect(fake.to(REACTIONS_91, 'POST').map((r) => r.body)).toEqual([
        { content: 'eyes' },
      ]);
      // Spec 13 BFW5: the bot's 🚀 is looked up; none → no DELETE.
      expect(
        fake.to(REACTIONS_91, 'GET').map((r) => r.query.get('content')),
      ).toEqual(['rocket']);
      expect(fake.requests.some((r) => r.method === 'DELETE')).toBe(false);
    },
  );

  it("removes only the bot's own 🚀, over all pages; a person's 🚀 stays (spec 13 BFW5)", async () => {
    const fake = new FakeGitHubFetch();
    const issues = await identified(fake);
    fake
      .on('POST', REACTIONS_91, { status: 201, body: { content: 'eyes' } })
      .on('GET', REACTIONS_91, (request) =>
        request.query.get('page') === '2'
          ? {
              body: [
                {
                  id: 702,
                  content: 'rocket',
                  user: { login: 'Test-App[bot]' },
                },
              ],
            }
          : {
              body: [
                { id: 701, content: 'rocket', user: { login: 'octocat' } },
              ],
              headers: {
                link: `<https://api.github.com${REACTIONS_91}?content=rocket&per_page=100&page=2>; rel="next"`,
              },
            },
      )
      .on('DELETE', `${REACTIONS_91}/702`, { status: 204 });

    await issues.acknowledgeComment(task5, '91');

    expect(
      fake.requests.filter((r) => r.method === 'DELETE').map((r) => r.path),
    ).toEqual([`${REACTIONS_91}/702`]);
  });

  it.each([
    ['the lookup', 'GET'],
    ['the delete', 'DELETE'],
  ])('a 404 at %s counts as already gone', async (_step, method) => {
    const fake = new FakeGitHubFetch();
    const issues = await identified(fake);
    const gone = { status: 404, body: { message: 'Not Found' } };
    fake
      .on('POST', REACTIONS_91, { status: 201, body: { content: 'eyes' } })
      .on(
        'GET',
        REACTIONS_91,
        method === 'GET'
          ? gone
          : {
              body: [
                {
                  id: 702,
                  content: 'rocket',
                  user: { login: 'test-app[bot]' },
                },
              ],
            },
      )
      .on('DELETE', `${REACTIONS_91}/702`, gone);

    await expect(
      issues.acknowledgeComment(task5, '91'),
    ).resolves.toBeUndefined();
  });

  it('succeeds when the comment no longer exists (404), and sends nothing more', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('POST', REACTIONS_91, {
      status: 404,
      body: { message: 'Not Found' },
    });

    await expect(
      issues.acknowledgeComment(task5, '91'),
    ).resolves.toBeUndefined();
    expect(fake.to(REACTIONS_91).map((r) => r.method)).toEqual(['POST']);
  });

  it.each([
    [500, 'transient'],
    [403, 'permanent'],
  ])('throws on a %i (%s)', async (status, kind) => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('POST', REACTIONS_91, { status, body: { message: 'boom' } });

    await expect(issues.acknowledgeComment(task5, '91')).rejects.toMatchObject({
      kind,
      detail: { status },
    });
    expect(fake.to(REACTIONS_91, 'POST')).toHaveLength(1);
  });
});

describe('GitHubIssueProvider.reactWorking (spec 13)', () => {
  const REACTIONS_91 = `/repos/${TEST_REPO}/issues/comments/91/reactions`;

  it.each([201, 200])('adds a rocket reaction (%i)', async (status) => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('POST', REACTIONS_91, { status, body: { content: 'rocket' } });

    await expect(issues.reactWorking(task5, '91')).resolves.toBeUndefined();

    expect(fake.to(REACTIONS_91, 'POST').map((r) => r.body)).toEqual([
      { content: 'rocket' },
    ]);
  });

  it('skips a comment that no longer exists (404), with a log line', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    fake.on('POST', REACTIONS_91, {
      status: 404,
      body: { message: 'Not Found' },
    });

    await expect(issues.reactWorking(task5, '91')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      `reactWorking ${TEST_REPO}#5 → comment 91 (gone)`,
    );
  });

  it.each([
    [500, 'transient'],
    [403, 'permanent'],
  ])('throws on a %i (%s)', async (status, kind) => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('POST', REACTIONS_91, { status, body: { message: 'boom' } });

    await expect(issues.reactWorking(task5, '91')).rejects.toMatchObject({
      kind,
      detail: { status },
    });
  });
});

describe('GitHubIssueProvider.setWorkingLabel (spec 13)', () => {
  const WORKING = `${ISSUE_5}/labels/${encodeURIComponent('bot: working')}`;

  it('true adds bot: working with one request', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('POST', `${ISSUE_5}/labels`, { body: [] });

    await issues.setWorkingLabel(task5, true);

    expect(fake.to(`${ISSUE_5}/labels`, 'POST').map((r) => r.body)).toEqual([
      { labels: ['bot: working'] },
    ]);
  });

  it.each([
    [200, { body: [] }],
    [404, { status: 404, body: { message: 'Label does not exist' } }],
  ])('false removes it (%i counts as removed)', async (_status, answer) => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('DELETE', WORKING, answer);

    await expect(issues.setWorkingLabel(task5, false)).resolves.toBeUndefined();
    expect(fake.to(WORKING, 'DELETE')).toHaveLength(1);
  });

  it.each([true, false])('throws on a 500 (shown %s)', async (shown) => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake
      .on('POST', `${ISSUE_5}/labels`, { status: 500, body: {} })
      .on('DELETE', WORKING, { status: 500, body: {} });

    await expect(issues.setWorkingLabel(task5, shown)).rejects.toMatchObject({
      kind: 'transient',
    });
  });
});

describe('GitHubIssueProvider.getAccessLevel', () => {
  const PERMISSION = `/repos/${TEST_REPO}/collaborators/octocat/permission`;
  /** GitHub's answer shape: `permission` is the legacy level, `user.permissions` the role flags. */
  const answer = (
    permission: string,
    role: string,
    flags: Partial<
      Record<'admin' | 'maintain' | 'push' | 'triage' | 'pull', boolean>
    >,
  ) => ({
    permission,
    role_name: role,
    user: {
      login: 'octocat',
      permissions: {
        admin: false,
        maintain: false,
        push: false,
        triage: false,
        pull: false,
        ...flags,
      },
    },
  });
  const all = {
    admin: true,
    maintain: true,
    push: true,
    triage: true,
    pull: true,
  };

  it.each([
    ['admin', answer('admin', 'admin', all), 'approver'],
    [
      'maintain (reported as write)',
      answer('write', 'maintain', { ...all, admin: false }),
      'approver',
    ],
    [
      'write',
      answer('write', 'write', { push: true, triage: true, pull: true }),
      'approver',
    ],
    [
      'triage (reported as read)',
      answer('read', 'triage', { triage: true, pull: true }),
      'participant',
    ],
    ['read', answer('read', 'read', { pull: true }), 'none'],
    ['none', answer('none', 'none', {}), 'none'],
    [
      'write without user.permissions',
      { permission: 'write', role_name: 'write' },
      'approver',
    ],
    [
      'read without user.permissions',
      { permission: 'read', role_name: 'triage' },
      'none',
    ],
    ['read with user: null', { permission: 'read', user: null }, 'none'],
  ])('%s → %s, with one request', async (_name, body, expected) => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', PERMISSION, { body });

    await expect(issues.getAccessLevel(task5, 'octocat')).resolves.toBe(
      expected,
    );
    expect(fake.to(PERMISSION)).toHaveLength(1);
  });

  it('no such user (404) → none', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', PERMISSION, { status: 404, body: { message: 'Not Found' } });

    await expect(issues.getAccessLevel(task5, 'octocat')).resolves.toBe('none');
  });

  it.each([
    [503, 'transient'],
    [403, 'permanent'],
  ])('a %s throws (%s) instead of answering none', async (status, kind) => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', PERMISSION, { status, body: { message: 'nope' } });

    await expect(issues.getAccessLevel(task5, 'octocat')).rejects.toMatchObject(
      { kind },
    );
  });

  it('no answer at all → transient error', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on('GET', PERMISSION, 'no-response');

    await expect(issues.getAccessLevel(task5, 'octocat')).rejects.toMatchObject(
      { kind: 'transient' },
    );
  });

  it('asks again on every call (no cache)', async () => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);
    fake.on(
      'GET',
      PERMISSION,
      { body: answer('write', 'write', { push: true }) },
      { body: answer('read', 'read', { pull: true }) },
    );

    await expect(issues.getAccessLevel(task5, 'octocat')).resolves.toBe(
      'approver',
    );
    await expect(issues.getAccessLevel(task5, 'octocat')).resolves.toBe('none');
    expect(fake.to(PERMISSION)).toHaveLength(2);
  });
});

describe('GitHubIssueProvider.isSelf', () => {
  async function identified(fake: FakeGitHubFetch) {
    const client = await connectedTestClient(fake);
    await client.identifyBot();
    return new GitHubIssueProvider(client);
  }

  it.each([
    [`${TEST_SLUG}[bot]`, true],
    [`${TEST_SLUG.toUpperCase()}[BOT]`, true],
    [TEST_SLUG, false],
    ['octocat', false],
    ['dependabot[bot]', false],
    ['github-actions[bot]', false],
    ['', false],
  ])('%j → %s, with no request', async (login, expected) => {
    const fake = new FakeGitHubFetch();
    const issues = await identified(fake);
    const before = fake.requests.length;

    expect(issues.isSelf(login)).toBe(expected);
    expect(fake.requests).toHaveLength(before);
  });

  it('is false for everyone before the bot login is resolved', async () => {
    const issues = await providerWith(new FakeGitHubFetch());
    expect(issues.isSelf('')).toBe(false);
    expect(issues.isSelf(`${TEST_SLUG}[bot]`)).toBe(false);
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
    ['getAccessLevel', (issues) => issues.getAccessLevel(elsewhere, 'octocat')],
    [
      'acknowledgeComment',
      (issues) => issues.acknowledgeComment(elsewhere, '91'),
    ],
    ['reactWorking', (issues) => issues.reactWorking(elsewhere, '91')],
    ['setWorkingLabel', (issues) => issues.setWorkingLabel(elsewhere, true)],
  ])('%s throws a permanent error and sends nothing', async (_name, call) => {
    const fake = new FakeGitHubFetch();
    const issues = await providerWith(fake);

    await expect(call(issues)).rejects.toMatchObject({ kind: 'permanent' });
    expect(fake.to(/\/issues/)).toHaveLength(0);
  });
});
