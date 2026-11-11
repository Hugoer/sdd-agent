import { describe, expect, it } from 'vitest';
import type { UnifiedTask } from '../contracts/issue-provider.js';
import {
  FakeGitHubFetch,
  TEST_REPO,
  connectedTestClient,
} from '../../test/fakes/fake-github-fetch.js';
import { GitHubIssueProvider } from './github-issue.provider.js';
import { BOT_LABELS } from './labels.js';

const LABELS = `/repos/${TEST_REPO}/labels`;

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
