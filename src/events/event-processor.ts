import type { WebhookEvent } from '../generated/prisma/client.js';

export type ProcessResult =
  | { status: 'DONE' }
  | { status: 'IGNORED'; reason: string }
  /** Spec 5 (RLW11): back to PENDING after `delayMs`; this attempt doesn't count. */
  | { status: 'WAIT'; delayMs: number };

/**
 * Decides what a stored event means (spec 2, AW5). The module that owns processing registers exactly one
 * with `EventsWorker.registerProcessor()` (spec 2: intake's placeholder; spec 5 replaces it). A thrown error
 * goes to the worker's failure rule (a permanent ProviderError or LlmError and every StepConfigError fail at
 * once, anything else is retried; spec 4 added the two LLM errors).
 */
export interface EventProcessor {
  process(event: WebhookEvent): Promise<ProcessResult>;
  /**
   * Spec 5 (RLW11): called once, after the worker marked the event FAILED (a permanent error or the last
   * attempt), with the row as saved and the error. Awaited before the next event is claimed; an error it
   * throws is logged and the row stays FAILED.
   */
  failed(event: WebhookEvent, error: unknown): Promise<void>;
}
