// Spec 5, plan P2: "the error happened after the lease was claimed" travels on the error itself, so the failure
// hook (`failed(event, error)`) knows the task, the step and the event's kind without running intake again. A
// symbol property on the same object: the worker's `instanceof` rules see the error unchanged.

export interface RouterMark {
  taskId: string;
  /** Plan P3: the step a stop names. */
  step: string;
  /** RL13: a failed `/retry` never stops the run. */
  retry: boolean;
  /** Plan P2: a stale event never stops the run. */
  stale: boolean;
}

const MARK = Symbol('sdd-agent.router-mark');

/** The same error with the mark (a copy of `mark`); a thrown non-object becomes an Error first. */
export function markError(error: unknown, mark: RouterMark): unknown {
  const target =
    typeof error === 'object' && error !== null
      ? error
      : new Error(String(error));
  Object.defineProperty(target, MARK, {
    value: { ...mark },
    configurable: true,
  });
  return target;
}

/** The mark, or null for an error raised before the claim (intake: a silent FAILED, IA9). */
export function routerMarkOf(error: unknown): RouterMark | null {
  if (typeof error !== 'object' || error === null) return null;
  const mark = (error as { [MARK]?: RouterMark })[MARK];
  return mark ?? null;
}
