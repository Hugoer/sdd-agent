import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { z } from 'zod';
import type { LlmError } from '../contracts/llm-error.js';

/** Spec 11 (plan P7): what one model request carries besides its messages. */
export interface RequestOptions {
  /** The tools offered; left out after a limit and on a re-ask (none are then declared). */
  tools?: StructuredToolInterface[];
  /** The answer format (schema output); left out for text output. */
  schema?: z.ZodType;
}

/**
 * The provider seam (spec 4, L2). One implementation per provider; only it imports the provider's package
 * (Google: `src/llm/google/`). Every message of a returned `LlmError` is safe to post: it never holds the key,
 * a header, the prompt or the answer.
 */
export interface ChatModelFactory {
  /** stored as `ExecutionLog.provider` and `ResolvedModel.provider`, e.g. 'google' */
  readonly provider: string;
  /** No hidden retries (`maxRetries: 0`) and no sampling option. The timeout is a call option (plan P2). */
  create(model: string): BaseChatModel;
  /**
   * Spec 11 (plan P7): the runnable for one model request, giving the model's message as received. The
   * provider's option names (Google's `responseSchema`) stay in its adapter (L2); LlmService judges `raw.text`.
   */
  request(
    model: string,
    options: RequestOptions,
  ): Runnable<BaseMessage[], AIMessage>;
  /**
   * Spec 11 (SD5, SDW17): the provider's own token count for a text; null when it has none or the count failed
   * (the adapter logs the failure's code, never the key). Never throws.
   */
  countTokens(model: string, text: string): Promise<number | null>;
  /** A thrown error → its `LlmError`. */
  toLlmError(error: unknown, model: string): LlmError;
  /** What the provider reports inside a successful answer (a cut or blocked answer, plan P3); null = usable. */
  checkAnswer(answer: AIMessage, model: string): LlmError | null;
}

export const CHAT_MODEL_FACTORY = Symbol('CHAT_MODEL_FACTORY');
