import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { appOptions, configureApp } from '../src/app.setup.js';
import { ISSUE_PROVIDER } from '../src/contracts/issue-provider.js';
import { EventsWorker } from '../src/events/events.worker.js';
import { GitHubClient } from '../src/github/github-client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabase } from './db.js';
import { InMemoryIssueProvider } from './fakes/in-memory-issue-provider.js';
import { testEnv } from './test-env.js';

/** Stands in for GitHubClient (plan P3): answers the startup steps and sends nothing. */
class OfflineGitHubClient {
  readonly targetRepo = testEnv.TARGET_REPO;
  connect() {
    const write = 'write';
    return Promise.resolve({
      id: 1,
      appSlug: 'test-app',
      permissions: {
        issues: write,
        pull_requests: write,
        contents: write,
        checks: write,
        metadata: 'read',
      },
    });
  }
  identifyBot() {
    return Promise.resolve({ login: 'test-app[bot]', userId: 1 });
  }
}

/** Replaces everything that could reach GitHub: the client (no request) and the provider ports (fakes). */
export function offlineGitHub(
  builder: TestingModuleBuilder,
  issues = new InMemoryIssueProvider(testEnv.TARGET_REPO),
): TestingModuleBuilder {
  return builder
    .overrideProvider(GitHubClient)
    .useClass(OfflineGitHubClient)
    .overrideProvider(ISSUE_PROVIDER)
    .useValue(issues);
}

/** Same worker without the polling loop: tests call `drainOnce()` themselves. */
class ManualEventsWorker extends EventsWorker {
  override async onApplicationBootstrap(): Promise<void> {
    await this.resetInterrupted();
  }
}

export interface TestApp {
  app: NestExpressApplication;
  prisma: PrismaService;
  worker: EventsWorker;
  issues: InMemoryIssueProvider;
  baseUrl: string;
}

export interface StartOptions {
  /** Run the real 1 s polling loop instead of the manual worker. */
  pollingWorker?: boolean;
  /** Keep existing rows (default: empty the database before boot). */
  keepData?: boolean;
  /** The fake behind ISSUE_PROVIDER (default: a new one for TARGET_REPO). */
  issues?: InMemoryIssueProvider;
}

/** Boots the real app on a random local port; GitHub is always faked (no request leaves the test). */
export async function startApp(options: StartOptions = {}): Promise<TestApp> {
  const issues =
    options.issues ?? new InMemoryIssueProvider(testEnv.TARGET_REPO);
  let builder = offlineGitHub(
    Test.createTestingModule({ imports: [AppModule] }),
    issues,
  );
  if (!options.pollingWorker) {
    builder = builder
      .overrideProvider(EventsWorker)
      .useClass(ManualEventsWorker);
  }
  const moduleRef = await builder.compile();
  const app = configureApp(
    moduleRef.createNestApplication<NestExpressApplication>({
      ...appOptions,
      logger: false,
    }),
  );
  const prisma = app.get(PrismaService);
  if (!options.keepData) await resetDatabase(prisma);
  try {
    await app.listen(0, '127.0.0.1');
  } catch (error) {
    await app.close();
    throw error;
  }
  return {
    app,
    prisma,
    worker: app.get(EventsWorker),
    issues,
    baseUrl: await app.getUrl(),
  };
}

export function sign(body: string): string {
  return (
    'sha256=' +
    createHmac('sha256', testEnv.GITHUB_WEBHOOK_SECRET)
      .update(body)
      .digest('hex')
  );
}

let deliveries = 0;
export const newDeliveryId = (): string => `test-${Date.now()}-${++deliveries}`;

/** POSTs a webhook signed with the test secret. `headers` override or (with undefined) drop defaults. */
export function postWebhook(
  baseUrl: string,
  body: string,
  headers: Record<string, string | undefined> = {},
): Promise<Response> {
  const all: Record<string, string | undefined> = {
    'content-type': 'application/json',
    'x-github-event': 'ping',
    'x-github-delivery': newDeliveryId(),
    'x-hub-signature-256': sign(body),
    ...headers,
  };
  const defined = Object.entries(all).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return fetch(`${baseUrl}/webhooks/github`, {
    method: 'POST',
    headers: defined,
    body,
  });
}

/** A minimal `issues.opened` payload for issue #7 (its fake: `issues.seedIssue({ number: 7 })`). */
export function issuesOpenedPayload(fullName = testEnv.TARGET_REPO) {
  return {
    action: 'opened',
    installation: { id: 42 },
    repository: { full_name: fullName },
    issue: { id: 1007, number: 7 },
  };
}

/** Polls `check` until it returns a value or `timeoutMs` passes. */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
