// Spec 5 "Step-handler registry" (RL1, RLW7): the seam later specs plug into. Step modules register their
// handlers in their onModuleInit; WorkflowModule never imports them (overview §1 module rules).
import { Injectable } from '@nestjs/common';
import type { Lane, TaskRef, TaskStatus } from '../contracts/issue-provider.js';
import type { WorkflowInput } from '../contracts/workflow-input.js';
import type {
  ApprovalVerdict,
  HandlerName,
  HandlerOp,
  RouterIgnoreReason,
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
  /**
   * Spec 13 (BFW1): called right before the event's first model call (later: the Coder's and the Quality Gate's
   * loops). Shows the working sign: the mark, 🚀 on the event's comment, `bot: working`. A second call in the same
   * job does nothing; the router takes the sign down when the event is finished for good.
   */
  working(): Promise<void>;
}

/** What a cancel hook is told (spec 6 plan P6), also when a later event posts the run-ended comment. */
export interface CancelContext extends Omit<
  StepContext,
  'op' | 'input' | 'status' | 'statusBeforeStop' | 'approval' | 'working'
> {
  /** `cancelled`, or `replaced` with the new run's number and lane (spec 6 GM17). */
  end: RunEnd;
  /** The `received_at` of the event that ended the run (spec 6 GM16: answers received before it count). */
  endEventReceivedAt: Date;
}

/**
 * Spec 7 plan P7, P26: the documents' gate, which DocumentsModule registers. The router asks its verdict for an
 * `/approve` in `spec-review` or `ready-for-dev` with a run, before decide() (R2), so WorkflowModule imports nothing
 * from `src/documents`.
 */
export interface ApprovalGate {
  verdict(context: GateContext): Promise<ApprovalVerdict>;
  /**
   * Plan P7, P36 (row 5): the one reply to a document command on an issue with no run; the reason the event then
   * ends `IGNORED` with (the command's `-refused` reason).
   */
  replyWithoutRun(context: NoRunContext): Promise<RouterIgnoreReason>;
}

/**
 * A command on an issue with no run: the issue, the event, the lease, and the `workflow:` labels on the issue as this
 * event read them (spec 7 plan P40: a label whose event the bot missed is named in the reply).
 */
export type NoRunContext = Pick<StepContext, 'task' | 'input' | 'lease'> & {
  lanes: Lane[];
};

/** What the gate reads: the run, its status, the `/approve` event and the lease of this job. */
export type GateContext = Pick<
  StepContext,
  'task' | 'run' | 'input' | 'lease' | 'status'
>;

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
  private approvalGate: ApprovalGate | null = null;

  /** Spec 7 (plan P26): one gate, like a handler name; a second registration stops the app at startup. */
  registerGate(gate: ApprovalGate): void {
    if (this.approvalGate) {
      throw new Error(
        'StepHandlerRegistry: an approval gate is already registered; exactly one module may register it',
      );
    }
    this.approvalGate = gate;
  }

  /** The registered gate; none is a wiring error (DocumentsModule is part of the app). */
  gate(): ApprovalGate {
    if (!this.approvalGate)
      throw new Error('StepHandlerRegistry: no approval gate is registered');
    return this.approvalGate;
  }

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
