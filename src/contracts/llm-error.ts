// Overview §4 (normative), added 2026-11-12 (spec 4).

export type LlmErrorCode =
  | 'rate-limited'
  | 'provider-unavailable'
  | 'bad-api-key'
  | 'access-denied'
  | 'credits-exhausted'
  | 'unknown-model'
  | 'answer-blocked'
  | 'answer-cut'
  | 'bad-request'
  | 'invalid-answer';

/** A model call failed; the worker treats it like a ProviderError: it retries `transient` and fails
 *  `permanent` at once. */
export class LlmError extends Error {
  override readonly name = 'LlmError';

  constructor(
    message: string,
    readonly kind: 'transient' | 'permanent',
    readonly code: LlmErrorCode,
    readonly detail: { retryAfterSeconds?: number } = {},
  ) {
    super(message);
  }
}

/** workflow.json, a skill or a model entry is wrong. Always permanent; the message is safe to post. */
export class StepConfigError extends Error {
  override readonly name = 'StepConfigError';
}
