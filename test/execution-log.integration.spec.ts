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
const CALL_ID = '00000000-0000-4000-8000-0000000000c1';
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
    callId: CALL_ID,
    turn: 1,
    durationMs: 1234.4,
    sizes: {
      frame: 10,
      skill: 20,
      agents: 5,
      lists: 6,
      untrusted: 30,
      loaded: 7,
      other: 4,
    },
    answerChars: 17,
    injectionKinds: ['override-instructions'],
    secretKinds: [],
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
      callId: CALL_ID,
      turn: 1,
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
      agentsChars: 5,
      listsChars: 6,
      loadedChars: 7,
      answerChars: 17,
      injectionKinds: ['override-instructions'],
      secretKinds: [],
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

  it('spec 11: a later request of a call (turn 2, attempt 1) reads back as written', async () => {
    const id = await logs.record(entry({ turn: 2, attempt: 1 }));

    expect(
      await t.prisma.executionLog.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ callId: CALL_ID, turn: 2, attempt: 1 });
  });

  it('spec 11: without a call id and a turn (as before spec 11) → call_id empty, turn = attempt', async () => {
    const id = await logs.record(
      entry({ callId: undefined, turn: undefined, attempt: 3 }),
    );

    expect(
      await t.prisma.executionLog.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ callId: null, turn: 3, attempt: 3 });
  });

  it('spec 12 (plan DP3): secret_kinds as given; the stored prompt and answer hold no key-shaped string', async () => {
    // Built at run time: no key-shaped literal in the repo (plan DP22).
    const aws = ['AK', 'IA', 'IOSFODNN7EXAMPLE'].join('');
    const answer = {
      type: 'ai',
      data: { content: `{"summary":"use ${aws}"}`, tool_calls: [] },
    };
    const prompt = [
      ...PROMPT,
      { type: 'ai', data: { content: `earlier answer ${aws}` } },
    ];

    const id = await logs.record(
      entry({ secretKinds: ['google-api-key'], prompt, answer }),
    );

    const row = await t.prisma.executionLog.findUniqueOrThrow({
      where: { id },
    });
    expect(row.secretKinds).toEqual(['google-api-key']);
    expect(JSON.stringify([row.prompt, row.answer])).not.toContain(aws);
    expect(row.answer).toEqual({
      type: 'ai',
      data: {
        content: '{"summary":"use [REDACTED: aws-access-key]"}',
        tool_calls: [],
      },
    });
    expect(row.prompt).toEqual([
      ...PROMPT,
      {
        type: 'ai',
        data: { content: 'earlier answer [REDACTED: aws-access-key]' },
      },
    ]);
    // The entry itself is unchanged: the step and the model get the messages as they were.
    expect(answer.data.content).toContain(aws);
  });
});
