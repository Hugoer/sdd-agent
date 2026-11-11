import { describe, expect, it } from 'vitest';
import { ProviderError } from '../contracts/provider-error.js';
import {
  FakeGitHubFetch,
  TEST_REPO,
  connectedTestClient,
  createTestClient,
  type Scripted,
} from '../../test/fakes/fake-github-fetch.js';

const ISSUE = `/repos/${TEST_REPO}/issues/5`;
const COMMENTS = `/repos/${TEST_REPO}/issues/5/comments`;

function getIssue(client: Awaited<ReturnType<typeof connectedTestClient>>) {
  return client.request((octokit) =>
    octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 5,
    }),
  );
}

async function errorOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error('expected a ProviderError');
}

async function errorFor(scripted: Scripted): Promise<ProviderError> {
  const fake = new FakeGitHubFetch();
  const client = await connectedTestClient(fake);
  fake.on('GET', ISSUE, scripted);
  return errorOf(getIssue(client));
}

describe('GitHubClient.connect', () => {
  it('finds the installation of TARGET_REPO as the App (JWT)', async () => {
    const fake = new FakeGitHubFetch();

    await connectedTestClient(fake);

    const [lookup] = fake.to(`/repos/${TEST_REPO}/installation`);
    expect(lookup.authorization).toMatch(/^bearer ey/);
  });

  it('sends later requests with the installation token', async () => {
    const fake = new FakeGitHubFetch();
    const client = await connectedTestClient(fake);
    fake.on('GET', ISSUE, { body: { number: 5 } });

    const { data } = await getIssue(client);

    expect(data.number).toBe(5);
    expect(fake.to(ISSUE)[0].authorization).toBe('token ghs_installationtoken');
  });
});

describe('GitHubClient error mapping', () => {
  it.each([
    [500, 'transient'],
    [502, 'transient'],
    [503, 'transient'],
    [400, 'permanent'],
    [403, 'permanent'],
    [404, 'permanent'],
    [410, 'permanent'],
    [422, 'permanent'],
  ] as const)('maps %i to %s', async (status, kind) => {
    const error = await errorFor({
      status,
      body: { message: 'GitHub says no' },
    });

    expect(error.kind).toBe(kind);
    expect(error.detail.status).toBe(status);
    expect(error.detail.retryAfterSeconds).toBeUndefined();
  });

  it('maps a 401 on an App (JWT) request to permanent', async () => {
    const fake = new FakeGitHubFetch().on(
      'GET',
      `/repos/${TEST_REPO}/installation`,
      {
        status: 401,
        body: { message: 'A JSON web token could not be decoded' },
      },
    );

    const error = await errorOf(createTestClient(fake).connect());

    expect(error).toMatchObject({ kind: 'permanent', detail: { status: 401 } });
  });

  it('maps a failed connection to transient without a status', async () => {
    const error = await errorFor('no-response');

    expect(error.kind).toBe('transient');
    expect(error.detail.status).toBeUndefined();
    expect(error.message).toContain('no response');
  });

  it('uses retry-after on a 429', async () => {
    const error = await errorFor({
      status: 429,
      headers: { 'retry-after': '30' },
    });

    expect(error).toMatchObject({
      kind: 'transient',
      detail: { status: 429, retryAfterSeconds: 30 },
    });
  });

  it('waits a minute on a 429 without headers', async () => {
    const error = await errorFor({
      status: 429,
      body: { message: 'slow down' },
    });

    expect(error).toMatchObject({
      kind: 'transient',
      detail: { retryAfterSeconds: 60 },
    });
  });

  it('uses retry-after on a 403 (secondary rate limit)', async () => {
    const error = await errorFor({
      status: 403,
      headers: { 'retry-after': '10' },
    });

    expect(error).toMatchObject({
      kind: 'transient',
      detail: { status: 403, retryAfterSeconds: 10 },
    });
  });

  it('waits until x-ratelimit-reset on a 403 with no requests left', async () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const error = await errorFor({
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset),
      },
      body: { message: 'API rate limit exceeded' },
    });

    expect(error.kind).toBe('transient');
    expect(error.detail.retryAfterSeconds).toBeGreaterThanOrEqual(119);
    expect(error.detail.retryAfterSeconds).toBeLessThanOrEqual(121);
  });

  it('names the method, the path, the status and GitHub message, nothing else', async () => {
    const error = await errorFor({
      status: 422,
      body: {
        message: 'Validation Failed',
        errors: [{ message: 'A pull request already exists for o:b.' }],
        documentation_url: 'https://docs.github.com/rest',
      },
    });

    expect(error.message).toBe(
      `GitHub GET ${ISSUE} → 422: Validation Failed (A pull request already exists for o:b.)`,
    );
    expect(error.message).not.toContain('ghs_');
  });

  it('sends a write once, even when GitHub answers 500', async () => {
    const fake = new FakeGitHubFetch();
    const client = await connectedTestClient(fake);
    fake.on('POST', COMMENTS, {
      status: 500,
      body: { message: 'Server Error' },
    });

    await errorOf(
      client.request((octokit) =>
        octokit.request(
          'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
          {
            owner: 'test-owner',
            repo: 'test-repo',
            issue_number: 5,
            body: 'hello',
          },
        ),
      ),
    );

    expect(fake.to(COMMENTS)).toHaveLength(1);
  });

  it('gives up on a request that never answers after the timeout', async () => {
    const fake = new FakeGitHubFetch();
    const client = await connectedTestClient(fake, 50);
    fake.on('GET', ISSUE, 'hang');

    const error = await errorOf(getIssue(client));

    expect(error.kind).toBe('transient');
    expect(error.detail.status).toBeUndefined();
  });
});

describe('GitHubClient.requestOrNull', () => {
  it('turns a 404 into null', async () => {
    const fake = new FakeGitHubFetch();
    const client = await connectedTestClient(fake);
    fake.on('GET', ISSUE, { status: 404, body: { message: 'Not Found' } });

    await expect(
      client.requestOrNull((octokit) =>
        octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
          owner: 'test-owner',
          repo: 'test-repo',
          issue_number: 5,
        }),
      ),
    ).resolves.toBeNull();
  });

  it('still throws other errors', async () => {
    const fake = new FakeGitHubFetch();
    const client = await connectedTestClient(fake);
    fake.on('GET', ISSUE, { status: 500 });

    await expect(
      client.requestOrNull((octokit) =>
        octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
          owner: 'test-owner',
          repo: 'test-repo',
          issue_number: 5,
        }),
      ),
    ).rejects.toMatchObject({ kind: 'transient' });
  });
});

describe('GitHubClient target repo guard', () => {
  it('parses a task of TARGET_REPO, ignoring letter case', () => {
    const client = createTestClient(new FakeGitHubFetch());

    expect(
      client.target({
        platform: 'GITHUB',
        id: '1',
        externalRef: 'Test-Owner/Test-Repo#12',
      }),
    ).toEqual({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 12,
    });
  });

  it.each([
    'someone/else#12',
    'test-owner/test-repo',
    'test-owner/test-repo#x',
    'test-owner/test-repo-2#1',
  ])('refuses %s without a request', (externalRef) => {
    const fake = new FakeGitHubFetch();
    const client = createTestClient(fake);

    expect(() =>
      client.target({ platform: 'GITHUB', id: '1', externalRef }),
    ).toThrow(ProviderError);
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a pull request of another repo', () => {
    const client = createTestClient(new FakeGitHubFetch());

    expect(() =>
      client.targetPullRequest({
        platform: 'GITHUB',
        repo: 'someone/else',
        number: 3,
        url: '',
      }),
    ).toThrow(expect.objectContaining({ kind: 'permanent' }) as Error);
    expect(
      client.targetPullRequest({
        platform: 'GITHUB',
        repo: TEST_REPO,
        number: 3,
        url: '',
      }),
    ).toEqual({ owner: 'test-owner', repo: 'test-repo', issue_number: 3 });
  });
});
