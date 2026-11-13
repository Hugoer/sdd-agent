import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.schema.js';
import type {
  PullRequestRef,
  RepoProvider,
} from '../contracts/repo-provider.js';
import { ScanningRepoProvider } from './scanning-repo.provider.js';
import { SecretScanner } from './secret-scanner.js';

afterEach(() => vi.restoreAllMocks());

// Built at run time: no token-shaped literal in the repo.
const TOKEN = ['gh', 'p_', 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2'].join('');
const SLACK = ['xo', 'xb-', '1234567890-abcdefghij'].join('');
const WEBHOOK_SECRET = ['hook', 'secret', 'value'].join('-');
const SHA = 'ab12'.repeat(10);
const PR: PullRequestRef = {
  platform: 'GITHUB',
  repo: 'Hugoer/sdd-agent-sandbox',
  number: 7,
  url: 'https://github.com/Hugoer/sdd-agent-sandbox/pull/7',
};

/** A RepoProvider that records each call and answers `{ from: <method> }`. */
function recorder() {
  const calls: { method: string; args: unknown[] }[] = [];
  const inner = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (...args: unknown[]) => {
          calls.push({ method, args });
          return Promise.resolve({ from: method });
        },
    },
  ) as RepoProvider;
  return { inner, calls };
}

function setup() {
  const { inner, calls } = recorder();
  const scanner = new SecretScanner(
    new ConfigService<Env, true>({
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GOOGLE_API_KEY: 'google-key-value',
    }),
  );
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const lines = () => warn.mock.calls.map(([line]) => String(line));
  return { repo: new ScanningRepoProvider(inner, scanner), calls, lines };
}

describe('ScanningRepoProvider', () => {
  it('openPullRequest sends the redacted title and body; one log line for both', async () => {
    const { repo, calls, lines } = setup();

    await repo.openPullRequest(
      'agent/issue-12',
      'main',
      `Fix ${TOKEN}`,
      `Body with ${SLACK} and ${WEBHOOK_SECRET}.`,
    );

    expect(calls).toEqual([
      {
        method: 'openPullRequest',
        args: [
          'agent/issue-12',
          'main',
          'Fix [REDACTED: github-token]',
          'Body with [REDACTED: slack-token] and [REDACTED: own-secret].',
        ],
      },
    ]);
    expect(lines()).toEqual([
      'secret-scan openPullRequest branch agent/issue-12: redacted 3 (github-token, slack-token, own-secret)',
    ]);
  });

  it('postPullRequestComment sends the redacted body', async () => {
    const { repo, calls, lines } = setup();

    await repo.postPullRequestComment(PR, `see ${TOKEN}`);

    expect(calls).toEqual([
      {
        method: 'postPullRequestComment',
        args: [PR, 'see [REDACTED: github-token]'],
      },
    ]);
    expect(lines()).toEqual([
      'secret-scan postPullRequestComment Hugoer/sdd-agent-sandbox#7: redacted 1 (github-token)',
    ]);
  });

  it('setQualityResult sends the redacted summary; the commit SHA is not touched', async () => {
    const { repo, calls, lines } = setup();

    await repo.setQualityResult(PR, SHA, 'failure', `leak ${TOKEN} in ${SHA}`);

    expect(calls).toEqual([
      {
        method: 'setQualityResult',
        args: [PR, SHA, 'failure', `leak [REDACTED: github-token] in ${SHA}`],
      },
    ]);
    expect(lines().join('\n')).not.toContain(TOKEN);
  });

  it('texts without a secret are sent byte for byte, with no log line', async () => {
    const { repo, calls, lines } = setup();
    const title = 'Add the plan';
    const body = `<!-- sdd-agent:pr -->\nCloses #12 at ${SHA}.`;

    await repo.openPullRequest('agent/issue-12', 'main', title, body);
    await repo.postPullRequestComment(PR, body);
    await repo.setQualityResult(PR, SHA, 'success', body);

    expect(calls[0].args[2]).toBe(title);
    expect(calls[0].args[3]).toBe(body);
    expect(calls[1].args[1]).toBe(body);
    expect(calls[2].args[3]).toBe(body);
    expect(lines()).toEqual([]);
  });

  const passThrough: {
    [
      M in Exclude<
        keyof RepoProvider,
        'openPullRequest' | 'postPullRequestComment' | 'setQualityResult'
      >
    ]: Parameters<RepoProvider[M]>;
  } = {
    getPushCredentials: [],
    readFile: ['main', `.github-agent/${TOKEN}.md`],
    listFiles: [SHA, '.github-agent/skills/spec'],
    resolveRef: ['main'],
    findPullRequest: ['agent/issue-12'],
  };

  it.each(Object.entries(passThrough))(
    '%s reaches the wrapped provider with unchanged arguments and returns its result',
    async (method, args) => {
      const { repo, calls, lines } = setup();
      const call = (
        repo[method as keyof RepoProvider] as (...a: unknown[]) => unknown
      ).bind(repo);

      expect(await call(...args)).toEqual({ from: method });

      expect(calls).toEqual([{ method, args }]);
      calls[0].args.forEach((arg, index) => expect(arg).toBe(args[index]));
      expect(lines()).toEqual([]);
    },
  );
});
