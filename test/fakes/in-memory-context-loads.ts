// Spec 11: an in-memory ContextLoadService for unit tests (the real one is tested against PostgreSQL in
// test/context-load.integration.spec.ts). Same contract: insert returns an id; only the two token columns change.
import type {
  ContextLoadEntry,
  ContextLoadService,
} from '../../src/llm/context-load.service.js';

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

  setEstimates(ids: string[], perChar: number): Promise<void> {
    for (const row of this.rows)
      if (ids.includes(row.id) && row.chars !== undefined)
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
