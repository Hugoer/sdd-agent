// Scripted ChatModelFactory for specs 4 and later (plan P8). No network: every answer comes from a script,
// in the shape ChatGoogle gives (text content, `finish_reason`, `usage_metadata`). A call with no script
// left throws, so a call nobody planned fails the test.
import type {
  BaseLanguageModelInput,
  StructuredOutputMethodOptions,
} from '@langchain/core/language_models/base';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from '@langchain/core/language_models/chat_models';
import {
  assembleStructuredOutputPipeline,
  createContentParser,
} from '@langchain/core/language_models/structured_output';
import {
  AIMessage,
  type BaseMessage,
  type UsageMetadata,
} from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import type { ChatModelFactory } from '../../src/llm/chat-model.factory.js';
import { LlmError } from '../../src/contracts/llm-error.js';

export type ScriptedReply =
  /** The model's text as sent (JSON for a schema call, or malformed on purpose). */
  | { answer: string; finishReason?: string; usage?: UsageMetadata | null }
  /** Thrown by the model call, as the provider's package would throw it. */
  | { error: unknown };

export interface ScriptedCall {
  model: string;
  messages: BaseMessage[];
  /** Set when the call went through withStructuredOutput. */
  structured?: { method: string | undefined; includeRaw: boolean };
}

export const SCRIPTED_USAGE: UsageMetadata = {
  input_tokens: 120,
  output_tokens: 30,
  total_tokens: 150,
  input_token_details: { cache_read: 0 },
  output_token_details: { reasoning: 12 },
};

type StructuredSchema<RunOutput extends Record<string, unknown>> = Parameters<
  typeof createContentParser<RunOutput>
>[0];

const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST']);

export class ScriptedChatModelFactory implements ChatModelFactory {
  readonly provider = 'scripted';
  /** Every model name passed to `create`, in order. */
  readonly created: string[] = [];
  /** Every model call, in order, with the messages it got. */
  readonly calls: ScriptedCall[] = [];
  private readonly script: ScriptedReply[] = [];

  reply(...replies: ScriptedReply[]): this {
    this.script.push(...replies);
    return this;
  }

  /** A valid JSON answer. */
  replyJson(value: unknown, extra: Omit<ScriptedReply, 'answer'> = {}): this {
    return this.reply({ answer: JSON.stringify(value), ...extra });
  }

  get remaining(): number {
    return this.script.length;
  }

  create(model: string): BaseChatModel {
    this.created.push(model);
    return new ScriptedChatModel(model, this);
  }

  toLlmError(error: unknown, model: string): LlmError {
    if (error instanceof LlmError) return error;
    const name = error instanceof Error ? error.name : typeof error;
    return new LlmError(
      `scripted call to \`${model}\` failed (${name})`,
      'permanent',
      'bad-request',
    );
  }

  checkAnswer(answer: AIMessage, model: string): LlmError | null {
    const reason = (
      answer.response_metadata as { finish_reason?: unknown } | undefined
    )?.finish_reason;
    if (reason === 'MAX_TOKENS')
      return new LlmError(
        `answer of \`${model}\` cut`,
        'permanent',
        'answer-cut',
      );
    if (typeof reason === 'string' && BLOCKED.has(reason))
      return new LlmError(
        `answer of \`${model}\` blocked (${reason})`,
        'permanent',
        'answer-blocked',
      );
    return null;
  }

  /** @internal Used by the scripted model. */
  next(call: ScriptedCall): ScriptedReply {
    this.calls.push(call);
    const reply = this.script.shift();
    if (!reply) {
      throw new Error(
        `ScriptedChatModelFactory: model \`${call.model}\` was called with no scripted reply left`,
      );
    }
    return reply;
  }
}

interface ScriptedCallOptions extends BaseChatModelCallOptions {
  /** Set by withStructuredOutput, as ChatGoogle's own `responseSchema` option. */
  scriptedStructured?: ScriptedCall['structured'];
}

class ScriptedChatModel extends BaseChatModel<ScriptedCallOptions> {
  constructor(
    readonly model: string,
    private readonly factory: ScriptedChatModelFactory,
  ) {
    super({});
  }

  _llmType(): string {
    return 'scripted';
  }

  _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    return Promise.resolve().then(() => this.answer(messages, options));
  }

  private answer(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): ChatResult {
    const reply = this.factory.next({
      model: this.model,
      messages,
      structured: options.scriptedStructured,
    });
    if ('error' in reply) throw reply.error;
    const message = new AIMessage({
      content: reply.answer,
      response_metadata: {
        model_provider: 'scripted',
        finish_reason: reply.finishReason ?? 'STOP',
      },
      usage_metadata:
        reply.usage === null ? undefined : (reply.usage ?? SCRIPTED_USAGE),
    });
    return { generations: [{ text: reply.answer, message }] };
  }

  /** As ChatGoogle's `jsonSchema` method: the same model with the schema as a call option, then a JSON parser. */
  override withStructuredOutput<
    RunOutput extends Record<string, unknown> = Record<string, unknown>,
  >(
    outputSchema: StructuredSchema<RunOutput>,
    config?: StructuredOutputMethodOptions<false>,
  ): Runnable<BaseLanguageModelInput, RunOutput>;
  override withStructuredOutput<
    RunOutput extends Record<string, unknown> = Record<string, unknown>,
  >(
    outputSchema: StructuredSchema<RunOutput>,
    config?: StructuredOutputMethodOptions<true>,
  ): Runnable<BaseLanguageModelInput, { raw: BaseMessage; parsed: RunOutput }>;
  override withStructuredOutput<
    RunOutput extends Record<string, unknown> = Record<string, unknown>,
  >(
    outputSchema: StructuredSchema<RunOutput>,
    config?: StructuredOutputMethodOptions<boolean>,
  ):
    | Runnable<BaseLanguageModelInput, RunOutput>
    | Runnable<
        BaseLanguageModelInput,
        { raw: BaseMessage; parsed: RunOutput }
      > {
    const structured = {
      method: config?.method,
      includeRaw: config?.includeRaw === true,
    };
    return assembleStructuredOutputPipeline(
      this.withConfig({ scriptedStructured: structured }),
      createContentParser(outputSchema),
      structured.includeRaw,
    );
  }
}
