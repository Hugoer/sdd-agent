// Spec 11: an in-memory ContextLoadService for unit tests (the real one is tested against PostgreSQL in
// test/context-load.integration.spec.ts). Same contract: insert returns an id; only the two token columns change.
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../src/config/env.schema.js';
import type {
  ContextLoadEntry,
  ContextLoadService,
} from '../../src/llm/context-load.service.js';
import { ContextLoaderService } from '../../src/llm/context-loader.service.js';
import type { LoadLimits } from '../../src/llm/context-tools.js';
import { RepoCatalogService } from '../../src/llm/repo-catalog.service.js';
import { SecretScanner } from '../../src/secret-scan/secret-scanner.js';
import { testEnv } from '../test-env.js';
import { InMemoryRepoProvider } from './in-memory-repo-provider.js';

export interface FakeContextLoad extends ContextLoadEntry {
  id: string;
  tokens: number | null;
  estimatedTokens: number | null;
}

export class InMemoryContextLoads implements Pick<
  ContextLoadService,
  'insert' | 'setEstimates' | 'setTokens' | 'knownTokens'
> {
  readonly rows: FakeContextLoad[] = [];

  /** As the service the app gets: `new LlmService(…, loads.asService())`. */
  asService(): ContextLoadService {
    return this as unknown as ContextLoadService;
  }

  insert(entry: ContextLoadEntry): Promise<string> {
    const id = `load-${this.rows.length + 1}`;
    this.rows.push({ ...entry, id, tokens: null, estimatedTokens: null });
    return Promise.resolve(id);
  }

  setEstimates(callId: string, turn: number, perChar: number): Promise<void> {
    for (const row of this.rows)
      if (row.callId === callId && row.turn === turn && row.chars !== undefined)
        row.estimatedTokens = Math.round(row.chars * perChar);
    return Promise.resolve();
  }

  setTokens(id: string, tokens: number): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) row.tokens = tokens;
    return Promise.resolve();
  }

  knownTokens(
    path: string,
    commit: string,
    model: string,
  ): Promise<number | null> {
    const row = this.rows.find(
      (candidate) =>
        candidate.path === path &&
        candidate.commit === commit &&
        candidate.model === model &&
        candidate.tokens !== null,
    );
    return Promise.resolve(row?.tokens ?? null);
  }
}

/**
 * A real ContextLoaderService over in-memory fakes, for unit tests that build LlmService by hand. The defaults:
 * an empty repo (nothing to load) and the `.env` defaults (10 files, 204,800 bytes).
 */
export function contextLoaderOver(
  repo = new InMemoryRepoProvider(),
  loads = new InMemoryContextLoads(),
  limits: LoadLimits = { maxLoads: 10, maxBytes: 204_800 },
  catalog = new RepoCatalogService(repo),
): ContextLoaderService {
  return new ContextLoaderService(
    repo,
    catalog,
    loads.asService(),
    new ConfigService<Env, true>({
      SKILL_DISCOVERY_MAX_LOADS: limits.maxLoads,
      SKILL_DISCOVERY_MAX_BYTES: limits.maxBytes,
    }),
    testScanner(),
  );
}

/** Spec 7 (plan P29): the scanner the loader redacts repo files with, over the test values of the bot's secrets. */
export function testScanner(): SecretScanner {
  return new SecretScanner(
    new ConfigService<Env, true>({
      GITHUB_WEBHOOK_SECRET: testEnv.GITHUB_WEBHOOK_SECRET,
      GOOGLE_API_KEY: testEnv.GOOGLE_API_KEY,
    }),
  );
}
