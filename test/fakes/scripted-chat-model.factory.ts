// Scripted ChatModelFactory for specs 4 and later (plan P8). No network: every answer comes from a script,
// in the shape ChatGoogle gives (text content, `finish_reason`, `usage_metadata`; spec 11: tool calls). A call
// with no script left throws, so a call nobody planned fails the test.
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  type UsageMetadata,
} from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import type {
  ChatModelFactory,
  RequestOptions,
} from '../../src/llm/chat-model.factory.js';
import { LlmError } from '../../src/contracts/llm-error.js';

/** A tool call in a scripted answer; its id is `call-<n>` unless given. */
export interface ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

/** The model's text as sent (JSON for a schema call, or malformed on purpose), and (spec 11) its tool calls. */
export interface ScriptedAnswer {
  /** Empty when left out (an answer with tool calls only). */
  answer?: string;
  toolCalls?: ScriptedToolCall[];
  finishReason?: string;
  usage?: UsageMetadata | null;
  /** Spec 6 (plan T12): runs while the model "thinks", before the answer comes back (e.g. a comment arrives). */
  during?: () => Promise<unknown>;
}

export type ScriptedReply =
  | ScriptedAnswer
  /** Thrown by the model call, as the provider's package would throw it. */
  | { error: unknown };

export interface ScriptedCall {
  model: string;
  messages: BaseMessage[];
  /** Spec 11: the names of the tools the request offered (none for a `create()` model). */
  tools: string[];
  /** Spec 11: whether the request carried the answer format. */
  schema: boolean;
}

export const SCRIPTED_USAGE: UsageMetadata = {
  input_tokens: 120,
  output_tokens: 30,
  total_tokens: 150,
  input_token_details: { cache_read: 0 },
  output_token_details: { reasoning: 12 },
};

const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST']);

export class ScriptedChatModelFactory implements ChatModelFactory {
  readonly provider = 'scripted';
  /** Every model name passed to `create` or `request`, in order. */
  readonly created: string[] = [];
  /** Every model call, in order, with the messages it got. */
  readonly calls: ScriptedCall[] = [];
  /** Spec 11: every `countTokens` request, in order. */
  readonly counted: { model: string; text: string }[] = [];
  /**
   * Spec 11: what `countTokens` gives for a text: a number, null (no count, or the count failed) or a promise of
   * either (a slow count). By default null, as a provider without counts.
   */
  countWith: (
    model: string,
    text: string,
  ) => number | null | Promise<number | null> = () => null;
  private readonly script: ScriptedReply[] = [];

  reply(...replies: ScriptedReply[]): this {
    this.script.push(...replies);
    return this;
  }

  /** A valid JSON answer. */
  replyJson(value: unknown, extra: Omit<ScriptedAnswer, 'answer'> = {}): this {
    return this.reply({ answer: JSON.stringify(value), ...extra });
  }

  get remaining(): number {
    return this.script.length;
  }

  create(model: string): BaseChatModel {
    this.created.push(model);
    return new ScriptedChatModel(model, this);
  }

  /** As the Google adapter: the options as call options of one request; the raw message comes back. */
  request(
    model: string,
    { tools, schema }: RequestOptions,
  ): Runnable<BaseMessage[], AIMessage> {
    this.created.push(model);
    return new ScriptedChatModel(model, this).withConfig({
      scriptedRequest: {
        tools: (tools ?? []).map((tool) => tool.name),
        schema: schema !== undefined,
      },
    }) as Runnable<BaseMessage[], AIMessage>;
  }

  countTokens(model: string, text: string): Promise<number | null> {
    this.counted.push({ model, text });
    return Promise.resolve(this.countWith(model, text));
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
  /** Set by `request()`, as ChatGoogle's own `tools` and `responseSchema` options. */
  scriptedRequest?: Pick<ScriptedCall, 'tools' | 'schema'>;
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

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    await Promise.resolve();
    const reply = this.factory.next({
      model: this.model,
      messages,
      tools: options.scriptedRequest?.tools ?? [],
      schema: options.scriptedRequest?.schema ?? false,
    });
    if ('error' in reply) throw reply.error;
    await reply.during?.();
    return this.answer(reply);
  }

  private answer(reply: ScriptedAnswer): ChatResult {
    const text = reply.answer ?? '';
    const message = new AIMessage({
      content: text,
      tool_calls: (reply.toolCalls ?? []).map((call, index) => ({
        type: 'tool_call' as const,
        name: call.name,
        args: call.args,
        id: call.id ?? `call-${index + 1}`,
      })),
      response_metadata: {
        model_provider: 'scripted',
        finish_reason: reply.finishReason ?? 'STOP',
      },
      usage_metadata:
        reply.usage === null ? undefined : (reply.usage ?? SCRIPTED_USAGE),
    });
    return { generations: [{ text, message }] };
  }
}
