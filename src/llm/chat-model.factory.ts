import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessage } from '@langchain/core/messages';
import type { LlmError } from '../contracts/llm-error.js';

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
  /** A thrown error → its `LlmError`. */
  toLlmError(error: unknown, model: string): LlmError;
  /** What the provider reports inside a successful answer (a cut or blocked answer, plan P3); null = usable. */
  checkAnswer(answer: AIMessage, model: string): LlmError | null;
}

export const CHAT_MODEL_FACTORY = Symbol('CHAT_MODEL_FACTORY');
