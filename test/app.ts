import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { appOptions, configureApp } from '../src/app.setup.js';
import type {
  EventProcessor,
  ProcessResult,
} from '../src/events/event-processor.js';
import { EventsWorker } from '../src/events/events.worker.js';
import type { WebhookEvent } from '../src/generated/prisma/client.js';
import { GitHubClient } from '../src/github/github-client.js';
import { GitHubIssueProvider } from '../src/github/github-issue.provider.js';
import { GitHubRepoProvider } from '../src/github/github-repo.provider.js';
import { IntakeEventProcessor } from '../src/intake/intake-event.processor.js';
import { CHAT_MODEL_FACTORY } from '../src/llm/chat-model.factory.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabase } from './db.js';
import { InMemoryIssueProvider } from './fakes/in-memory-issue-provider.js';
import { InMemoryRepoProvider } from './fakes/in-memory-repo-provider.js';
import { ScriptedChatModelFactory } from './fakes/scripted-chat-model.factory.js';
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

/**
 * Replaces everything that could reach GitHub or Google: the client (no request), the two adapters (fakes) and
 * the model factory (the scripted fake, plan P8: it throws when called with no scripted answer). The port tokens
 * stay the app's own, so every test goes through the secret scanner's wrappers (spec 4, plan P4).
 */
export function offlineProviders(
  builder: TestingModuleBuilder,
  issues = new InMemoryIssueProvider(testEnv.TARGET_REPO),
  repo = new InMemoryRepoProvider(testEnv.TARGET_REPO),
  models = new ScriptedChatModelFactory(),
): TestingModuleBuilder {
  return builder
    .overrideProvider(GitHubClient)
    .useClass(OfflineGitHubClient)
    .overrideProvider(GitHubIssueProvider)
    .useValue(issues)
    .overrideProvider(GitHubRepoProvider)
    .useValue(repo)
    .overrideProvider(CHAT_MODEL_FACTORY)
    .useValue(models);
}

/** Same worker without the polling loop: tests call `drainOnce()` themselves. */
class ManualEventsWorker extends EventsWorker {
  override async onApplicationBootstrap(): Promise<void> {
    this.requireProcessor();
    await this.resetInterrupted();
  }
}

type Step = (event: WebhookEvent) => Promise<ProcessResult>;

/**
 * A processor the test scripts (plan P3): the worker's rules are tested without any real processor.
 * Each call takes the next scripted step; with none left it answers DONE.
 */
export class ScriptedProcessor implements EventProcessor {
  /** Delivery IDs in the order they were processed. */
  readonly processed: string[] = [];
  private readonly steps: Step[] = [];

  /** The next calls run these steps, in order. */
  then(...steps: Step[]): this {
    this.steps.push(...steps);
    return this;
  }

  /** The next call throws this error. */
  failNext(error: Error): this {
    return this.then(() => Promise.reject(error));
  }

  /** The next call answers IGNORED with this reason. */
  ignoreNext(reason: string): this {
    return this.then(() => Promise.resolve({ status: 'IGNORED', reason }));
  }

  process(event: WebhookEvent): Promise<ProcessResult> {
    this.processed.push(event.deliveryId);
    const step = this.steps.shift();
    return step ? step(event) : Promise.resolve({ status: 'DONE' });
  }
}

export interface TestApp {
  app: NestExpressApplication;
  prisma: PrismaService;
  worker: EventsWorker;
  issues: InMemoryIssueProvider;
  repo: InMemoryRepoProvider;
  models: ScriptedChatModelFactory;
  baseUrl: string;
}

export interface StartOptions {
  /** Run the real 1 s polling loop instead of the manual worker. */
  pollingWorker?: boolean;
  /** Keep existing rows (default: empty the database before boot). */
  keepData?: boolean;
  /** The fake behind ISSUE_PROVIDER's scanner (default: a new one for TARGET_REPO). */
  issues?: InMemoryIssueProvider;
  /** The fake behind REPO_PROVIDER's scanner (default: a new one for TARGET_REPO). */
  repo?: InMemoryRepoProvider;
  /** The fake behind CHAT_MODEL_FACTORY (default: a new one with no scripted answer). */
  models?: ScriptedChatModelFactory;
  /** Registered with the worker in place of the app's own processor (plan P3). */
  processor?: EventProcessor;
}

/** Boots the real app on a random local port; GitHub is always faked (no request leaves the test). */
export async function startApp(options: StartOptions = {}): Promise<TestApp> {
  const issues =
    options.issues ?? new InMemoryIssueProvider(testEnv.TARGET_REPO);
  const repo = options.repo ?? new InMemoryRepoProvider(testEnv.TARGET_REPO);
  const models = options.models ?? new ScriptedChatModelFactory();
  let builder = offlineProviders(
    Test.createTestingModule({ imports: [AppModule] }),
    issues,
    repo,
    models,
  );
  if (!options.pollingWorker) {
    builder = builder
      .overrideProvider(EventsWorker)
      .useClass(ManualEventsWorker);
  }
  if (options.processor) {
    const processor = options.processor;
    // The app's processor is replaced by one that registers the scripted one through the same seam.
    builder = builder.overrideProvider(IntakeEventProcessor).useFactory({
      factory: (worker: EventsWorker) => ({
        onModuleInit: () => worker.registerProcessor(processor),
      }),
      inject: [EventsWorker],
    });
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
    repo,
    models,
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

/** A minimal signed-test `issues.opened` body (the spec's `common` helper): repo, sender and issue. */
export function issuesOpenedPayload(
  options: { repo?: string; sender?: string; number?: number } = {},
) {
  const number = options.number ?? 7;
  return {
    action: 'opened',
    repository: { full_name: options.repo ?? testEnv.TARGET_REPO },
    sender: { login: options.sender ?? 'dev-user' },
    issue: { id: 1000 + number, number },
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
