import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema.js';

const dir = mkdtempSync(join(tmpdir(), 'env-schema-'));
const pemPath = join(dir, 'app.pem');
const notPemPath = join(dir, 'not-a-key.txt');
writeFileSync(
  pemPath,
  '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n',
);
writeFileSync(notPemPath, 'hello\n');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/sdd_agent',
  GITHUB_WEBHOOK_SECRET: 'webhook-secret',
  GITHUB_APP_ID: '123456',
  GITHUB_APP_PRIVATE_KEY_PATH: pemPath,
  TARGET_REPO: 'Hugoer/sdd-agent-sandbox',
  GOOGLE_API_KEY: 'test-google-key',
};

const TRACING_SWITCHES = [
  'LANGSMITH_TRACING',
  'LANGSMITH_TRACING_V2',
  'LANGCHAIN_TRACING',
  'LANGCHAIN_TRACING_V2',
];

function errorOf(config: Record<string, unknown>): string {
  try {
    validateEnv(config);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected validateEnv to throw');
}

describe('validateEnv', () => {
  it('accepts a valid config and applies defaults', () => {
    expect(validateEnv(valid)).toEqual({
      ...valid,
      GITHUB_APP_ID: 123456,
      PORT: 3000,
      NGROK_DOMAIN: '',
      TARGET_BASE_BRANCH: 'main',
      SESSION_LEASE_SECONDS: 120,
      GRILL_MAX_ROUNDS: 5,
      GRILL_MAX_QUESTIONS_PER_ROUND: 3,
      GRILL_CONFIDENCE_THRESHOLD: 95,
      SKILL_DISCOVERY_MAX_LOADS: 10,
      SKILL_DISCOVERY_MAX_BYTES: 204800,
      APPROVAL_LARGE_CHANGE_FILES: 15,
    });
  });

  it.each([
    ['GRILL_MAX_ROUNDS', '1', 1],
    ['GRILL_MAX_ROUNDS', '10', 10],
    ['GRILL_MAX_QUESTIONS_PER_ROUND', '1', 1],
    ['GRILL_MAX_QUESTIONS_PER_ROUND', '10', 10],
    ['GRILL_CONFIDENCE_THRESHOLD', '1', 1],
    ['GRILL_CONFIDENCE_THRESHOLD', '100', 100],
    ['SKILL_DISCOVERY_MAX_LOADS', '1', 1],
    ['SKILL_DISCOVERY_MAX_LOADS', '50', 50],
    ['SKILL_DISCOVERY_MAX_BYTES', '1024', 1024],
    ['SKILL_DISCOVERY_MAX_BYTES', '1048576', 1048576],
    ['APPROVAL_LARGE_CHANGE_FILES', '15', 15],
    ['APPROVAL_LARGE_CHANGE_FILES', '150', 150],
  ])('accepts %s=%s', (name, value, expected) => {
    expect(validateEnv({ ...valid, [name]: value })).toMatchObject({
      [name]: expected,
    });
  });

  it.each([
    ['30', 30],
    ['300', 300],
  ])('accepts SESSION_LEASE_SECONDS=%s', (value, expected) => {
    expect(
      validateEnv({ ...valid, SESSION_LEASE_SECONDS: value })
        .SESSION_LEASE_SECONDS,
    ).toBe(expected);
  });

  it('coerces PORT and keeps a bare NGROK_DOMAIN', () => {
    const env = validateEnv({
      ...valid,
      PORT: '8080',
      NGROK_DOMAIN: 'my-name.ngrok-free.app',
    });
    expect(env.PORT).toBe(8080);
    expect(env.NGROK_DOMAIN).toBe('my-name.ngrok-free.app');
  });

  it.each([
    ['PORT', '70000'],
    ['PORT', '0'],
    ['PORT', 'abc'],
    ['DATABASE_URL', 'mysql://user:pass@localhost/db'],
    ['GITHUB_APP_ID', '0'],
    ['GITHUB_APP_ID', 'abc'],
    ['GITHUB_APP_PRIVATE_KEY_PATH', join(dir, 'missing.pem')],
    ['GITHUB_APP_PRIVATE_KEY_PATH', notPemPath],
    ['NGROK_DOMAIN', 'https://x.ngrok-free.app/'],
    ['NGROK_DOMAIN', 'x.ngrok-free.app/path'],
    ['TARGET_REPO', 'foo'],
    ['TARGET_REPO', 'owner/'],
    ['TARGET_REPO', '/repo'],
    ['TARGET_REPO', 'owner/repo/extra'],
    ['TARGET_REPO', 'https://github.com/owner/repo'],
    ['TARGET_REPO', 'own_er/repo'],
    ['TARGET_REPO', 'owner/re po'],
    ['TARGET_REPO', 'owner/..'],
    ['TARGET_BASE_BRANCH', 'bad..name'],
    ['TARGET_BASE_BRANCH', '/main'],
    ['TARGET_BASE_BRANCH', 'main/'],
    ['TARGET_BASE_BRANCH', 'feature//x'],
    ['TARGET_BASE_BRANCH', 'main.lock'],
    ['TARGET_BASE_BRANCH', 'has space'],
    ['TARGET_BASE_BRANCH', 'a~b'],
    ['TARGET_BASE_BRANCH', 'x'.repeat(256)],
    ['SESSION_LEASE_SECONDS', '10'],
    ['SESSION_LEASE_SECONDS', 'abc'],
    ['SESSION_LEASE_SECONDS', '30.5'],
    ['GRILL_MAX_ROUNDS', '0'],
    ['GRILL_MAX_ROUNDS', '11'],
    ['GRILL_MAX_ROUNDS', 'abc'],
    ['GRILL_MAX_ROUNDS', '2.5'],
    ['GRILL_MAX_QUESTIONS_PER_ROUND', '0'],
    ['GRILL_MAX_QUESTIONS_PER_ROUND', '11'],
    ['GRILL_MAX_QUESTIONS_PER_ROUND', 'abc'],
    ['GRILL_MAX_QUESTIONS_PER_ROUND', '2.5'],
    ['GRILL_CONFIDENCE_THRESHOLD', '0'],
    ['GRILL_CONFIDENCE_THRESHOLD', '101'],
    ['GRILL_CONFIDENCE_THRESHOLD', 'abc'],
    ['GRILL_CONFIDENCE_THRESHOLD', '2.5'],
    ['SKILL_DISCOVERY_MAX_LOADS', '0'],
    ['SKILL_DISCOVERY_MAX_LOADS', '51'],
    ['SKILL_DISCOVERY_MAX_LOADS', 'abc'],
    ['SKILL_DISCOVERY_MAX_LOADS', '2.5'],
    ['SKILL_DISCOVERY_MAX_BYTES', '1023'],
    ['SKILL_DISCOVERY_MAX_BYTES', '1048577'],
    ['SKILL_DISCOVERY_MAX_BYTES', 'abc'],
    ['APPROVAL_LARGE_CHANGE_FILES', '14'],
    ['APPROVAL_LARGE_CHANGE_FILES', '151'],
    ['APPROVAL_LARGE_CHANGE_FILES', 'abc'],
    ['APPROVAL_LARGE_CHANGE_FILES', '2.5'],
  ])('rejects %s=%s naming the variable', (name, value) => {
    expect(errorOf({ ...valid, [name]: value })).toMatch(
      new RegExp(`- ${name}: `),
    );
  });

  it.each(['14', '151', 'abc', '2.5'])(
    'rejects APPROVAL_LARGE_CHANGE_FILES=%s with its range (spec 14)',
    (value) => {
      expect(
        errorOf({ ...valid, APPROVAL_LARGE_CHANGE_FILES: value }),
      ).toContain(
        '- APPROVAL_LARGE_CHANGE_FILES: must be an integer from 15 to 150',
      );
    },
  );

  it.each(Object.keys(valid))('requires %s', (name) => {
    expect(errorOf({ ...valid, [name]: undefined })).toContain(
      `- ${name}: is required`,
    );
  });

  it.each(['octo-org/my.repo_name-2', 'a/b', 'Owner/.github'])(
    'accepts TARGET_REPO=%s',
    (value) => {
      expect(validateEnv({ ...valid, TARGET_REPO: value }).TARGET_REPO).toBe(
        value,
      );
    },
  );

  it.each([
    'develop',
    'release/2026.11',
    'feature/my_branch-2',
    'x'.repeat(255),
  ])('accepts TARGET_BASE_BRANCH=%s', (value) => {
    expect(
      validateEnv({ ...valid, TARGET_BASE_BRANCH: value }).TARGET_BASE_BRANCH,
    ).toBe(value);
  });

  it.each(TRACING_SWITCHES)(
    'refuses %s=true and says tracing must be off',
    (name) => {
      for (const value of ['true', 'TRUE', ' true ']) {
        expect(errorOf({ ...valid, [name]: value })).toMatch(
          new RegExp(`- ${name}: .*tracing must be off`),
        );
      }
    },
  );

  it.each(TRACING_SWITCHES)('accepts %s unset, empty or false', (name) => {
    for (const value of [undefined, '', 'false']) {
      expect(() => validateEnv({ ...valid, [name]: value })).not.toThrow();
    }
  });

  it('lists every failing variable at once', () => {
    const message = errorOf({ PORT: '70000' });
    for (const name of [
      'PORT',
      'DATABASE_URL',
      'GITHUB_WEBHOOK_SECRET',
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY_PATH',
      'TARGET_REPO',
      'GOOGLE_API_KEY',
    ]) {
      expect(message).toContain(`- ${name}: `);
    }
  });

  it('never prints a value', () => {
    const message = errorOf({
      ...valid,
      PORT: '99999',
      DATABASE_URL: 'mysql://user:hunter2@localhost/db',
      GITHUB_APP_ID: 'secret-app-id',
      NGROK_DOMAIN: 'https://leaky.example/',
      TARGET_BASE_BRANCH: 'leaky..branch',
      LANGSMITH_TRACING: 'true',
    });
    for (const value of [
      '99999',
      'hunter2',
      'secret-app-id',
      'leaky',
      'true',
    ]) {
      expect(message).not.toContain(value);
    }
  });
});
