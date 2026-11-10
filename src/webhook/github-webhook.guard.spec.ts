import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GitHubWebhookGuard } from './github-webhook.guard.js';

const SECRET = 'test-secret';
const guard = new GitHubWebhookGuard(
  new ConfigService({ GITHUB_WEBHOOK_SECRET: SECRET }),
);

function sign(body: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function contextFor(
  signature: string | undefined,
  rawBody: Buffer | undefined,
): ExecutionContext {
  const req = {
    rawBody,
    header: (name: string) =>
      name.toLowerCase() === 'x-hub-signature-256' ? signature : undefined,
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const body = '{"zen":"Keep it logically awesome."}';

describe('GitHubWebhookGuard', () => {
  it('accepts the HMAC-SHA256 of the raw body', () => {
    expect(guard.canActivate(contextFor(sign(body), Buffer.from(body)))).toBe(
      true,
    );
  });

  it('accepts an empty body signed correctly', () => {
    expect(guard.canActivate(contextFor(sign(''), Buffer.alloc(0)))).toBe(true);
  });

  it.each([
    ['missing header', undefined, Buffer.from(body)],
    ['empty header', '', Buffer.from(body)],
    [
      'no sha256= prefix',
      sign(body).slice('sha256='.length),
      Buffer.from(body),
    ],
    ['sha1 prefix', sign(body).replace('sha256=', 'sha1='), Buffer.from(body)],
    ['wrong secret', sign(body, 'other-secret'), Buffer.from(body)],
    ['body changed after signing', sign(body), Buffer.from(body + ' ')],
    ['truncated signature', sign(body).slice(0, -1), Buffer.from(body)],
    ['signature with extra characters', sign(body) + '0', Buffer.from(body)],
    ['missing raw body', sign(body), undefined],
    [
      'same length but non-ASCII (byte length differs)',
      sign(body).slice(0, -1) + 'é',
      Buffer.from(body),
    ],
  ])('rejects with 401: %s', (_case, signature, rawBody) => {
    expect(() => guard.canActivate(contextFor(signature, rawBody))).toThrow(
      UnauthorizedException,
    );
  });
});
