import type { WebhookEvent } from '../generated/prisma/client.js';

export type ProcessResult =
  { status: 'DONE' } | { status: 'IGNORED'; reason: string };

/**
 * Decides what a stored event means (spec 2, AW5). The module that owns processing registers exactly one
 * with `EventsWorker.registerProcessor()` (spec 2: intake's placeholder; spec 5 replaces it). A thrown error
 * goes to the worker's failure rule (a permanent ProviderError fails at once, anything else is retried).
 */
export interface EventProcessor {
  process(event: WebhookEvent): Promise<ProcessResult>;
}
