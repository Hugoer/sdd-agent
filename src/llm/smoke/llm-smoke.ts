// `npm run llm:smoke` (spec 4, dev-only). First form (plan P1, T4): one real model call through the provider
// seam. Config and the Google factory only: no HTTP server, no worker, no database, no GitHub.
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { parseArgs } from 'node:util';
import { validateEnv } from '../../config/env.schema.js';
import {
  CHAT_MODEL_FACTORY,
  type ChatModelFactory,
} from '../chat-model.factory.js';
import { GoogleChatModelFactory } from '../google/google-chat-model.factory.js';
import { runLlmSmoke } from './run-llm-smoke.js';

const USAGE = 'Usage: npm run llm:smoke -- --try <model>';
const MODEL_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })],
  providers: [
    { provide: CHAT_MODEL_FACTORY, useClass: GoogleChatModelFactory },
  ],
})
class SmokeModule {}

const print = (line: string) => process.stdout.write(`${line}\n`);

function cliModel(): string | null {
  try {
    const { values } = parseArgs({ options: { try: { type: 'string' } } });
    return values.try && MODEL_NAME.test(values.try) ? values.try : null;
  } catch {
    return null; // unknown option or missing value
  }
}

const model = cliModel();
if (model === null) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(1);
}

const context = await NestFactory.createApplicationContext(SmokeModule, {
  abortOnError: false,
  logger: ['error', 'warn'], // the output is the check lines
});
const ok = await runLlmSmoke(
  context.get<ChatModelFactory>(CHAT_MODEL_FACTORY),
  { model },
  print,
);
print(ok ? 'Smoke: every check passed.' : 'Smoke: FAILED.');
await context.close();
process.exit(ok ? 0 : 1);
