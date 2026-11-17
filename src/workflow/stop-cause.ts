// Spec 5 "Cause and message" (RL4): what a stop records and its comment says. Only spec 4's error messages and
// the provider's own message are posted; a bug's message never is (it may hold anything).
import type { Lane, TaskStatus } from '../contracts/issue-provider.js';
import { LlmError, StepConfigError } from '../contracts/llm-error.js';
import { ProviderError } from '../contracts/provider-error.js';
import { RUN_START } from './workflow-comments.js';
import { StepNotBuiltError } from './workflow-errors.js';

export interface StopCause {
  /** `Run.stopCause`: `step-not-built`, `step-config`, an `LlmErrorCode`, `provider-error` or `internal-error`. */
  cause: string;
  /** `Run.stopMessage`, posted in the stop comment. */
  message: string;
}

/** A failure's cause (row 28). `deliveryId` names the event in the app log for an unexpected error. */
export function stopCauseOf(error: unknown, deliveryId: string): StopCause {
  // Plan P1: the subclass first.
  if (error instanceof StepNotBuiltError)
    return { cause: 'step-not-built', message: error.message };
  if (error instanceof StepConfigError)
    return { cause: 'step-config', message: error.message };
  if (error instanceof LlmError)
    return { cause: error.code, message: error.message };
  if (error instanceof ProviderError) {
    // A transient error reaches a stop only on the worker's last attempt.
    const message =
      error.kind === 'transient'
        ? `${error.message}, after 3 attempts`
        : error.message;
    return { cause: 'provider-error', message };
  }
  return {
    cause: 'internal-error',
    message: `an unexpected error; the app log has the details (delivery \`${deliveryId}\`)`,
  };
}

/**
 * The step outcomes that stop a run as a result of the work (rows 14, 22, 25, 26; plan P4): their stop cause
 * and the reason the `/retry` reply gives. Not retryable, except `WS_DIRTY` if spec 8 decides it is.
 */
export const WORK_RESULT_STOPS = {
  LIMIT: {
    cause: 'grill-limit',
    reason: 'the Grill round limit was reached',
  },
  WS_DIRTY: {
    cause: 'workspace-dirty',
    reason: "the bot's workspace had uncommitted changes",
  },
  RED: {
    cause: 'coder-red',
    reason: "the lint or the tests stayed red after the Coder's fix attempts",
  },
  INTERRUPTED: {
    cause: 'coder-interrupted',
    reason: 'the Coder job was interrupted before it opened a PR',
  },
} as const;

export type WorkResultOutcome = keyof typeof WORK_RESULT_STOPS;

/** The reason for a work-result stop cause, for the `/retry` reply; null for a failure's cause. */
export function workResultReason(cause: string): string | null {
  const found = Object.values(WORK_RESULT_STOPS).find(
    (stop) => stop.cause === cause,
  );
  return found ? found.reason : null;
}

/**
 * Plan P3: the step a stop names when no handler is running (the pending side effects, reading the issue, a
 * reply): the step the status waits on. A running handler names itself; a run between its creation and its
 * first handler is `run-start`.
 */
export function waitingStep(
  status: TaskStatus,
  run: { lane: Lane; stopStep: string | null } | null,
): string {
  switch (status) {
    case 'grilling':
      return 'grill';
    case 'spec-review':
      return 'spec';
    case 'ready-for-dev':
      return run?.lane === 'full-sdd' ? 'plan' : 'go-signal';
    case 'executing':
      return 'code';
    case 'in-review':
      return 'qualityGate';
    case 'needs-human':
      return run?.stopStep ?? RUN_START;
    case 'draft':
      return RUN_START;
  }
}
