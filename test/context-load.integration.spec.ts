import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ContextLoadService,
  type ContextLoadEntry,
  type LoadOutcome,
} from '../src/llm/context-load.service.js';
import { resetDatabase } from './db.js';
import { startApp, type TestApp } from './app.js';

// Spec 11 "Owned table: ContextLoad" against the real test PostgreSQL.

const TASK = {
  platform: 'GITHUB' as const,
  id: '6369421471',
  externalRef: 'test-owner/test-repo#14',
};
const CALL_ID = '00000000-0000-4000-8000-0000000000c1';
const COMMIT = 'ab12'.repeat(10);
const MONEY = '.claude/skills/money-rules/SKILL.md';

function entry(overrides: Partial<ContextLoadEntry> = {}): ContextLoadEntry {
  return {
    task: TASK,
    runId: 'run-1',
    step: 'grill',
    callId: CALL_ID,
    turn: 1,
    trigger: 'tool',
    tool: 'load_skill',
    requested: 'money-rules',
    reason: 'The issue splits 1000 cents between three people.',
    kind: 'repo-skill',
    skill: 'money-rules',
    path: MONEY,
    commit: COMMIT,
    model: 'gemini-4-carbon',
    outcome: 'loaded',
    bytes: 1335,
    chars: 1330,
    injectionKinds: [],
    ...overrides,
  };
}

describe('ContextLoadService (real PostgreSQL)', () => {
  let t: TestApp;
  let loads: ContextLoadService;
  const row = (id: string) =>
    t.prisma.contextLoad.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    t = await startApp();
    loads = t.app.get(ContextLoadService);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('a loaded row holds every column; the token columns start empty', async () => {
    const id = await loads.insert(entry({ injectionKinds: ['bot-control'] }));

    expect(await row(id)).toEqual({
      id,
      createdAt: expect.any(Date) as Date,
      platform: 'GITHUB',
      taskId: '6369421471',
      externalRef: 'test-owner/test-repo#14',
      runId: 'run-1',
      step: 'grill',
      callId: CALL_ID,
      turn: 1,
      trigger: 'tool',
      tool: 'load_skill',
      requested: 'money-rules',
      reason: 'The issue splits 1000 cents between three people.',
      kind: 'repo-skill',
      skill: 'money-rules',
      path: MONEY,
      commit: COMMIT,
      model: 'gemini-4-carbon',
      outcome: 'loaded',
      bytes: 1335,
      chars: 1330,
      tokens: null,
      estimatedTokens: null,
      injectionKinds: ['bot-control'],
    });
  });

  it.each<LoadOutcome>([
    'already-loaded',
    'not-found',
    'too-large',
    'unreadable',
    'limit-reached',
    'error',
  ])('a %s row reads back, without characters', async (outcome) => {
    const id = await loads.insert(entry({ outcome, chars: undefined }));

    expect(await row(id)).toMatchObject({ outcome, chars: null });
  });

  it('a start row: turn 0, no tool, no request, no reason', async () => {
    const id = await loads.insert(
      entry({
        turn: 0,
        trigger: 'start',
        tool: undefined,
        requested: undefined,
        reason: undefined,
        kind: 'agents',
        skill: undefined,
        path: 'AGENTS.md',
      }),
    );

    expect(await row(id)).toMatchObject({
      turn: 0,
      trigger: 'start',
      tool: null,
      requested: null,
      reason: null,
      kind: 'agents',
      skill: null,
      path: 'AGENTS.md',
    });
  });

  it('the requested name and the reason are cut at 300 characters', async () => {
    const id = await loads.insert(
      entry({ requested: 'r'.repeat(400), reason: 'é'.repeat(400) }),
    );

    const { requested, reason } = await row(id);
    expect(requested).toBe('r'.repeat(300));
    expect(reason).toBe('é'.repeat(300));
  });

  it('setEstimates sets round(chars × perChar) on the rows with characters only; setTokens its own column', async () => {
    const loaded = await loads.insert(entry({ chars: 1000 }));
    const notFound = await loads.insert(
      entry({ outcome: 'not-found', chars: undefined }),
    );
    const other = await loads.insert(entry({ chars: 500 }));

    await loads.setEstimates([loaded, notFound], 0.2505);
    await loads.setTokens(loaded, 241);

    expect(await row(loaded)).toMatchObject({
      estimatedTokens: 251,
      tokens: 241,
      chars: 1000,
      outcome: 'loaded',
    });
    expect(await row(notFound)).toMatchObject({
      estimatedTokens: null,
      tokens: null,
    });
    expect(await row(other)).toMatchObject({
      estimatedTokens: null,
      tokens: null,
    });
    await expect(loads.setEstimates([], 1)).resolves.toBeUndefined();
  });

  it('knownTokens finds a stored count by path, commit and model, and ignores another model or commit', async () => {
    const id = await loads.insert(entry());
    await loads.insert(entry({ model: 'gemini-4-other' }));
    expect(
      await loads.knownTokens(MONEY, COMMIT, 'gemini-4-carbon'),
    ).toBeNull();

    await loads.setTokens(id, 241);

    expect(await loads.knownTokens(MONEY, COMMIT, 'gemini-4-carbon')).toBe(241);
    expect(await loads.knownTokens(MONEY, COMMIT, 'gemini-4-other')).toBeNull();
    expect(
      await loads.knownTokens(MONEY, 'cd34'.repeat(10), 'gemini-4-carbon'),
    ).toBeNull();
  });
});
