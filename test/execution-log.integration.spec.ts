import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ExecutionLogService,
  type ExecutionLogEntry,
} from '../src/llm/execution-log.service.js';
import { resetDatabase } from './db.js';
import { startApp, type TestApp } from './app.js';

// Spec 4 "Owned table: ExecutionLog" against the real test PostgreSQL.

const TASK = {
  platform: 'GITHUB' as const,
  id: '6369421471',
  externalRef: 'test-owner/test-repo#14',
};
const COMMIT = 'ab12'.repeat(10);
const PROMPT = [
  { type: 'system', data: { content: 'frame and skill' } },
  {
    type: 'human',
    data: {
      content: '<untrusted-data-x source="d">\ntext\n</untrusted-data-x>',
    },
  },
];

function entry(overrides: Partial<ExecutionLogEntry> = {}): ExecutionLogEntry {
  return {
    task: TASK,
    runId: 'smoke-abc',
    lane: 'full-sdd',
    step: 'spec',
    model: { provider: 'google', name: 'gemini-4-hydrogen', level: 'standard' },
    skillCommit: COMMIT,
    attempt: 1,
    durationMs: 1234.4,
    sizes: { frame: 10, skill: 20, untrusted: 30, other: 4 },
    answerChars: 17,
    injectionKinds: ['override-instructions'],
    cutSources: ['description'],
    prompt: PROMPT,
    answer: { type: 'ai', data: { content: '{"summary":"ok"}' } },
    usage: {
      input_tokens: 293,
      output_tokens: 390,
      total_tokens: 683,
      input_token_details: { cache_read: 0 },
      output_token_details: { reasoning: 346 },
    },
    providerMeta: { finish_reason: 'STOP', model_provider: 'google' },
    ...overrides,
  };
}

describe('ExecutionLogService (real PostgreSQL)', () => {
  let t: TestApp;
  let logs: ExecutionLogService;

  beforeAll(async () => {
    t = await startApp();
    logs = t.app.get(ExecutionLogService);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('a success row holds every column', async () => {
    const id = await logs.record(entry());

    expect(
      await t.prisma.executionLog.findUniqueOrThrow({ where: { id } }),
    ).toEqual({
      id,
      createdAt: expect.any(Date) as Date,
      platform: 'GITHUB',
      taskId: '6369421471',
      externalRef: 'test-owner/test-repo#14',
      runId: 'smoke-abc',
      lane: 'full-sdd',
      step: 'spec',
      provider: 'google',
      model: 'gemini-4-hydrogen',
      modelLevel: 'standard',
      skillCommit: COMMIT,
      attempt: 1,
      status: 'SUCCESS',
      errorCode: null,
      errorMessage: null,
      durationMs: 1234,
      inputTokens: 293,
      outputTokens: 390,
      cachedInputTokens: 0,
      reasoningTokens: 346,
      frameChars: 10,
      skillChars: 20,
      untrustedChars: 30,
      otherChars: 4,
      answerChars: 17,
      injectionKinds: ['override-instructions'],
      cutSources: ['description'],
      prompt: PROMPT,
      answer: { type: 'ai', data: { content: '{"summary":"ok"}' } },
      providerUsage: entry().usage,
      providerMeta: { finish_reason: 'STOP', model_provider: 'google' },
    });
  });

  it('an error row: its code, the message cut at 2,000 characters, no answer, empty token columns', async () => {
    const id = await logs.record(
      entry({
        runId: undefined,
        lane: undefined,
        attempt: 3,
        error: { code: 'provider-unavailable', message: 'm'.repeat(5_000) },
        answer: undefined,
        answerChars: undefined,
        usage: undefined,
        providerMeta: undefined,
        injectionKinds: [],
        cutSources: [],
      }),
    );

    const row = await t.prisma.executionLog.findUniqueOrThrow({
      where: { id },
    });
    expect(row).toMatchObject({
      runId: null,
      lane: null,
      attempt: 3,
      status: 'ERROR',
      errorCode: 'provider-unavailable',
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      answerChars: null,
      answer: null,
      providerUsage: null,
      providerMeta: null,
      injectionKinds: [],
      cutSources: [],
      prompt: PROMPT,
    });
    expect(row.errorMessage).toHaveLength(2_000);
  });

  it('usage without the two details leaves cached and reasoning empty, not zero', async () => {
    const id = await logs.record(
      entry({ usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 } }),
    );

    expect(
      await t.prisma.executionLog.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      inputTokens: 5,
      outputTokens: 6,
      cachedInputTokens: null,
      reasoningTokens: null,
    });
  });
});
