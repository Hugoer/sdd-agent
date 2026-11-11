import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { appOptions, configureApp } from './app.setup.js';
import type { Env } from './config/env.schema.js';
import { GitHubStartupError } from './github/github-startup.js';

const app = configureApp(
  await NestFactory.create<NestExpressApplication>(AppModule, appOptions),
);
const config = app.get<ConfigService<Env, true>>(ConfigService);
try {
  await app.listen(config.get('PORT', { infer: true }));
} catch (error) {
  // GitHub startup failed (spec 3, G3): one message, no stack trace, exit code 1, port never opened.
  if (!(error instanceof GitHubStartupError)) throw error;
  new Logger('Bootstrap').error(error.message);
  await app.close();
  process.exit(1);
}

const domain = config.get('NGROK_DOMAIN', { infer: true });
new Logger('Bootstrap').log(
  domain
    ? `Webhook URL: https://${domain}/webhooks/github`
    : 'NGROK_DOMAIN not set: no tunnel',
);
