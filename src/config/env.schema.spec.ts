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
};

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
    });
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
  ])('rejects %s=%s naming the variable', (name, value) => {
    expect(errorOf({ ...valid, [name]: value })).toMatch(
      new RegExp(`- ${name}: `),
    );
  });

  it.each(Object.keys(valid))('requires %s', (name) => {
    expect(errorOf({ ...valid, [name]: undefined })).toContain(
      `- ${name}: is required`,
    );
  });

  it('lists every failing variable at once', () => {
    const message = errorOf({ PORT: '70000' });
    for (const name of [
      'PORT',
      'DATABASE_URL',
      'GITHUB_WEBHOOK_SECRET',
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY_PATH',
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
    });
    for (const value of ['99999', 'hunter2', 'secret-app-id', 'leaky']) {
      expect(message).not.toContain(value);
    }
  });
});
