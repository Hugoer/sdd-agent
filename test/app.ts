import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { appOptions, configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabase } from './db.js';
import { testEnv } from './test-env.js';

export interface TestApp {
  app: NestExpressApplication;
  prisma: PrismaService;
  baseUrl: string;
}

/** Boots the real app on a random local port with an empty database. */
export async function startApp(
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<TestApp> {
  const moduleRef = await override(
    Test.createTestingModule({ imports: [AppModule] }),
  ).compile();
  const app = configureApp(
    moduleRef.createNestApplication<NestExpressApplication>({
      ...appOptions,
      logger: false,
    }),
  );
  await app.listen(0, '127.0.0.1');
  const prisma = app.get(PrismaService);
  await resetDatabase(prisma);
  return { app, prisma, baseUrl: await app.getUrl() };
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
