// Scripted `fetch` for the GitHub adapter unit tests (spec 3, G13, plan P1). Octokit runs for real;
// only the network is replaced. Every request is recorded; an unscripted one answers 501.
import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../../src/config/env.schema.js';
import { GitHubClient } from '../../src/github/github-client.js';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string;
  accept: string;
  body: unknown;
}

export interface ScriptedResponse {
  status?: number;
  body?: unknown;
  /** A body sent as it is (not JSON), e.g. GitHub's `sha` media type; `headers` gives its content type. */
  text?: string;
  headers?: Record<string, string>;
}

/** `no-response`: the connection fails; `hang`: never answers (until the request's signal aborts). */
export type Scripted =
  | ScriptedResponse
  | 'no-response'
  | 'hang'
  | ((request: RecordedRequest) => ScriptedResponse);

interface Route {
  method: string;
  path: string | RegExp;
  responses: Scripted[];
}

export class FakeGitHubFetch {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Route[] = [];

  /** Answers in order; the last answer repeats. Later `on()` calls for the same route win. */
  on(method: string, path: string | RegExp, ...responses: Scripted[]): this {
    this.routes.unshift({ method, path, responses });
    return this;
  }

  /** Requests to a path (all methods unless given), auth requests included. */
  to(path: string | RegExp, method?: string): RecordedRequest[] {
    return this.requests.filter(
      (request) =>
        matches(path, request.path) && (!method || request.method === method),
    );
  }

  readonly fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const request: RecordedRequest = {
      method,
      path: url.pathname,
      query: url.searchParams,
      authorization: headers.get('authorization') ?? '',
      accept: headers.get('accept') ?? '',
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    };
    this.requests.push(request);

    const route = this.routes.find(
      (r) => r.method === method && matches(r.path, request.path),
    );
    if (!route) {
      return Promise.resolve(
        respond({
          status: 501,
          body: { message: `unscripted ${method} ${request.path}` },
        }),
      );
    }
    const scripted =
      route.responses.length > 1
        ? route.responses.shift()!
        : route.responses[0];
    if (scripted === 'no-response') {
      return Promise.reject(
        new TypeError('fetch failed', {
          cause: new Error('connect ECONNREFUSED'),
        }),
      );
    }
    if (scripted === 'hang') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason as Error),
        );
      });
    }
    return Promise.resolve(
      respond(typeof scripted === 'function' ? scripted(request) : scripted),
    );
  };
}

function matches(path: string | RegExp, actual: string): boolean {
  return typeof path === 'string' ? path === actual : path.test(actual);
}

function respond({
  status = 200,
  body,
  text,
  headers = {},
}: ScriptedResponse): Response {
  if (text !== undefined) return new Response(text, { status, headers });
  if (status === 204 || body === undefined)
    return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

// ── a client wired to the fake ──

export const TEST_APP_ID = 4242;
export const TEST_REPO = 'test-owner/test-repo';
export const TEST_INSTALLATION_ID = 77;
export const TEST_SLUG = 'test-app';
export const TEST_BOT_USER_ID = 9001;

export const ALL_PERMISSIONS = {
  issues: 'write',
  pull_requests: 'write',
  contents: 'write',
  checks: 'write',
  metadata: 'read',
};

let keyPath: string | undefined;

/** A real RSA key (GitHub's PKCS#1 form), generated once per test file. */
function testKeyPath(): string {
  if (!keyPath) {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    keyPath = join(mkdtempSync(join(tmpdir(), 'github-client-')), 'app.pem');
    writeFileSync(keyPath, privateKey);
  }
  return keyPath;
}

/** Scripts the startup calls (installation, installation token, bot user) with a healthy App. */
export function scriptInstallation(
  fake: FakeGitHubFetch,
  permissions: Record<string, string> = ALL_PERMISSIONS,
): FakeGitHubFetch {
  return fake
    .on('GET', `/repos/${TEST_REPO}/installation`, {
      body: { id: TEST_INSTALLATION_ID, app_slug: TEST_SLUG, permissions },
    })
    .on(
      'POST',
      `/app/installations/${TEST_INSTALLATION_ID}/access_tokens`,
      () => ({
        status: 201,
        body: {
          token: 'ghs_installationtoken',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      }),
    )
    .on('GET', `/users/${encodeURIComponent(`${TEST_SLUG}[bot]`)}`, {
      body: { login: `${TEST_SLUG}[bot]`, id: TEST_BOT_USER_ID },
    });
}

export function createTestClient(
  fake: FakeGitHubFetch,
  timeoutMs = 30_000,
): GitHubClient {
  const config = new ConfigService<Env, true>({
    GITHUB_APP_ID: TEST_APP_ID,
    GITHUB_APP_PRIVATE_KEY_PATH: testKeyPath(),
    TARGET_REPO: TEST_REPO,
  });
  return new GitHubClient(config, {
    fetch: fake.fetch,
    timeoutMs,
  });
}

/** A client already connected to the scripted installation. */
export async function connectedTestClient(
  fake: FakeGitHubFetch,
  timeoutMs?: number,
): Promise<GitHubClient> {
  scriptInstallation(fake);
  const client = createTestClient(fake, timeoutMs);
  await client.connect();
  return client;
}
