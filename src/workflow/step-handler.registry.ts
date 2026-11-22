// Spec 5 "Step-handler registry" (RL1, RLW7): the seam later specs plug into. Step modules register their
// handlers in their onModuleInit; WorkflowModule never imports them (overview §1 module rules).
import { Injectable } from '@nestjs/common';
import type { Lane, TaskRef, TaskStatus } from '../contracts/issue-provider.js';
import type { WorkflowInput } from '../contracts/workflow-input.js';
import type {
  ApprovalVerdict,
  HandlerName,
  HandlerOp,
  StepOutcome,
} from './decide.js';
import type { HeldLease } from './session-lease.service.js';
import type { RunEnd } from './workflow-comments.js';
import { StepNotBuiltError } from './workflow-errors.js';

/** The run a handler works for. Its `id` is the run id everywhere (`execution_logs.run_id`, specs 6–10). */
export interface StepRun {
  id: string;
  number: number;
  lane: Lane;
  grillSkip: boolean;
  /** Spec 6: the start event's `received_at` (PostgreSQL's clock); comments from before it are never answers. */
  startEventReceivedAt: Date;
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
  /** Spec 7 (plan P14): the issue's status when the handler is called, as decide() read it. */
  status: TaskStatus;
  /** Spec 7 (plan P14): the status `/retry` restores, while the run is stopped (`Run.statusBeforeStop`). */
  statusBeforeStop: TaskStatus | null;
  /** Spec 7 (plan P14): the gate's verdict on this event's `/approve`, when decide() read one. */
  approval: ApprovalVerdict | null;
}

/** What a cancel hook is told (spec 6 plan P6), also when a later event posts the run-ended comment. */
export interface CancelContext extends Omit<
  StepContext,
  'op' | 'input' | 'status' | 'statusBeforeStop' | 'approval'
> {
  /** `cancelled`, or `replaced` with the new run's number and lane (spec 6 GM17). */
  end: RunEnd;
  /** The `received_at` of the event that ended the run (spec 6 GM16: answers received before it count). */
  endEventReceivedAt: Date;
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
  onCancel?(context: CancelContext): Promise<string | null>;
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

  /** RL18: the cancel hooks' blocks for the run-ended comment, in the order registered; null adds nothing. */
  async cancelBlocks(context: CancelContext): Promise<string[]> {
    const blocks: string[] = [];
    for (const handler of this.handlers.values()) {
      const block = handler.onCancel ? await handler.onCancel(context) : null;
      if (block !== null) blocks.push(block);
    }
    return blocks;
  }

  /** The handlers with a cancel hook, in the order they were registered. */
  cancelHooks(): { name: HandlerName; handler: StepHandler }[] {
    return [...this.handlers]
      .filter(([, handler]) => handler.onCancel !== undefined)
      .map(([name, handler]) => ({ name, handler }));
  }
}
