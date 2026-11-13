import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { Env } from '../config/env.schema.js';
import { SecretScanner } from './secret-scanner.js';

// Every token-shaped string is built at run time: none is written into the repo as a literal.
const join = (...parts: string[]) => parts.join('');
const ALNUM = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2dE3fG4h';
const tokens = {
  'github-token': [
    join('gh', 'p_', ALNUM.slice(0, 36)),
    join('gh', 's_', ALNUM.slice(0, 40)),
    join('github', '_pat_', '11ABCDEFG0', 'abcdefghij_', 'klmnopqrst'),
  ],
  'google-api-key': [
    join('AI', 'za', 'Sy', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4-_o5p'),
  ],
  'aws-access-key': [
    join('AK', 'IA', 'ABCDEFGHIJ012345'),
    join('AS', 'IA', 'Z9Y8X7W6V5U4T3S2'),
  ],
  'slack-token': [join('xo', 'xb-', '1234567890-abcdefghij')],
  'private-key': [
    join(
      '-----BEGIN ',
      'RSA PRIVATE KEY-----\n',
      'MIIEowIBAAKCAQEA\n',
      'abc\n',
      '-----END RSA PRIVATE KEY-----',
    ),
    join(
      '-----BEGIN ',
      'PRIVATE KEY-----\n',
      'MIIEvQIBADANBgkq\n',
      '-----END PRIVATE KEY-----',
    ),
  ],
} as const;
const WEBHOOK_SECRET = ['hook', 'secret', 'value'].join('-');
const GOOGLE_KEY = ['own', 'google', 'value'].join('-');

function scannerWith(env: Partial<Env> = {}): SecretScanner {
  return new SecretScanner(
    new ConfigService<Env, true>({
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GOOGLE_API_KEY: GOOGLE_KEY,
      ...env,
    }),
  );
}

describe('SecretScanner', () => {
  const scanner = scannerWith();

  for (const [kind, values] of Object.entries(tokens)) {
    it.each(values.map((value, index) => [index, value] as const))(
      `finds and redacts ${kind} #%i`,
      (_index, value) => {
        const text = `before ${value} after`;

        expect(scanner.scan(text)).toEqual([
          { kind, start: 7, end: 7 + value.length },
        ]);
        expect(scanner.redact(text)).toEqual({
          text: `before [REDACTED: ${kind}] after`,
          findings: [{ kind }],
        });
      },
    );
  }

  it.each([
    ['the webhook secret', WEBHOOK_SECRET],
    ['the Google key', GOOGLE_KEY],
  ])('finds %s as own-secret, every time it appears', (_name, value) => {
    expect(scanner.redact(`${value} and ${value}.`)).toEqual({
      text: '[REDACTED: own-secret] and [REDACTED: own-secret].',
      findings: [{ kind: 'own-secret' }, { kind: 'own-secret' }],
    });
  });

  it('redacts two different hits in one text, in order', () => {
    const github = tokens['github-token'][0];
    const slack = tokens['slack-token'][0];

    expect(scanner.redact(`a ${slack} b ${github} c`)).toEqual({
      text: 'a [REDACTED: slack-token] b [REDACTED: github-token] c',
      findings: [{ kind: 'slack-token' }, { kind: 'github-token' }],
    });
  });

  it('a key block without its END line is redacted to the end of the text', () => {
    const block = join(
      '-----BEGIN ',
      'OPENSSH PRIVATE KEY-----\n',
      'b3BlbnNzaC1rZXktdjEA\n',
      'more lines',
    );

    expect(scanner.redact(`key:\n${block}`)).toEqual({
      text: 'key:\n[REDACTED: private-key]',
      findings: [{ kind: 'private-key' }],
    });
  });

  it('a token inside a key block is part of the one private-key finding', () => {
    const block = join(
      '-----BEGIN ',
      'PRIVATE KEY-----\n',
      tokens['github-token'][0],
      '\n-----END PRIVATE KEY-----',
    );

    expect(scanner.redact(`${block} tail`)).toEqual({
      text: '[REDACTED: private-key] tail',
      findings: [{ kind: 'private-key' }],
    });
  });

  it('an own secret that is also a Google key → one finding, named by the pattern', () => {
    const key = tokens['google-api-key'][0];
    const own = scannerWith({ GOOGLE_API_KEY: key });

    expect(own.redact(`x ${key} y`)).toEqual({
      text: 'x [REDACTED: google-api-key] y',
      findings: [{ kind: 'google-api-key' }],
    });
  });

  it.each([
    ['a 40-character commit SHA', 'ab12'.repeat(10)],
    ['a UUID', '9f1c2b7e-3d4a-4c5b-8e6f-0a1b2c3d4e5f'],
    ['a delivery ID', '72d3162e-cc78-11e3-81ab-4c9367dc0958'],
    ['a hidden marker', '<!-- sdd-agent:label-revert:model-max-code -->'],
    ['a token prefix with too few characters', join('gh', 'p_', 'abc123')],
    ['a short Google-like key', join('AI', 'za', 'short')],
    ['lowercase AWS-like text', join('ak', 'ia', 'abcdefghij012345')],
    ['a BEGIN line of a public key', '-----BEGIN PUBLIC KEY-----'],
  ])('does not match %s', (_name, text) => {
    expect(scanner.scan(`see ${text} here`)).toEqual([]);
    expect(scanner.redact(`see ${text} here`).text).toBe(`see ${text} here`);
  });

  it('an own secret shorter than 8 characters is not matched', () => {
    const short = scannerWith({ GITHUB_WEBHOOK_SECRET: 'abc1234' });

    expect(short.scan('the word abc1234 is fine')).toEqual([]);
  });

  it('a text without a secret comes back as the same string', () => {
    const text = 'Plain text with a SHA ' + 'cd34'.repeat(10) + '.';

    expect(scanner.redact(text)).toEqual({ text, findings: [] });
  });
});
