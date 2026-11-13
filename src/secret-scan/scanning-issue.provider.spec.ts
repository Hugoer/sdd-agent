import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.schema.js';
import type {
  IssueProvider,
  TaskRef,
  UnifiedTask,
} from '../contracts/issue-provider.js';
import { ScanningIssueProvider } from './scanning-issue.provider.js';
import { SecretScanner } from './secret-scanner.js';

afterEach(() => vi.restoreAllMocks());

// Built at run time: no token-shaped literal in the repo.
const TOKEN = ['gh', 's_', 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2'].join('');
const TASK: TaskRef = {
  platform: 'GITHUB',
  id: '1005',
  externalRef: 'Hugoer/sdd-agent-sandbox#12',
};
const SYNC = new Set(['isSelf', 'readControls']);

/** An IssueProvider that records each call and answers `{ from: <method> }`. */
function recorder() {
  const calls: { method: string; args: unknown[] }[] = [];
  const inner = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (...args: unknown[]) => {
          calls.push({ method, args });
          const answer = { from: method };
          return SYNC.has(method) ? answer : Promise.resolve(answer);
        },
    },
  ) as IssueProvider;
  return { inner, calls };
}

function setup() {
  const { inner, calls } = recorder();
  const scanner = new SecretScanner(
    new ConfigService<Env, true>({
      GITHUB_WEBHOOK_SECRET: 'hook-secret-value',
      GOOGLE_API_KEY: 'google-key-value',
    }),
  );
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  return { issues: new ScanningIssueProvider(inner, scanner), calls, warn };
}

describe('ScanningIssueProvider', () => {
  it('postComment sends the redacted body, the marker untouched, and logs no value and no text', async () => {
    const { issues, calls, warn } = setup();
    const body = `<!-- sdd-agent:test -->\nA token ${TOKEN} slipped in.`;

    await issues.postComment(TASK, body);

    expect(calls).toEqual([
      {
        method: 'postComment',
        args: [
          TASK,
          '<!-- sdd-agent:test -->\nA token [REDACTED: github-token] slipped in.',
        ],
      },
    ]);
    const lines = warn.mock.calls.map(([line]) => String(line));
    expect(lines).toEqual([
      'secret-scan postComment Hugoer/sdd-agent-sandbox#12: redacted 1 (github-token)',
    ]);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.join('\n')).not.toContain('slipped');
  });

  it('a body without a secret is sent byte for byte, with no log line', async () => {
    const { issues, calls, warn } = setup();
    const body = `<!-- m -->\nCommit ${'ab12'.repeat(10)}, issue #12.`;

    await expect(issues.postComment(TASK, body)).resolves.toEqual({
      from: 'postComment',
    });

    expect(calls[0].args[1]).toBe(body);
    expect(warn).not.toHaveBeenCalled();
  });

  const task = { ...TASK, title: 't' } as UnifiedTask;
  const passThrough: {
    [M in Exclude<keyof IssueProvider, 'postComment'>]: Parameters<
      IssueProvider[M]
    >;
  } = {
    getTaskDetails: [TASK],
    getComment: [TASK, '77'],
    findCommentByMarker: [TASK, `<!-- marker ${TOKEN} -->`],
    setStatusLabel: [TASK, 'grilling'],
    removeLabel: [TASK, 'model: max-code'],
    getAccessLevel: [TASK, 'octocat'],
    isSelf: ['octocat'],
    readControls: [task],
    ensureLabels: [],
  };

  it.each(Object.entries(passThrough))(
    '%s reaches the wrapped provider with unchanged arguments and returns its result',
    async (method, args) => {
      const { issues, calls, warn } = setup();
      const call = (
        issues[method as keyof IssueProvider] as (...a: unknown[]) => unknown
      ).bind(issues);

      expect(await call(...args)).toEqual({ from: method });

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe(method);
      expect(calls[0].args).toHaveLength(args.length);
      calls[0].args.forEach((arg, index) => expect(arg).toBe(args[index]));
      expect(warn).not.toHaveBeenCalled();
    },
  );
});
