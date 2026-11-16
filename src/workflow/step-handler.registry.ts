// Spec 5 "Step-handler registry" (RL1, RLW7): the seam later specs plug into. Step modules register their
// handlers in their onModuleInit; WorkflowModule never imports them (overview §1 module rules).
import { Injectable } from '@nestjs/common';
import type { Lane, TaskRef } from '../contracts/issue-provider.js';
import type { WorkflowInput } from '../contracts/workflow-input.js';
import type { HandlerName, HandlerOp, StepOutcome } from './decide.js';
import type { HeldLease } from './session-lease.service.js';
import { StepNotBuiltError } from './workflow-errors.js';

/** The run a handler works for. Its `id` is the run id everywhere (`execution_logs.run_id`, specs 6–10). */
export interface StepRun {
  id: string;
  number: number;
  lane: Lane;
  grillSkip: boolean;
}

export interface StepContext {
  /** `Task.id` and the issue. */
  task: { id: string; ref: TaskRef };
  run: StepRun;
  /** What decide() asked for (overview §3, the row's action). */
  op: HandlerOp;
  /** The event being processed: the comment, the approval, the run's start event. */
  input: WorkflowInput;
  /** The session lease this job holds; the router renews it while the handler runs. */
  lease: HeldLease;
}

export interface StepHandler {
  /**
   * Plan P4: an outcome of overview §3 goes back into decide(); a result of the work that stops the run carries
   * the step's comment body. Nothing = done (a document or the go-signal was posted). A handler never calls
   * `NeedsHumanService.stop` and never calls another step (D3).
   */
  run(context: StepContext): Promise<StepOutcome | void>;
  /**
   * RL18: when its run is cancelled or replaced, a block of text for the run-ended comment, or null. Called again
   * when that comment is posted later (plan Q1), so it must return the same block and change nothing more.
   */
  onCancel?(context: Omit<StepContext, 'op' | 'input'>): Promise<string | null>;
}

@Injectable()
export class StepHandlerRegistry {
  private readonly handlers = new Map<HandlerName, StepHandler>();

  /** One handler per name; a second registration is a wiring error that stops the app at startup. */
  register(name: HandlerName, handler: StepHandler): void {
    if (this.handlers.has(name)) {
      throw new Error(
        `StepHandlerRegistry: a "${name}" handler is already registered; exactly one module may register it`,
      );
    }
    this.handlers.set(name, handler);
  }

  /** RL1, plan P1: a step whose handler isn't registered stops the run (`step-not-built`). */
  resolve(name: HandlerName): StepHandler {
    const handler = this.handlers.get(name);
    if (!handler) throw new StepNotBuiltError(name);
    return handler;
  }

  /** The handlers with a cancel hook, in the order they were registered. */
  cancelHooks(): { name: HandlerName; handler: StepHandler }[] {
    return [...this.handlers]
      .filter(([, handler]) => handler.onCancel !== undefined)
      .map(([name, handler]) => ({ name, handler }));
  }
}
