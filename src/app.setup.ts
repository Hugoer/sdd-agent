import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** GitHub's maximum webhook payload (Express defaults to 100 kB). */
const JSON_BODY_LIMIT = '25mb';

// rawBody: the webhook guard verifies the HMAC over the exact request bytes.
export const appOptions: NestApplicationOptions = { rawBody: true };

/** Shared by main.ts and the integration tests, so tests run the real HTTP setup. */
export function configureApp(
  app: NestExpressApplication,
): NestExpressApplication {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.enableShutdownHooks();
  return app;
}
