// Spec 5: the router's own errors. Both go through the worker's existing rule (src/events never imports this file).
import { StepConfigError } from '../contracts/llm-error.js';

/**
 * RL1, plan P1: the run reached a step whose handler isn't registered. A StepConfigError, so the worker fails
 * the event at once (permanent); the cause mapping checks this class first (`step-not-built`).
 */
export class StepNotBuiltError extends StepConfigError {
  constructor(readonly step: string) {
    super(`this version of the bot has no \`${step}\` step yet`);
  }
}

/**
 * Spec "Session lease": a guarded write found another owner (the lease expired and another event took it).
 * Temporary: the worker retries the event against the new state.
 */
export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError';

  constructor(taskId: string, eventId: string) {
    super(
      `event ${eventId} no longer holds the session lease of task ${taskId}`,
    );
  }
}
