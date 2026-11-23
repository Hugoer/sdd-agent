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
import { DocumentsHandler } from '../src/documents/documents.handler.js';
import { GoSignalHandler } from '../src/documents/go-signal.handler.js';
import { PlanHandler } from '../src/documents/plan.handler.js';
import { SpecHandler } from '../src/documents/spec.handler.js';
import { GrillHandler } from '../src/grill/grill.handler.js';
import { IntakeService } from '../src/intake/intake.service.js';
import { CHAT_MODEL_FACTORY } from '../src/llm/chat-model.factory.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import type { StepHandler } from '../src/workflow/step-handler.registry.js';
import { WorkflowEventProcessor } from '../src/workflow/workflow-event.processor.js';
import { StepNotBuiltError } from '../src/workflow/workflow-errors.js';
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
    this.logProcessor();
    await this.resetInterrupted();
  }
}

type Step = (event: WebhookEvent) => Promise<ProcessResult>;
type FailedHook = (event: WebhookEvent, error: unknown) => Promise<void>;

/**
 * A processor the test scripts (plan P3): the worker's rules are tested without any real processor.
 * Each call takes the next scripted step; with none left it answers DONE.
 */
export class ScriptedProcessor implements EventProcessor {
  /** Delivery IDs in the order they were processed. */
  readonly processed: string[] = [];
  /** Spec 5: every failed() call, with the row as the worker saved it and the error. */
  readonly failedCalls: { event: WebhookEvent; error: unknown }[] = [];
  /** Spec 5: what failed() does after it is recorded (default: nothing). */
  onFailed: FailedHook = () => Promise.resolve();
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

  failed(event: WebhookEvent, error: unknown): Promise<void> {
    this.failedCalls.push({ event, error });
    return this.onFailed(event, error);
  }

  /** Forgets what earlier tests scripted and recorded. */
  reset(): void {
    this.processed.length = 0;
    this.failedCalls.length = 0;
    this.steps.length = 0;
    this.onFailed = () => Promise.resolve();
  }
}

/**
 * Spec 5, plan P11: what spec 2's placeholder did (accepted → DONE, ignored → IGNORED), so spec 2's suite keeps
 * testing intake alone while the app's own processor is the router.
 */
export class IntakeOnlyProcessor implements EventProcessor {
  constructor(private readonly intake: IntakeService) {}

  async process(event: WebhookEvent): Promise<ProcessResult> {
    const result = await this.intake.intake(event);
    return result.outcome === 'accepted'
      ? { status: 'DONE' }
      : { status: 'IGNORED', reason: result.reason };
  }

  failed(): Promise<void> {
    return Promise.resolve();
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
  /**
   * Registered with the worker in place of the app's own processor, the router (spec 1 plan P3);
   * `'intake-only'`: spec 2's behavior (spec 5 plan P11).
   */
  processor?: EventProcessor | 'intake-only';
  /**
   * Spec 6 plan P8: the `grill` handler GrillModule registers. Default: one that stops the run as an unbuilt step,
   * as before spec 6, so spec 5's suites keep testing the router alone; a scripted handler; or `'real'`.
   */
  grill?: StepHandler | 'real';
  /**
   * Spec 7 plan P8: the four handlers DocumentsModule registers (`spec`, `plan`, `go-signal`, `documents`).
   * Default: ones that stop the run as unbuilt steps, as before spec 7, so spec 5's and 6's suites keep their
   * `step-not-built` stops; `'real'`; or scripted ones by name (the others stay stubs). Each stub comes with the
   * task that registers its real handler (T9, T11, T13, T15).
   */
  documents?: 'real' | Partial<Record<DocumentHandler, StepHandler>>;
}

/** Spec 7: the handlers DocumentsModule registers. */
export type DocumentHandler = 'spec' | 'plan' | 'go-signal' | 'documents';

/** Spec 7 plan P8: each document handler's provider, replaced by default with an unbuilt step. */
const DOCUMENT_HANDLERS = {
  spec: SpecHandler,
  plan: PlanHandler,
  'go-signal': GoSignalHandler,
  documents: DocumentsHandler,
} as const;

/** What the router did before a step existed (`step-not-built` at that step), with no cancel hook. */
const notBuilt = (step: string): StepHandler => ({
  run: () => Promise.reject(new StepNotBuiltError(step)),
});

/** Spec 6 plan P8: what the router did before Grill Me existed (`step-not-built` at `grill`). */
const GRILL_NOT_BUILT: StepHandler = {
  run: () => Promise.reject(new StepNotBuiltError('grill')),
};

/**
 * The handler as a plain object: Nest awaits a provider value that has a `then` method, and the scripted
 * handler's `then` (its script) would never resolve. Keeps `onCancel` only when the handler has one.
 */
function asProvider(handler: StepHandler): StepHandler {
  return {
    run: (context) => handler.run(context),
    ...(handler.onCancel && {
      onCancel: (context) => handler.onCancel!(context),
    }),
  };
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
  if (options.grill !== 'real') {
    builder = builder
      .overrideProvider(GrillHandler)
      .useValue(asProvider(options.grill ?? GRILL_NOT_BUILT));
  }
  if (options.documents !== 'real') {
    for (const [name, provider] of Object.entries(DOCUMENT_HANDLERS)) {
      const scripted = options.documents?.[name as DocumentHandler];
      builder = builder
        .overrideProvider(provider)
        .useValue(asProvider(scripted ?? notBuilt(name)));
    }
  }
  if (options.processor) {
    const chosen = options.processor;
    // The app's processor is replaced by one that registers the chosen one through the same seam.
    builder = builder.overrideProvider(WorkflowEventProcessor).useFactory({
      factory: (worker: EventsWorker, intake: IntakeService) => ({
        onModuleInit: () =>
          worker.registerProcessor(
            chosen === 'intake-only' ? new IntakeOnlyProcessor(intake) : chosen,
          ),
      }),
      inject: [EventsWorker, IntakeService],
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
