import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { InMemoryIssueProvider } from '../../test/fakes/in-memory-issue-provider.js';
import {
  InMemoryContextLoads,
  contextLoaderOver,
  testScanner,
} from '../../test/fakes/in-memory-context-loads.js';
import { ScriptedChatModelFactory } from '../../test/fakes/scripted-chat-model.factory.js';
import type { StepSetup } from '../contracts/step.js';
import type {
  ExecutionLogEntry,
  ExecutionLogService,
} from '../llm/execution-log.service.js';
import { InjectionWarningService } from '../llm/injection-warning.service.js';
import { SecretNoticeService } from '../llm/secret-notice.service.js';
import { LlmService } from '../llm/llm.service.js';
import { grillOutputSchema, type GrillOutputLimits } from './grill-output.js';

afterEach(() => vi.restoreAllMocks());

const LIMITS: GrillOutputLimits = { threshold: 95, lastAsked: 5 };
const QUESTION = {
  question: 'Who approves a split over 100 €?',
  guess: 'The group admin, since the issue says admins manage the group.',
};
const VALID = {
  confidence: 70,
  questions: [QUESTION],
  open: [2],
  gaps: ['who approves large splits'],
};

/** The messages of the issues Zod finds; empty = valid. */
function problems(value: unknown, limits = LIMITS): string[] {
  const result = grillOutputSchema(limits).safeParse(value);
  return result.success
    ? []
    : result.error.issues.map(({ message }) => message);
}

describe('grillOutputSchema (spec 6, GMW4)', () => {
  it('accepts an answer below the threshold with new questions, open numbers asked before and gaps', () => {
    expect(problems(VALID)).toEqual([]);
  });

  it('accepts an answer below the threshold that only waits for open questions', () => {
    expect(problems({ ...VALID, questions: [], open: [1, 5] })).toEqual([]);
  });

  it.each([
    [[7], 'open lists Q7, but only Q1–Q5 were asked'],
    [[0], 'open lists Q0, but only Q1–Q5 were asked'],
    [[-1], 'open lists Q-1, but only Q1–Q5 were asked'],
    [[2, 6, 9], 'open lists Q6, Q9, but only Q1–Q5 were asked'],
  ])('open %j with Q1–Q5 asked → asked again: "%s"', (open, message) => {
    expect(problems({ ...VALID, open })).toEqual([message]);
  });

  it('before the first question comment, and after one question, the message says what was asked', () => {
    expect(
      problems({ ...VALID, open: [1] }, { threshold: 95, lastAsked: 0 }),
    ).toEqual(['open lists Q1, but no question was asked yet']);
    expect(
      problems({ ...VALID, open: [1, 2] }, { threshold: 95, lastAsked: 1 }),
    ).toEqual(['open lists Q2, but only Q1 was asked']);
  });

  it('below the threshold with no question and nothing open → asked again, naming the threshold', () => {
    const waitingForNothing = { ...VALID, questions: [], open: [] };

    expect(problems(waitingForNothing)).toEqual([
      'below 95 you must ask at least one new question or list the open questions you are waiting for',
    ]);
    expect(
      problems(waitingForNothing, { threshold: 80, lastAsked: 5 }),
    ).toEqual([
      'below 80 you must ask at least one new question or list the open questions you are waiting for',
    ]);
  });

  it.each([
    [
      'a question over 600 characters',
      { questions: [{ ...QUESTION, question: 'x'.repeat(601) }] },
    ],
    [
      'a guess over 600 characters',
      { questions: [{ ...QUESTION, guess: 'x'.repeat(601) }] },
    ],
    ['a gap over 200 characters', { gaps: ['x'.repeat(201)] }],
    ['11 gaps', { gaps: Array.from({ length: 11 }, (_, i) => `gap ${i}`) }],
    ['21 questions', { questions: Array.from({ length: 21 }, () => QUESTION) }],
    [
      'a question of spaces only',
      { questions: [{ ...QUESTION, question: '   ' }] },
    ],
    ['an empty guess', { questions: [{ ...QUESTION, guess: '' }] }],
    ['a gap of spaces only', { gaps: ['  '] }],
    ['a confidence over 100', { confidence: 101 }],
    ['a negative confidence', { confidence: -1 }],
    ['a confidence that is not an integer', { confidence: 70.5 }],
    ['an open number that is not an integer', { open: [2.5] }],
  ])('%s → asked again', (_, change) => {
    expect(problems({ ...VALID, ...change })).not.toEqual([]);
  });

  it('the limits themselves are fine: 600 and 200 characters, 10 gaps, 20 questions; texts are trimmed', () => {
    const answer = {
      ...VALID,
      questions: [
        { question: `  ${'q'.repeat(600)}  `, guess: 'g'.repeat(600) },
        ...Array.from({ length: 19 }, () => QUESTION),
      ],
      gaps: Array.from({ length: 10 }, () => 'x'.repeat(200)),
    };

    const parsed = grillOutputSchema(LIMITS).parse(answer);

    expect(parsed.questions).toHaveLength(20);
    expect(parsed.questions[0].question).toBe('q'.repeat(600));
  });

  it('at or above the threshold the bot writes the Spec: questions and open numbers, even unknown ones, are not checked', () => {
    expect(problems({ ...VALID, confidence: 95, open: [7] })).toEqual([]);
    expect(
      problems({ confidence: 100, questions: [], open: [], gaps: [] }),
    ).toEqual([]);
  });

  it('Gemini can get it as a JSON schema: the four fields, all required', () => {
    const schema = z.toJSONSchema(grillOutputSchema(LIMITS));

    expect(schema).toMatchObject({
      type: 'object',
      required: ['confidence', 'questions', 'open', 'gaps'],
      properties: {
        confidence: { type: 'integer', minimum: 0, maximum: 100 },
        questions: { type: 'array', maxItems: 20 },
        open: { type: 'array', items: { type: 'integer' } },
        gaps: { type: 'array', maxItems: 10 },
      },
    });
  });
});

describe('grillOutputSchema through LlmService.call (spec 4)', () => {
  const SETUP: StepSetup = {
    commit: 'ab12'.repeat(10),
    skill: {
      step: 'grill',
      path: '.github-agent/skills/grill',
      commit: 'ab12'.repeat(10),
      instructions: 'Placeholder skill.',
      files: [],
    },
    model: {
      provider: 'scripted',
      name: 'gemini-4-hydrogen',
      level: 'standard',
    },
    repo: { rootAgents: null, skills: [], agents: [] },
  };

  it('the request carries the format; Zod judges the answer, and a mismatch is re-asked with the rule’s message', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const factory = new ScriptedChatModelFactory()
      .replyJson({ ...VALID, open: [7] })
      .replyJson(VALID);
    const issues = new InMemoryIssueProvider('test-owner/test-repo');
    const task = issues.seedIssue({ number: 12 });
    const rows: ExecutionLogEntry[] = [];
    const logs = {
      record: vi.fn((entry: ExecutionLogEntry) => {
        rows.push(entry);
        return Promise.resolve(`log-${rows.length}`);
      }),
    } as unknown as ExecutionLogService;
    const loads = new InMemoryContextLoads();
    const service = new LlmService(
      factory,
      new InjectionWarningService(issues),
      new SecretNoticeService(issues),
      logs,
      loads.asService(),
      contextLoaderOver(undefined, loads),
      testScanner(),
    );

    const result = await service.call({
      context: { task, step: 'grill', lane: 'full-sdd', runId: 'run-1' },
      setup: SETUP,
      frame: 'You are Grill Me.',
      turns: [{ role: 'user', blocks: [{ kind: 'text', text: 'The issue.' }] }],
      output: grillOutputSchema(LIMITS),
    });

    expect(result.output).toEqual(VALID);
    expect(
      factory.calls.map(({ tools, schema }) => ({ tools, schema })),
    ).toEqual([
      { tools: [], schema: true },
      { tools: [], schema: true },
    ]);
    expect(factory.calls[1].messages.at(-1)?.text).toContain(
      'open lists Q7, but only Q1–Q5 were asked',
    );
    expect(rows.map(({ attempt, error }) => [attempt, error?.code])).toEqual([
      [1, 'invalid-answer'],
      [2, undefined],
    ]);
  });
});
