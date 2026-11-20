import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  mapChatMessagesToStoredMessages,
  type BaseMessage,
} from '@langchain/core/messages';
import type { z } from 'zod';
import { LlmError } from '../contracts/llm-error.js';
import {
  CHAT_MODEL_FACTORY,
  type ChatModelFactory,
} from './chat-model.factory.js';
import { ContextLoadService } from './context-load.service.js';
import { ExecutionLogService } from './execution-log.service.js';
import { findInjectionKinds } from './injection-patterns.js';
import { InjectionWarningService } from './injection-warning.service.js';
import type { LlmCall, LlmResult } from './llm-call.js';
import {
  buildPrompt,
  notesFor,
  type PromptMessage,
  type PromptSizes,
} from './prompt.js';

/** Spec 4 LlmService.call() step 3 (plan P2): the model call's own limit; LangChain's retries are off. */
export const CALL_TIMEOUT_MS = 300_000;
/** The first ask and at most 2 re-asks (step 6). */
export const MAX_ATTEMPTS = 3;

/** What one model call gave: a valid output, or an error and whether it was a mismatch (re-asked). */
type Attempt<T> =
  | { ok: true; output: T; raw: AIMessage; durationMs: number }
  | {
      ok: false;
      error: LlmError;
      /** The format problem, told to the model in the re-ask; absent for any other error. */
      mismatch?: string;
      raw?: AIMessage;
      durationMs: number;
    };

/**
 * Spec 4 "LlmService.call()" (L10, LW6, LW9): guard → warnings → prompt → model → one ExecutionLog row per
 * attempt → re-ask on a mismatch. Every failure is an LlmError (or a ProviderError from posting a warning).
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    @Inject(CHAT_MODEL_FACTORY) private readonly factory: ChatModelFactory,
    private readonly warnings: InjectionWarningService,
    private readonly logs: ExecutionLogService,
    private readonly loads: ContextLoadService,
  ) {}

  async call<T>(input: LlmCall<T>): Promise<LlmResult<T>> {
    const { context, setup } = input;
    // Spec 11 (SDW13): every request of this call is a row with this id and its turn number.
    const callId = randomUUID();
    // 1–2. Guard every untrusted block and build the messages; warnings are posted before the model is called.
    const prompt = buildPrompt(input.frame, setup, input.turns);
    for (const { source, kinds } of prompt.injections) {
      await this.warnings.warn(context.task, source, kinds);
    }
    const notes = notesFor(setup.model, prompt.cuts);
    const injectionKinds = [
      ...new Set(prompt.injections.flatMap(({ kinds }) => kinds)),
    ];
    const cutSources = prompt.cuts.map(({ source }) => source.key);
    const model = this.factory.create(setup.model.name);
    await this.recordStartFiles(input, callId);

    const messages: PromptMessage[] = [...prompt.messages];
    const sizes: PromptSizes = { ...prompt.sizes };
    /** Messages already stored on an earlier row: a later turn stores only the ones added since (L18). */
    let stored = 0;
    for (let attempt = 1, turn = 1; ; attempt++, turn++) {
      const sent = toMessages(messages);
      const result = await this.ask(
        model,
        setup.model.name,
        input.output,
        sent,
      );
      const raw = result.raw;
      const logId = await this.logs.record({
        task: context.task,
        runId: context.runId,
        lane: context.lane,
        step: context.step,
        model: setup.model,
        skillCommit: setup.commit,
        attempt,
        callId,
        turn,
        error: result.ok
          ? undefined
          : { code: result.error.code, message: result.error.message },
        durationMs: result.durationMs,
        sizes: { ...sizes },
        answerChars: raw?.text.length,
        injectionKinds,
        cutSources,
        prompt: mapChatMessagesToStoredMessages(sent.slice(stored)),
        answer: raw ? mapChatMessagesToStoredMessages([raw])[0] : undefined,
        usage: raw?.usage_metadata,
        providerMeta: raw?.response_metadata,
      });
      stored = sent.length;
      this.logger.log(
        `llm ${context.step} ${context.task.externalRef} ${setup.model.name} (${setup.model.level}) attempt ${attempt}: ` +
          `${result.ok ? 'SUCCESS' : `ERROR ${result.error.code}`} in ${Math.round(result.durationMs)} ms`,
      );
      if (result.ok) {
        return { output: result.output, model: setup.model, notes, logId };
      }
      if (result.mismatch === undefined || attempt === MAX_ATTEMPTS) {
        throw result.error;
      }
      // 6. Re-ask: the model's answer and the format problem, as two more turns. With no answer at all there
      // is nothing to repeat, so only the message is added (an empty turn can be refused by the provider).
      const answer = raw?.text ?? '';
      const reask =
        `Your answer did not match the required format: ${result.mismatch}. ` +
        'Answer again with only the corrected output.';
      if (answer !== '') messages.push({ role: 'assistant', content: answer });
      messages.push({ role: 'user', content: reask });
      sizes.other += answer.length + reask.length;
    }
  }

  /**
   * Spec 11 step 2: one `context_loads` row per file given at start, the step's SKILL.md and the root AGENTS.md
   * (trigger `start`, turn 0, `loaded`). A root AGENTS.md that matches an injection pattern still loads (trusted,
   * base branch): one log line with its kinds, never its text, and the kinds on its row (SDW8, GM13).
   */
  private async recordStartFiles<T>(
    { context, setup }: LlmCall<T>,
    callId: string,
  ): Promise<void> {
    const { skill, repo } = setup;
    const files = [
      {
        kind: 'step-skill' as const,
        skill: skill.step,
        path: `${skill.path.replace(/\/+$/, '')}/SKILL.md`,
        text: skill.instructions,
      },
      ...(repo.rootAgents
        ? [
            {
              kind: 'agents' as const,
              path: 'AGENTS.md',
              text: repo.rootAgents.text,
            },
          ]
        : []),
    ];
    for (const file of files) {
      const injectionKinds = findInjectionKinds(file.text);
      if (file.kind === 'agents' && injectionKinds.length > 0)
        this.logger.warn(
          `context ${context.step} @${setup.commit.slice(0, 7)}: AGENTS.md matches an injection pattern ` +
            `(${injectionKinds.join(', ')}); loaded anyway, the repository's instructions on the base branch are trusted`,
        );
      await this.loads.insert({
        task: context.task,
        runId: context.runId,
        step: context.step,
        callId,
        turn: 0,
        trigger: 'start',
        kind: file.kind,
        skill: 'skill' in file ? file.skill : undefined,
        path: file.path,
        commit: setup.commit,
        model: setup.model.name,
        outcome: 'loaded',
        bytes: Buffer.byteLength(file.text),
        chars: file.text.length,
        injectionKinds,
      });
    }
  }

  /** Steps 3–4 for one attempt: the model call (300 s, no hidden retry), the provider's checks, the judge. */
  private async ask<T>(
    model: BaseChatModel,
    modelName: string,
    output: LlmCall<T>['output'],
    messages: BaseMessage[],
  ): Promise<Attempt<T>> {
    const started = performance.now();
    let raw: unknown;
    try {
      if (output === 'text') {
        raw = await model.invoke(messages, { timeout: CALL_TIMEOUT_MS });
      } else {
        ({ raw } = await model
          .withStructuredOutput(output as z.ZodType<Record<string, unknown>>, {
            method: 'jsonSchema',
            includeRaw: true,
          })
          .invoke(messages, { timeout: CALL_TIMEOUT_MS }));
      }
    } catch (error) {
      const durationMs = performance.now() - started;
      const failed = this.toLlmError(error, modelName);
      return failed.code === 'invalid-answer'
        ? {
            ok: false,
            error: failed,
            mismatch: 'there was no answer',
            durationMs,
          }
        : { ok: false, error: failed, durationMs };
    }
    const durationMs = performance.now() - started;
    if (!AIMessage.isInstance(raw)) {
      return mismatch(modelName, 'there was no answer', durationMs);
    }
    const refused = this.factory.checkAnswer(raw, modelName);
    if (refused) return { ok: false, error: refused, raw, durationMs };

    const judged = judge(raw.text, output);
    return judged.ok
      ? { ok: true, output: judged.output, raw, durationMs }
      : { ...mismatch(modelName, judged.problem, durationMs), raw };
  }

  /** Plan P2: a timeout is `provider-unavailable` here, for every provider; anything else is the factory's. */
  private toLlmError(error: unknown, model: string): LlmError {
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      return new LlmError(
        `${this.factory.provider} gave no answer from model \`${model}\` within ${CALL_TIMEOUT_MS / 1000} s`,
        'transient',
        'provider-unavailable',
      );
    }
    return this.factory.toLlmError(error, model);
  }
}

/** Step 4: Zod judges a schema answer; a text answer must not be empty. Never quotes the answer. */
function judge<T>(
  text: string,
  output: LlmCall<T>['output'],
): { ok: true; output: T } | { ok: false; problem: string } {
  if (output === 'text') {
    return text.trim() === ''
      ? { ok: false, problem: 'the answer is empty' }
      : { ok: true, output: text as T };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      problem:
        text.trim() === '' ? 'the answer is empty' : 'the answer is not JSON',
    };
  }
  const result = output.safeParse(value);
  if (result.success) return { ok: true, output: result.data };
  return {
    ok: false,
    problem: result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; '),
  };
}

function mismatch(
  model: string,
  problem: string,
  durationMs: number,
): Attempt<never> {
  return {
    ok: false,
    error: new LlmError(
      `model \`${model}\` gave no valid answer: ${problem}`,
      'permanent',
      'invalid-answer',
    ),
    mismatch: problem,
    durationMs,
  };
}

function toMessages(messages: PromptMessage[]): BaseMessage[] {
  return messages.map(({ role, content }) =>
    role === 'system'
      ? new SystemMessage(content)
      : role === 'user'
        ? new HumanMessage(content)
        : new AIMessage(content),
  );
}
