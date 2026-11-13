import { describe, expect, it } from 'vitest';
import {
  SCRIPTED_USAGE,
  ScriptedChatModelFactory,
  type ScriptedReply,
} from '../../../test/fakes/scripted-chat-model.factory.js';
import { LlmError } from '../../contracts/llm-error.js';
import { runLlmSmoke } from './run-llm-smoke.js';

const MODEL = 'gemini-test';
// Stand-ins for what must never be printed, built at run time.
const KEY = ['secret', 'key', 'value'].join('-');
const ANSWER_TEXT = ['the', 'raw', 'answer', 'text'].join(' ');

async function run(...replies: ScriptedReply[]) {
  const factory = new ScriptedChatModelFactory().reply(...replies);
  const lines: string[] = [];
  let clock = 1_000;
  const ok = await runLlmSmoke(
    factory,
    { model: MODEL },
    (line) => lines.push(line),
    () => (clock += 250),
  );
  return { ok, lines, output: lines.join('\n'), factory };
}

function expectNothingSecret(output: string): void {
  for (const value of [KEY, ANSWER_TEXT, 'x-goog-api-key']) {
    expect(output).not.toContain(value);
  }
}

describe('runLlmSmoke', () => {
  it('a valid answer → PASS with model, duration, the four token values and the finish reason', async () => {
    const { ok, lines, factory } = await run({
      answer: JSON.stringify({ summary: ANSWER_TEXT, wordCount: 4 }),
    });

    expect(ok).toBe(true);
    expect(lines).toEqual([
      `PASS call: model ${MODEL}, 250 ms, tokens in ${SCRIPTED_USAGE.input_tokens} / out ${SCRIPTED_USAGE.output_tokens} / cached 0 / reasoning 12, finish STOP, summary ${ANSWER_TEXT.length} chars, wordCount 4`,
    ]);
    expectNothingSecret(lines.join('\n'));
    // Schema mode jsonSchema, the raw answer kept, one call to the model asked for.
    expect(factory.created).toEqual([MODEL]);
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0].structured).toEqual({
      method: 'jsonSchema',
      includeRaw: true,
    });
  });

  it('shows "–" for token values the provider did not report', async () => {
    const { ok, output } = await run({
      answer: JSON.stringify({ summary: 'ok', wordCount: 1 }),
      usage: null,
    });

    expect(ok).toBe(true);
    expect(output).toContain('tokens in – / out – / cached – / reasoning –');
  });

  it('a provider error → FAIL with its code and the HTTP status', async () => {
    const { ok, lines } = await run({
      error: new LlmError(
        'Google has no model `gemini-test` (HTTP 404, NOT_FOUND)',
        'permanent',
        'unknown-model',
      ),
    });

    expect(ok).toBe(false);
    expect(lines).toEqual([
      'FAIL call: unknown-model (permanent): Google has no model `gemini-test` (HTTP 404, NOT_FOUND)',
    ]);
  });

  it('a raw error from the package is mapped by the factory and never printed as is', async () => {
    const { ok, output } = await run({
      error: new Error(`request failed, x-goog-api-key: ${KEY}`),
    });

    expect(ok).toBe(false);
    expect(output).toMatch(/^FAIL call: bad-request \(permanent\): /);
    expectNothingSecret(output);
  });

  it('an answer that is not JSON → FAIL invalid-answer, without quoting it', async () => {
    const { ok, output } = await run({ answer: ANSWER_TEXT });

    expect(ok).toBe(false);
    expect(output).toMatch(
      /^FAIL call: invalid-answer \(permanent\): .*not JSON/,
    );
    expectNothingSecret(output);
  });

  it('an answer that breaks the schema → FAIL invalid-answer naming the paths', async () => {
    const { ok, output } = await run({
      answer: JSON.stringify({ summary: '', wordCount: -1 }),
    });

    expect(ok).toBe(false);
    expect(output).toContain('invalid-answer');
    expect(output).toContain('summary: too_small');
    expect(output).toContain('wordCount: too_small');
  });

  it('a cut answer → FAIL from checkAnswer', async () => {
    const { ok, output } = await run({
      answer: JSON.stringify({ summary: 'ok', wordCount: 1 }),
      finishReason: 'MAX_TOKENS',
    });

    expect(ok).toBe(false);
    expect(output).toMatch(/^FAIL call: answer-cut/);
  });
});
