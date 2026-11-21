// `npm run llm:smoke` (spec 4 "Smoke script", L12, dev-only): the whole chain once with a real model call. A Nest
// application context with config, Prisma, GitHubModule and LlmModule: no HTTP server, no worker. Rows go to the
// dev database with run_id `smoke-<id>`. Stop `npm run dev` first (both build into dist/).
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
import { PrismaModule } from '../../prisma/prisma.module.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { InjectionWarningService } from '../injection-warning.service.js';
import { LlmModule } from '../llm.module.js';
import { LlmService } from '../llm.service.js';
import { StepConfigService } from '../step-config.service.js';
import {
  LLM_SMOKE_USAGE,
  parseSmokeArgs,
  runLlmSmoke,
} from './run-llm-smoke.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
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
const prisma = context.get(PrismaService);
const runId = `smoke-${Date.now().toString(36)}`;
const ok = await runLlmSmoke(
  {
    stepConfig: context.get(StepConfigService),
    warnings: context.get(InjectionWarningService),
    llm: context.get(LlmService),
    issues: context.get<IssueProvider>(ISSUE_PROVIDER),
    repo: context.get<RepoProvider>(REPO_PROVIDER),
    rowsOf: (id) =>
      prisma.executionLog.findMany({
        where: { runId: id },
        // Plan P20: a call's rows can share a millisecond.
        orderBy: [{ createdAt: 'asc' }, { turn: 'asc' }],
        select: {
          id: true,
          callId: true,
          turn: true,
          attempt: true,
          status: true,
          errorCode: true,
          model: true,
          modelLevel: true,
          durationMs: true,
          inputTokens: true,
          outputTokens: true,
          cachedInputTokens: true,
          reasoningTokens: true,
          frameChars: true,
          skillChars: true,
          untrustedChars: true,
          otherChars: true,
        },
      }),
    loadsOf: async (callId) => {
      const rows = await prisma.contextLoad.findMany({
        where: { callId },
        orderBy: [{ createdAt: 'asc' }, { turn: 'asc' }],
      });
      return Promise.all(
        rows.map(async (row) => ({
          turn: row.turn,
          trigger: row.trigger,
          path: row.path,
          requested: row.requested,
          reason: row.reason,
          outcome: row.outcome,
          tokens: row.tokens,
          estimatedTokens: row.estimatedTokens,
          // SDW17: `known` when an earlier row of the same path, commit and model already had a count.
          earlierCount:
            row.path !== null &&
            (await prisma.contextLoad.count({
              where: {
                path: row.path,
                commit: row.commit,
                model: row.model,
                tokens: { not: null },
                createdAt: { lt: row.createdAt },
              },
            })) > 0,
        })),
      );
    },
    targetRepo: config.get('TARGET_REPO', { infer: true }),
  },
  {
    ...options,
    base: options.base ?? config.get('TARGET_BASE_BRANCH', { infer: true }),
    runId,
  },
  print,
);
print(ok ? 'Smoke: every check passed.' : 'Smoke: FAILED.');
await context.close();
process.exit(ok ? 0 : 1);
