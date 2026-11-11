import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_PERMISSIONS,
  FakeGitHubFetch,
  TEST_INSTALLATION_ID,
  TEST_REPO,
  createTestClient,
  scriptInstallation,
  type Scripted,
} from '../../test/fakes/fake-github-fetch.js';
import { GitHubIssueProvider } from './github-issue.provider.js';
import { GitHubStartup, GitHubStartupError } from './github-startup.js';

const INSTALLATION = `/repos/${TEST_REPO}/installation`;
const LABELS = `/repos/${TEST_REPO}/labels`;

afterEach(() => vi.restoreAllMocks());

function startupWith(fake: FakeGitHubFetch): GitHubStartup {
  const client = createTestClient(fake, 50);
  return new GitHubStartup(client, new GitHubIssueProvider(client));
}

/** A healthy App whose labels already exist, with one route answered differently. */
function healthy(): FakeGitHubFetch {
  return scriptInstallation(new FakeGitHubFetch())
    .on('GET', LABELS, { body: [] })
    .on('POST', LABELS, { status: 201 });
}

async function failureOf(fake: FakeGitHubFetch): Promise<GitHubStartupError> {
  try {
    await startupWith(fake).onModuleInit();
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubStartupError);
    const message = (error as Error).message;
    for (const secret of ['ghs_', 'bearer', 'BEGIN', 'PRIVATE KEY'])
      expect(message).not.toContain(secret);
    return error as GitHubStartupError;
  }
  throw new Error('expected startup to fail');
}

describe('GitHubStartup', () => {
  it('connects, identifies the bot, creates the labels and logs one ready line', async () => {
    const fake = healthy();
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    await startupWith(fake).onModuleInit();

    expect(fake.to(LABELS, 'POST')).toHaveLength(11);
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toContainEqual(expect.stringContaining('11 created'));
    expect(lines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `test-app\\[bot\\].*${TEST_REPO}.*installation ${TEST_INSTALLATION_ID}`,
        ),
      ),
    );
  });

  it.each<[string, Scripted, RegExp]>([
    [
      '401',
      { status: 401, body: { message: 'Bad credentials' } },
      /GITHUB_APP_ID.*GITHUB_APP_PRIVATE_KEY_PATH/,
    ],
    [
      '404',
      { status: 404, body: { message: 'Not Found' } },
      new RegExp(`not installed on ${TEST_REPO}.*step 4`),
    ],
    ['no response', 'no-response', /GitHub is unreachable.*start again/],
    ['a timeout', 'hang', /GitHub is unreachable/],
    [
      '503',
      { status: 503, body: { message: 'Unavailable' } },
      /GitHub is unreachable/,
    ],
  ])(
    'explains %s on the installation lookup and sends it once',
    async (_cause, answer, message) => {
      const fake = healthy().on('GET', INSTALLATION, answer);

      const error = await failureOf(fake);

      expect(error.message).toMatch(message);
      expect(fake.to(INSTALLATION)).toHaveLength(1);
    },
  );

  it('names every missing permission and creates no label', async () => {
    const fake = healthy();
    scriptInstallation(fake, {
      ...ALL_PERMISSIONS,
      checks: 'read',
      pull_requests: undefined as never,
    });

    const error = await failureOf(fake);

    expect(error.message).toMatch(/checks: write \(has read\)/);
    expect(error.message).toMatch(/pull_requests: write \(has none\)/);
    expect(error.message).toMatch(/accept the new permissions/);
    expect(error.message).not.toMatch(/issues|contents|metadata/);
    expect(fake.to(LABELS)).toHaveLength(0);
  });

  it('accepts metadata: write', async () => {
    const fake = healthy();
    scriptInstallation(fake, { ...ALL_PERMISSIONS, metadata: 'write' });
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    await expect(startupWith(fake).onModuleInit()).resolves.toBeUndefined();
  });

  it('explains a 403 while creating a label', async () => {
    const fake = healthy().on('POST', LABELS, {
      status: 403,
      body: { message: 'Resource not accessible by integration' },
    });

    const error = await failureOf(fake);

    expect(error.message).toMatch(/issues: write/);
    expect(fake.to(LABELS, 'POST')).toHaveLength(1);
  });

  it('reports any other failure with GitHub message', async () => {
    const fake = healthy().on('GET', LABELS, {
      status: 422,
      body: { message: 'Something odd' },
    });

    const error = await failureOf(fake);

    expect(error.message).toMatch(
      /GitHub startup failed: .*422: Something odd/,
    );
  });
});
