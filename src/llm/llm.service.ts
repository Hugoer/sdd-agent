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
import { ExecutionLogService } from './execution-log.service.js';
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
  ) {}

  async call<T>(input: LlmCall<T>): Promise<LlmResult<T>> {
    const { context, setup } = input;
    // 1–2. Guard every untrusted block and build the messages; warnings are posted before the model is called.
    const prompt = buildPrompt(input.frame, setup.skill, input.turns);
    for (const { source, kinds } of prompt.injections) {
      await this.warnings.warn(context.task, source, kinds);
    }
    const notes = notesFor(setup.model, prompt.cuts);
    const injectionKinds = [
      ...new Set(prompt.injections.flatMap(({ kinds }) => kinds)),
    ];
    const cutSources = prompt.cuts.map(({ source }) => source.key);
    const model = this.factory.create(setup.model.name);

    const messages: PromptMessage[] = [...prompt.messages];
    const sizes: PromptSizes = { ...prompt.sizes };
    for (let attempt = 1; ; attempt++) {
      const result = await this.ask(
        model,
        setup.model.name,
        input.output,
        toMessages(messages),
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
        error: result.ok
          ? undefined
          : { code: result.error.code, message: result.error.message },
        durationMs: result.durationMs,
        sizes: { ...sizes },
        answerChars: raw?.text.length,
        injectionKinds,
        cutSources,
        prompt: mapChatMessagesToStoredMessages(toMessages(messages)),
        answer: raw ? mapChatMessagesToStoredMessages([raw])[0] : undefined,
        usage: raw?.usage_metadata,
        providerMeta: raw?.response_metadata,
      });
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
