// `npm run llm:smoke` (spec 4, dev-only). Second form (plan P1, T16): checks 1–4 read the target repo's setup at
// the base branch, then one provisional model call with the step's model. Config, GitHubModule and LlmModule
// only: no HTTP server, no worker, no database yet. Stop `npm run dev` first (both build into dist/).
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { validateEnv, type Env } from '../../config/env.schema.js';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
} from '../../contracts/issue-provider.js';
import {
  REPO_PROVIDER,
  type RepoProvider,
} from '../../contracts/repo-provider.js';
import { GitHubModule } from '../../github/github.module.js';
import { GitHubStartupError } from '../../github/github-startup.js';
import {
  CHAT_MODEL_FACTORY,
  type ChatModelFactory,
} from '../chat-model.factory.js';
import { LlmModule } from '../llm.module.js';
import { StepConfigService } from '../step-config.service.js';
import {
  LLM_SMOKE_USAGE,
  parseSmokeArgs,
  runLlmSmoke,
} from './run-llm-smoke.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    GitHubModule,
    LlmModule,
  ],
})
class SmokeModule {}

const print = (line: string) => process.stdout.write(`${line}\n`);

const options = parseSmokeArgs(process.argv.slice(2));
if (options === null) {
  process.stderr.write(`${LLM_SMOKE_USAGE}\n`);
  process.exit(1);
}

let context;
try {
  context = await NestFactory.createApplicationContext(SmokeModule, {
    abortOnError: false,
    logger: ['error', 'warn'], // the output is the check lines
  });
} catch (error) {
  if (!(error instanceof GitHubStartupError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

const config = context.get<ConfigService<Env, true>>(ConfigService);
const ok = await runLlmSmoke(
  {
    factory: context.get<ChatModelFactory>(CHAT_MODEL_FACTORY),
    stepConfig: context.get(StepConfigService),
    issues: context.get<IssueProvider>(ISSUE_PROVIDER),
    repo: context.get<RepoProvider>(REPO_PROVIDER),
    targetRepo: config.get('TARGET_REPO', { infer: true }),
  },
  {
    ...options,
    base: options.base ?? config.get('TARGET_BASE_BRANCH', { infer: true }),
  },
  print,
);
print(ok ? 'Smoke: every check passed.' : 'Smoke: FAILED.');
await context.close();
process.exit(ok ? 0 : 1);
