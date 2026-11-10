import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { appOptions, configureApp } from '../src/app.setup.js';
import { EventsWorker } from '../src/events/events.worker.js';
import {
  HelloCommentService,
  type HelloTarget,
} from '../src/events/hello/hello-comment.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabase } from './db.js';
import { testEnv } from './test-env.js';

const succeed = (): Promise<void> => Promise.resolve();

/** Stands in for GitHub: records every call; `behavior` makes it fail or hang. */
export class FakeHelloCommentService {
  readonly calls: HelloTarget[] = [];
  behavior: (target: HelloTarget) => Promise<void> = succeed;

  postHello(target: HelloTarget): Promise<void> {
    this.calls.push(target);
    return this.behavior(target);
  }

  reset(): void {
    this.calls.length = 0;
    this.behavior = succeed;
  }
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
  hello: FakeHelloCommentService;
  baseUrl: string;
}

export interface StartOptions {
  /** Run the real 1 s polling loop instead of the manual worker. */
  pollingWorker?: boolean;
  /** Keep existing rows (default: empty the database before boot). */
  keepData?: boolean;
}

/** Boots the real app on a random local port; GitHub is always faked. */
export async function startApp(options: StartOptions = {}): Promise<TestApp> {
  const hello = new FakeHelloCommentService();
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(HelloCommentService)
    .useValue(hello);
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
  await app.listen(0, '127.0.0.1');
  return {
    app,
    prisma,
    worker: app.get(EventsWorker),
    hello,
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

/** A minimal `issues.opened` payload for the sandbox repo. */
export function issuesOpenedPayload(installationId: number | null = 42) {
  return {
    action: 'opened',
    ...(installationId === null
      ? {}
      : { installation: { id: installationId } }),
    repository: { name: 'sdd-agent-sandbox', owner: { login: 'octo' } },
    issue: { number: 7 },
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
