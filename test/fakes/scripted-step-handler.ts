// A step handler for spec 5's tests (spec "Fakes"): answers from a script, records every call.
import type { StepOutcome } from '../../src/workflow/decide.js';
import type {
  CancelContext,
  StepContext,
  StepHandler,
} from '../../src/workflow/step-handler.registry.js';

type Answer = (context: StepContext) => Promise<StepOutcome | void>;

export class ScriptedStepHandler implements StepHandler {
  /** Every `run` call, in order. */
  readonly calls: StepContext[] = [];
  /** Every `onCancel` call, in order (spec 6 plan P6: with how and when the run ended). */
  readonly cancelCalls: CancelContext[] = [];
  /** What `onCancel` returns (default: no block). */
  cancelBlock: string | null = null;
  private readonly answers: Answer[] = [];

  /** The next calls run these answers, in order; with none left a call returns nothing. */
  then(...answers: Answer[]): this {
    this.answers.push(...answers);
    return this;
  }

  /** Forgets what earlier tests scripted and recorded. */
  reset(): void {
    this.calls.length = 0;
    this.cancelCalls.length = 0;
    this.cancelBlock = null;
    this.answers.length = 0;
  }

  /** The next call returns this outcome. */
  answerNext(outcome: StepOutcome): this {
    return this.then(() => Promise.resolve(outcome));
  }

  /** The next call throws this error. */
  failNext(error: Error): this {
    return this.then(() => Promise.reject(error));
  }

  run(context: StepContext): Promise<StepOutcome | void> {
    this.calls.push(context);
    const answer = this.answers.shift();
    return answer ? answer(context) : Promise.resolve();
  }

  onCancel(context: CancelContext): Promise<string | null> {
    this.cancelCalls.push(context);
    return Promise.resolve(this.cancelBlock);
  }
}
