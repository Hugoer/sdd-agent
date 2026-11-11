// `npm run github:smoke` (spec 3, dev-only): runs the provider checks against TARGET_REPO on real GitHub.
// Config and GitHubModule only: no HTTP server, no worker, no database. The startup checks run first.
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { parseArgs } from 'node:util';
import { validateEnv, type Env } from '../../config/env.schema.js';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
} from '../../contracts/issue-provider.js';
import {
  REPO_PROVIDER,
  type RepoProvider,
} from '../../contracts/repo-provider.js';
import { GitHubStartupError } from '../github-startup.js';
import { GitHubModule } from '../github.module.js';
import { runSmoke } from './run-smoke.js';

const USAGE =
  'Usage: npm run github:smoke -- --issue <n> [--base main] [--dir .github-agent] [--branch <name> --sha <head commit>]';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    GitHubModule,
  ],
})
class SmokeModule {}

const print = (line: string) => process.stdout.write(`${line}\n`);

interface CliOptions {
  issue: number;
  base: string;
  dir: string;
  branch?: string;
  sha?: string;
}

function cliOptions(): CliOptions | null {
  try {
    const { values } = parseArgs({
      options: {
        issue: { type: 'string' },
        base: { type: 'string', default: 'main' },
        dir: { type: 'string', default: '.github-agent' },
        branch: { type: 'string' },
        sha: { type: 'string' },
      },
    });
    const { issue, base, dir, branch, sha } = values;
    if (!issue || !/^[1-9]\d*$/.test(issue)) return null;
    if (!branch !== !sha) return null; // both or neither
    if (sha && !/^[0-9a-f]{40}$/i.test(sha)) return null; // check runs need the full SHA
    return { issue: Number(issue), base, dir, branch, sha };
  } catch {
    return null; // unknown option or missing value
  }
}

const options = cliOptions();
if (options === null) {
  process.stderr.write(`${USAGE}\n`);
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
const ok = await runSmoke(
  {
    issues: context.get<IssueProvider>(ISSUE_PROVIDER),
    repo: context.get<RepoProvider>(REPO_PROVIDER),
    fetch: globalThis.fetch,
  },
  {
    ...options,
    targetRepo: config.get('TARGET_REPO', { infer: true }),
    runId: Date.now().toString(36),
  },
  print,
);
print(ok ? 'Smoke: every check passed.' : 'Smoke: FAILED.');
await context.close();
process.exit(ok ? 0 : 1);
