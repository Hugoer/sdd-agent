// The checks of `npm run llm:smoke` (spec 4 "Smoke script", plan P1). They use the provider seam only, so they
// are unit-tested against the scripted fake before they reach Google.
//
// First form (T4): one provisional call, not guarded and not recorded. T16 adds checks 1–4; T24 replaces this
// call with LlmService.call().
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import { LlmError } from '../../contracts/llm-error.js';
import type { ChatModelFactory } from '../chat-model.factory.js';

/** Spec 4 LlmService.call() step 3 (plan P2). Provisional here until LlmService owns it (T21). */
const CALL_TIMEOUT_MS = 300_000;

/** Check 6's schema. */
export const summarySchema = z.object({
  summary: z.string().min(1).max(300),
  wordCount: z.number().int().min(0),
});

const SMOKE_TEXT =
  'The bot reads a skill from the target repository, asks a model for an answer and posts it as a comment.';

export interface LlmSmokeOptions {
  /** `--try <model>`: the model name sent to the provider (provisional flag, plan P1). */
  model: string;
}

type Print = (line: string) => void;
/** A check returns what it saw, or throws. */
type Check = [name: string, run: () => Promise<string>];

/** Prints one PASS / FAIL line per check; returns true only if every check passed. */
export async function runLlmSmoke(
  factory: ChatModelFactory,
  options: LlmSmokeOptions,
  print: Print,
  now: () => number = () => performance.now(),
): Promise<boolean> {
  const checks: Check[] = [
    ['call', () => callCheck(factory, options.model, now)],
  ];
  for (const [name, run] of checks) {
    try {
      print(`PASS ${name}: ${await run()}`);
    } catch (error) {
      print(`FAIL ${name}: ${describeFailure(error)}`);
      return false;
    }
  }
  return true;
}

async function callCheck(
  factory: ChatModelFactory,
  model: string,
  now: () => number,
): Promise<string> {
  const started = now();
  let raw;
  try {
    const structured = factory
      .create(model)
      .withStructuredOutput(summarySchema, {
        method: 'jsonSchema',
        includeRaw: true,
      });
    ({ raw } = await structured.invoke(
      [
        new SystemMessage(
          'Answer with JSON only: a one-sentence summary of the text and its number of words.',
        ),
        new HumanMessage(SMOKE_TEXT),
      ],
      { timeout: CALL_TIMEOUT_MS },
    ));
  } catch (error) {
    throw factory.toLlmError(error, model);
  }
  const durationMs = Math.round(now() - started);
  if (!AIMessage.isInstance(raw)) {
    throw new LlmError(
      `model \`${model}\` gave no answer message`,
      'permanent',
      'invalid-answer',
    );
  }
  const refused = factory.checkAnswer(raw, model);
  if (refused) throw refused;

  const output = judge(raw.text, model);
  return [
    `model ${model}`,
    `${durationMs} ms`,
    `tokens ${tokenLine(raw)}`,
    `finish ${finishReason(raw)}`,
    `summary ${output.summary.length} chars, wordCount ${output.wordCount}`,
  ].join(', ');
}

/** Zod is the judge (spec 4 LlmService.call() step 4). Never quotes the answer. */
function judge(text: string, model: string): z.infer<typeof summarySchema> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // JSON.parse's message quotes the text: not shown.
    throw new LlmError(
      `the answer of \`${model}\` is not JSON (${text.length} chars)`,
      'permanent',
      'invalid-answer',
    );
  }
  const result = summarySchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
      .join('; ');
    throw new LlmError(
      `the answer of \`${model}\` does not match the schema (${issues})`,
      'permanent',
      'invalid-answer',
    );
  }
  return result.data;
}

/** The four token values of ExecutionLog: input, output, cached input, reasoning ("–" = not reported). */
function tokenLine(answer: AIMessage): string {
  const usage = answer.usage_metadata;
  const show = (value: number | undefined) =>
    value === undefined ? '–' : String(value);
  return [
    `in ${show(usage?.input_tokens)}`,
    `out ${show(usage?.output_tokens)}`,
    `cached ${show(usage?.input_token_details?.cache_read)}`,
    `reasoning ${show(usage?.output_token_details?.reasoning)}`,
  ].join(' / ');
}

function finishReason(answer: AIMessage): string {
  const reason = (
    answer.response_metadata as { finish_reason?: unknown } | undefined
  )?.finish_reason;
  return typeof reason === 'string' ? reason : '–';
}

/** An LlmError's message is safe to show by contract (it holds the HTTP status when there was one). */
function describeFailure(error: unknown): string {
  if (error instanceof LlmError) {
    return `${error.code} (${error.kind}): ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
