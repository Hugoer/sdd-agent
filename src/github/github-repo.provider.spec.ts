import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FakeGitHubFetch,
  TEST_APP_ID,
  TEST_BOT_USER_ID,
  TEST_INSTALLATION_ID,
  TEST_REPO,
  connectedTestClient,
  type Scripted,
} from '../../test/fakes/fake-github-fetch.js';
import type { PullRequestRef } from '../contracts/repo-provider.js';
import { GitHubRepoProvider } from './github-repo.provider.js';

const CONTENTS = /\/contents\//;
const COMMIT_MAIN = `/repos/${TEST_REPO}/commits/main`;
const TREE = `/repos/${TEST_REPO}/git/trees/tree-sha-1`;

afterEach(() => vi.restoreAllMocks());

async function providerWith(
  fake: FakeGitHubFetch,
): Promise<GitHubRepoProvider> {
  return new GitHubRepoProvider(await connectedTestClient(fake));
}

/** GitHub's JSON form of a file: base64 in lines of 60 characters. */
function fileBody(bytes: Buffer, path = '.github-agent/workflow.json') {
  const base64 = bytes.toString('base64').replace(/(.{60})/g, '$1\n');
  return {
    type: 'file',
    encoding: 'base64',
    size: bytes.length,
    name: path.split('/').at(-1),
    path,
    content: base64,
  };
}

/** Decoded `METHOD path?query` of every request to the repo (auth requests left out). */
function repoRequests(fake: FakeGitHubFetch): string[] {
  return fake
    .to(new RegExp(`^/repos/${TEST_REPO}/(contents|commits|git)/`))
    .map(
      (r) =>
        `${r.method} ${decodeURIComponent(r.path)}${r.query.size ? `?${decodeURIComponent(r.query.toString())}` : ''}`,
    );
}

describe('GitHubRepoProvider.readFile', () => {
  it('returns the UTF-8 text of a file at the ref', async () => {
    const fake = new FakeGitHubFetch();
    const repo = await providerWith(fake);
    const text = `{ "steps": { "spec": "skills/spec" } }\n${'ünïcødé ✓ '.repeat(20)}`;
    fake.on('GET', CONTENTS, { body: fileBody(Buffer.from(text)) });

    await expect(
      repo.readFile('main', '.github-agent/workflow.json'),
    ).resolves.toBe(text);
    expect(repoRequests(fake)).toEqual([
      `GET /repos/${TEST_REPO}/contents/.github-agent/workflow.json?ref=main`,
    ]);
  });

  it('returns null for a path that does not exist', async () => {
    const fake = new FakeGitHubFetch();
    const repo = await providerWith(fake);
    fake.on('GET', CONTENTS, { status: 404, body: { message: 'Not Found' } });

    await expect(repo.readFile('main', 'missing.md')).resolves.toBeNull();
  });

  it('throws a permanent error for a ref that does not exist', async () => {
    const fake = new FakeGitHubFetch();
    const repo = await providerWith(fake);
    fake.on('GET', CONTENTS, {
      status: 404,
      body: { message: 'No commit found for the ref no-such-ref' },
    });

    await expect(
      repo.readFile('no-such-ref', '.github-agent/workflow.json'),
    ).rejects.toMatchObject({ kind: 'permanent', detail: { status: 404 } });
  });

  it.each([
    ['a directory', [fileBody(Buffer.from('x'), 'dir/a.md')]],
    ['a submodule', { type: 'submodule', path: 'vendor/lib', size: 0 }],
    ['a symlink out of the repo', { type: 'symlink', target: '/etc/passwd' }],
  ])('returns null for %s', async (_what, body) => {
    const fake = new FakeGitHubFetch();
    const repo = await providerWith(fake);
    fake.on('GET', CONTENTS, { body });

    await expect(repo.readFile('main', 'some/path')).resolves.toBeNull();
  });

  it('throws a permanent error for a file over 1 MB', async () => {
    const fake = new FakeGitHubFetch();
    const repo = await providerWith(fake);
    // GitHub's JSON form leaves `content` empty for files over 1 MB.
    fake.on('GET', CONTENTS, {
      body: { type: 'file', encoding: 'none', size: 2_000_000, content: '' },
    });

    await expect(repo.readFile('main', 'big.bin')).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringMatching(/over 1 MB/) as string,
    });
  });

  it('throws a permanent error for a file that is not valid UTF-8', async () => {
    const fake = new FakeGitHubFetch();
    const repo = await providerWith(fake);
    fake.on('GET', CONTENTS, {
      body: fileBody(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe])),
    });

    await expect(repo.readFile('main', 'logo.png')).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringMatching(/UTF-8/) as string,
    });
  });

  it.each(['/etc/passwd', '../secrets.md', 'skills/../../x.md'])(
    'refuses the unsafe path "%s" without a request',
    async (path) => {
      const fake = new FakeGitHubFetch();
      const repo = await providerWith(fake);

      await expect(repo.readFile('main', path)).rejects.toMatchObject({
        kind: 'permanent',
      });
      expect(repoRequests(fake)).toEqual([]);
    },
  );
});

describe('GitHubRepoProvider.listFiles', () => {
  const entry = (path: string, mode: string, size?: number) => ({
    path,
    mode,
    type: mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob',
    sha: `sha-${path}`,
    ...(size === undefined ? {} : { size }),
  });
  const tree = [
    entry('README.md', '100644', 10),
    entry('smoke-skill', '040000'),
    entry('smoke-skill/scripts', '040000'),
    entry('smoke-skill/scripts/run.sh', '100755', 40),
    entry('smoke-skill/SKILL.md', '100644', 120),
    entry('smoke-skill/references', '040000'),
    entry('smoke-skill/references/a.md', '100644', 30),
    entry('smoke-skill/link.md', '120000', 11),
    entry('smoke-skill/vendor', '160000'),
    entry('smoke-skill-old', '040000'),
    entry('smoke-skill-old/SKILL.md', '100644', 5),
  ];

  function scripted(fake: FakeGitHubFetch, truncated = false) {
    return fake
      .on('GET', COMMIT_MAIN, {
        body: { sha: 'commit-1', commit: { tree: { sha: 'tree-sha-1' } } },
      })
      .on('GET', TREE, { body: { sha: 'tree-sha-1', truncated, tree } });
  }

  it('lists every regular file under the directory, sorted, with sizes and the executable bit', async () => {
    const fake = scripted(new FakeGitHubFetch());
    const repo = await providerWith(fake);

    await expect(repo.listFiles('main', 'smoke-skill')).resolves.toEqual([
      { path: 'smoke-skill/SKILL.md', size: 120, executable: false },
      { path: 'smoke-skill/references/a.md', size: 30, executable: false },
      { path: 'smoke-skill/scripts/run.sh', size: 40, executable: true },
    ]);
    expect(repoRequests(fake)).toEqual([
      `GET ${COMMIT_MAIN}`,
      `GET ${TREE}?recursive=1`,
    ]);
  });

  it('accepts a trailing slash', async () => {
    const fake = scripted(new FakeGitHubFetch());
    const repo = await providerWith(fake);

    const files = await repo.listFiles('main', 'smoke-skill/');

    expect(files?.map((file) => file.path)).toHaveLength(3);
  });

  it.each(['no-such-dir', 'README.md', 'smoke'])(
    'returns null when "%s" is not a directory',
    async (dir) => {
      const fake = scripted(new FakeGitHubFetch());
      const repo = await providerWith(fake);

      await expect(repo.listFiles('main', dir)).resolves.toBeNull();
    },
  );

  it('throws a permanent error for a ref that does not exist, without reading a tree', async () => {
    const fake = scripted(new FakeGitHubFetch()).on(
      'GET',
      /\/commits\/no-such-ref$/,
      {
        status: 422,
        body: { message: 'No commit found for SHA: no-such-ref' },
      },
    );
    const repo = await providerWith(fake);

    await expect(
      repo.listFiles('no-such-ref', 'smoke-skill'),
    ).rejects.toMatchObject({ kind: 'permanent', detail: { status: 422 } });
    expect(fake.to(TREE)).toHaveLength(0);
  });

  it('throws a permanent error when GitHub truncated the tree', async () => {
    const fake = scripted(new FakeGitHubFetch(), true);
    const repo = await providerWith(fake);

    await expect(repo.listFiles('main', 'smoke-skill')).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringMatching(/truncated/) as string,
    });
  });

  it.each(['/smoke-skill', '../other', 'a/../../b'])(
    'refuses the unsafe directory "%s" without a request',
    async (dir) => {
      const fake = new FakeGitHubFetch();
      const repo = await providerWith(fake);

      await expect(repo.listFiles('main', dir)).rejects.toMatchObject({
        kind: 'permanent',
      });
      expect(repoRequests(fake)).toEqual([]);
    },
  );
});

describe('GitHubRepoProvider.resolveRef', () => {
  // Built at run time. GitHub answers this media type with `application/vnd.github.v3.sha; charset=utf-8` and the
  // bare SHA (checked on a public repo, 2026-11-13), which Octokit reads as text.
  const SHA = 'ab12'.repeat(10);
  const asSha = {
    text: SHA,
    headers: { 'content-type': 'application/vnd.github.v3.sha; charset=utf-8' },
  };

  it("returns the branch's 40-character SHA with one request, asking for GitHub's sha media type", async () => {
    const fake = new FakeGitHubFetch().on('GET', COMMIT_MAIN, asSha);
    const repo = await providerWith(fake);

    await expect(repo.resolveRef('main')).resolves.toBe(SHA);

    expect(repoRequests(fake)).toEqual([`GET ${COMMIT_MAIN}`]);
    expect(fake.to(COMMIT_MAIN)[0].accept).toBe(
      'application/vnd.github.v3.sha',
    );
  });

  it('sends a branch name with a slash as one path segment', async () => {
    const fake = new FakeGitHubFetch().on('GET', /\/commits\//, asSha);
    const repo = await providerWith(fake);

    await expect(repo.resolveRef('smoke/spec-4-no-models')).resolves.toBe(SHA);

    expect(fake.to(/\/commits\//).map((r) => r.path)).toEqual([
      `/repos/${TEST_REPO}/commits/smoke%2Fspec-4-no-models`,
    ]);
  });

  it('an unknown ref → permanent ProviderError naming the ref', async () => {
    const fake = new FakeGitHubFetch().on('GET', /\/commits\/no-such-branch$/, {
      status: 422,
      body: { message: 'No commit found for SHA: no-such-branch' },
    });
    const repo = await providerWith(fake);

    await expect(repo.resolveRef('no-such-branch')).rejects.toMatchObject({
      kind: 'permanent',
      detail: { status: 422 },
      message: expect.stringContaining('"no-such-branch"') as string,
    });
  });

  it.each<[string, Scripted]>([
    ['a 503', { status: 503, body: { message: 'Unavailable' } }],
    ['no response', 'no-response'],
  ])('an outage (%s) → transient', async (_name, answer) => {
    const fake = new FakeGitHubFetch().on('GET', COMMIT_MAIN, answer);
    const repo = await providerWith(fake);

    await expect(repo.resolveRef('main')).rejects.toMatchObject({
      kind: 'transient',
    });
  });

  it('an answer that is not a SHA → permanent', async () => {
    const fake = new FakeGitHubFetch().on('GET', COMMIT_MAIN, {
      body: { sha: SHA },
    });
    const repo = await providerWith(fake);

    await expect(repo.resolveRef('main')).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining('not a commit SHA') as string,
    });
  });
});

describe('GitHubRepoProvider.getPushCredentials', () => {
  const TOKENS = `/app/installations/${TEST_INSTALLATION_ID}/access_tokens`;
  const EXPIRES = '2026-11-11T13:00:00Z';

  /** Push-token requests name `repositories`; Octokit's own installation token request doesn't. */
  const isPushRequest = (body: unknown) =>
    typeof body === 'object' && body !== null && 'repositories' in body;

  async function connected(fake: FakeGitHubFetch) {
    const client = await connectedTestClient(fake);
    await client.identifyBot();
    let issued = 0;
    fake.on('POST', TOKENS, (request) => ({
      status: 201,
      body: {
        token: isPushRequest(request.body)
          ? `ghs_pushtoken${++issued}`
          : 'ghs_installationtoken',
        expires_at: EXPIRES,
      },
    }));
    return new GitHubRepoProvider(client);
  }

  const pushRequests = (fake: FakeGitHubFetch) =>
    fake.to(TOKENS, 'POST').filter((r) => isPushRequest(r.body));

  it('asks as the App for a token limited to the repo and contents: write', async () => {
    const fake = new FakeGitHubFetch();
    const repo = await connected(fake);

    const credentials = await repo.getPushCredentials();

    expect(credentials).toEqual({
      authorName: 'test-app[bot]',
      authorEmail: `${TEST_BOT_USER_ID}+test-app[bot]@users.noreply.github.com`,
      remoteUrl: `https://github.com/${TEST_REPO}.git`,
      token: 'ghs_pushtoken1',
      expiresAt: new Date(EXPIRES),
    });
    const [request, ...more] = pushRequests(fake);
    expect(more).toEqual([]);
    expect(request.authorization).toMatch(/^bearer ey/);
    expect(request.body).toEqual({
      repositories: ['test-repo'],
      permissions: { contents: 'write' },
    });
  });

  it('creates a new token on every call', async () => {
    const fake = new FakeGitHubFetch();
    const repo = await connected(fake);

    const first = await repo.getPushCredentials();
    const second = await repo.getPushCredentials();

    expect(first.token).not.toBe(second.token);
    expect(pushRequests(fake)).toHaveLength(2);
  });

  it('logs nothing that holds the token', async () => {
    const fake = new FakeGitHubFetch();
    const repo = await connected(fake);
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (level) => vi.spyOn(Logger.prototype, level).mockImplementation(() => {}),
    );
    const consoles = (['log', 'warn', 'error', 'info'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );

    await repo.getPushCredentials();

    const logged = [...spies, ...consoles]
      .flatMap((spy) => spy.mock.calls)
      .map((args) => JSON.stringify(args))
      .join('\n');
    expect(logged).not.toContain('ghs_pushtoken');
  });

  it('turns a refusal into a permanent error that holds no token or JWT', async () => {
    const fake = new FakeGitHubFetch();
    const repo = await connected(fake);
    fake.on('POST', TOKENS, (request) =>
      isPushRequest(request.body)
        ? {
            status: 422,
            body: {
              message:
                'There is at least one repository that does not exist or is not accessible to the parent installation.',
            },
          }
        : { status: 201, body: { token: 'ghs_x', expires_at: EXPIRES } },
    );

    const error: unknown = await repo
      .getPushCredentials()
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: 'permanent', detail: { status: 422 } });
    expect((error as Error).message).not.toMatch(
      /ghs_|bearer|ey[A-Za-z0-9_-]{10}/,
    );
  });
});

describe('GitHubRepoProvider pull requests and check runs', () => {
  const PULLS = `/repos/${TEST_REPO}/pulls`;
  const CHECK_RUNS = `/repos/${TEST_REPO}/check-runs`;
  const SHA = 'a'.repeat(40);
  const RUNS_OF_SHA = `/repos/${TEST_REPO}/commits/${SHA}/check-runs`;
  const pr12: PullRequestRef = {
    platform: 'GITHUB',
    repo: TEST_REPO,
    number: 12,
    url: `https://github.com/${TEST_REPO}/pull/12`,
  };
  const elsewhere: PullRequestRef = { ...pr12, repo: 'someone/else' };

  async function connected(fake: FakeGitHubFetch) {
    const client = await connectedTestClient(fake);
    await client.identifyBot();
    return new GitHubRepoProvider(client);
  }

  const pull = (number: number, byBot: boolean, state = 'open') => ({
    number,
    state,
    html_url: `https://github.com/${TEST_REPO}/pull/${number}`,
    created_at: `2026-11-${10 + (number % 10)}T10:00:00Z`,
    user: byBot
      ? { login: 'test-app[bot]', id: TEST_BOT_USER_ID, type: 'Bot' }
      : { login: 'octocat', id: 1, type: 'User' },
  });

  const requestsTo = (fake: FakeGitHubFetch, path: string | RegExp) =>
    fake.to(path).map((r) => `${r.method} ${decodeURIComponent(r.path)}`);

  it('openPullRequest opens a normal PR and returns its reference', async () => {
    const fake = new FakeGitHubFetch();
    const repo = await connected(fake);
    fake.on('POST', PULLS, { status: 201, body: pull(12, true) });

    await expect(
      repo.openPullRequest('agent/issue-5', 'main', 'Dark mode', 'Closes #5'),
    ).resolves.toEqual(pr12);
    expect(fake.to(PULLS, 'POST')[0].body).toEqual({
      head: 'agent/issue-5',
      base: 'main',
      title: 'Dark mode',
      body: 'Closes #5',
      draft: false,
    });
  });

  it('openPullRequest: "already exists" is a permanent error, with no lookup', async () => {
    const fake = new FakeGitHubFetch();
    const repo = await connected(fake);
    fake.on('POST', PULLS, {
      status: 422,
      body: {
        message: 'Validation Failed',
        errors: [
          {
            message:
              'A pull request already exists for test-owner:agent/issue-5.',
          },
        ],
      },
    });

    await expect(
      repo.openPullRequest('agent/issue-5', 'main', 't', 'b'),
    ).rejects.toMatchObject({ kind: 'permanent', detail: { status: 422 } });
    expect(requestsTo(fake, PULLS)).toEqual([`POST ${PULLS}`]);
  });

  it("findPullRequest returns the newest of the App's PRs for the branch, in any state", async () => {
    const fake = new FakeGitHubFetch();
    const repo = await connected(fake);
    fake.on('GET', PULLS, {
      body: [pull(20, false), pull(15, true, 'closed'), pull(12, true)],
    });

    await expect(repo.findPullRequest('agent/issue-5')).resolves.toEqual({
      ...pr12,
      number: 15,
      url: `https://github.com/${TEST_REPO}/pull/15`,
    });
    const [request] = fake.to(PULLS, 'GET');
    expect(Object.fromEntries(request.query)).toMatchObject({
      head: 'test-owner:agent/issue-5',
      state: 'all',
    });
  });

  it.each([
    ['only a human PR', [pull(20, false)]],
    ['no PR', []],
  ])('findPullRequest returns null with %s', async (_what, body) => {
    const fake = new FakeGitHubFetch();
    const repo = await connected(fake);
    fake.on('GET', PULLS, { body });

    await expect(repo.findPullRequest('agent/issue-5')).resolves.toBeNull();
  });

  it('postPullRequestComment posts the body unchanged on the PR conversation', async () => {
    const fake = new FakeGitHubFetch();
    const repo = await connected(fake);
    const COMMENTS_12 = `/repos/${TEST_REPO}/issues/12/comments`;
    fake.on('POST', COMMENTS_12, {
      status: 201,
      body: {
        id: 77,
        html_url: `${pr12.url}#issuecomment-77`,
        created_at: '2026-11-11T10:00:00Z',
      },
    });

    await expect(
      repo.postPullRequestComment(pr12, '<!-- m -->\nReview ✓'),
    ).resolves.toEqual({
      id: '77',
      url: `${pr12.url}#issuecomment-77`,
      createdAt: new Date('2026-11-11T10:00:00Z'),
    });
    expect(fake.to(COMMENTS_12)[0].body).toEqual({
      body: '<!-- m -->\nReview ✓',
    });
  });

  it('setQualityResult creates the completed Quality Gate check run the first time', async () => {
    const fake = new FakeGitHubFetch();
    const repo = await connected(fake);
    fake
      .on('GET', RUNS_OF_SHA, { body: { total_count: 0, check_runs: [] } })
      .on('POST', CHECK_RUNS, { status: 201, body: { id: 501 } });

    await repo.setQualityResult(pr12, SHA, 'neutral', 'Needs a look.');

    const [lookup] = fake.to(RUNS_OF_SHA);
    expect(Object.fromEntries(lookup.query)).toMatchObject({
      check_name: 'Quality Gate',
      app_id: String(TEST_APP_ID),
    });
    expect(fake.to(CHECK_RUNS, 'POST')[0].body).toMatchObject({
      name: 'Quality Gate',
      head_sha: SHA,
      status: 'completed',
      conclusion: 'neutral',
      output: { title: 'Quality Gate', summary: 'Needs a look.' },
    });
    expect(fake.to(/\/check-runs\/\d+$/)).toEqual([]);
  });

  it("setQualityResult updates the App's existing check run of that commit", async () => {
    const fake = new FakeGitHubFetch();
    const repo = await connected(fake);
    fake
      .on('GET', RUNS_OF_SHA, {
        body: {
          total_count: 2,
          check_runs: [
            { id: 900, name: 'Quality Gate', app: { id: 1 } },
            { id: 501, name: 'Quality Gate', app: { id: TEST_APP_ID } },
          ],
        },
      })
      .on('PATCH', `${CHECK_RUNS}/501`, { body: { id: 501 } });

    await repo.setQualityResult(pr12, SHA, 'success', 'All good.');

    expect(requestsTo(fake, /check-runs/)).toEqual([
      `GET ${RUNS_OF_SHA}`,
      `PATCH ${CHECK_RUNS}/501`,
    ]);
    expect(fake.to(`${CHECK_RUNS}/501`)[0].body).toMatchObject({
      status: 'completed',
      conclusion: 'success',
      output: { title: 'Quality Gate', summary: 'All good.' },
    });
  });

  it.each<[string, (repo: GitHubRepoProvider) => Promise<unknown>]>([
    [
      'postPullRequestComment',
      (repo) => repo.postPullRequestComment(elsewhere, 'hi'),
    ],
    [
      'setQualityResult',
      (repo) => repo.setQualityResult(elsewhere, SHA, 'success', 's'),
    ],
  ])(
    '%s refuses a PR of another repo without a request',
    async (_name, call) => {
      const fake = new FakeGitHubFetch();
      const repo = await connected(fake);

      await expect(call(repo)).rejects.toMatchObject({ kind: 'permanent' });
      expect(fake.to(/\/(issues|check-runs|commits)\//)).toEqual([]);
    },
  );
});
