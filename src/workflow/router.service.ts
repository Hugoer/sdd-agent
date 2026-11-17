// Spec 5 "Per-event flow": one accepted event from intake to its end state. The task row and the session lease
// (RLW4, RLW5), the pending side effects (RL5), one read of the issue, decide(), then its action. Plan P12: an
// action not built yet ends `no-transition` with a log line.
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
  type Lane,
  type TaskRef,
  type TaskStatus,
} from '../contracts/issue-provider.js';
import type { WorkflowInput } from '../contracts/workflow-input.js';
import type { ProcessResult } from '../events/event-processor.js';
import type { Run, Task, WebhookEvent } from '../generated/prisma/client.js';
import {
  decide,
  type Action,
  type CurrentRun,
  type HandlerCall,
  type RouterIgnoreReason,
  type RouterState,
  type StepOutcome,
} from './decide.js';
import { NeedsHumanService } from './needs-human.service.js';
import {
  markError,
  routerMarkOf,
  type RouterMark,
} from './router-error-mark.js';
import { RunStartService } from './run-start.service.js';
import { RunService } from './run.service.js';
import {
  SessionLeaseService,
  type HeldLease,
} from './session-lease.service.js';
import { StepHandlerRegistry, type StepRun } from './step-handler.registry.js';
import { stopCauseOf, waitingStep } from './stop-cause.js';
import { issueTag, refOf, TaskService } from './task.service.js';
import { RUN_START } from './workflow-comments.js';

/** RLW11: a lease held by another event → the event waits this long, without counting an attempt. */
export const LEASE_WAIT_MS = 5_000;

/** The router's ignore reasons (spec "Per-event flow"): decide()'s and the ones the flow itself gives. */
export type EventIgnoreReason =
  RouterIgnoreReason | 'no-task' | 'stale' | 'retry-refused';

type IssueInput = Exclude<WorkflowInput, { type: 'PR_UPDATED' }>;

/** What the job knows while it acts: decide()'s state, the current run's row and the issue's description. */
interface Routing {
  state: RouterState;
  run: Run | null;
  description: string;
}

/** One event processed under its issue's lease. */
interface Job {
  event: WebhookEvent;
  input: IssueInput;
  lease: HeldLease;
  /** The issue as this event names it (the freshest `externalRef`). */
  ref: TaskRef;
  /** `#12`, for the log. */
  tag: string;
  /** Plan P2: copied onto any error the job throws; `step` follows the job (plan P3). */
  mark: RouterMark;
}

@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);

  constructor(
    private readonly tasks: TaskService,
    private readonly runs: RunService,
    private readonly leases: SessionLeaseService,
    private readonly runStart: RunStartService,
    private readonly registry: StepHandlerRegistry,
    private readonly needsHuman: NeedsHumanService,
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
  ) {}

  async route(
    event: WebhookEvent,
    input: WorkflowInput,
  ): Promise<ProcessResult> {
    if (input.type === 'PR_UPDATED') {
      // RLW6: spec 9 maps a bot PR to its issue; until then no task is found for it.
      this.logger.log(`PR #${input.pr.number} ignored no-task`);
      return ignored('no-task');
    }
    const task = await this.tasks.findOrCreate(input.task);
    const job: Job = {
      event,
      input,
      lease: { taskId: task.id, eventId: event.id },
      ref: input.task,
      tag: issueTag(input.task.externalRef),
      mark: {
        taskId: task.id,
        step: RUN_START,
        retry: input.type === 'RETRY',
        stale: false,
      },
    };
    const result = await this.leases.withLease(job.lease, async () => {
      try {
        return await this.handle(job);
      } catch (error) {
        throw markError(error, job.mark);
      }
    });
    if (!result.claimed) {
      this.logger.log(
        `${job.tag} lease taken, waiting ${LEASE_WAIT_MS / 1000} s`,
      );
      return { status: 'WAIT', delayMs: LEASE_WAIT_MS };
    }
    return result.value;
  }

  /**
   * Row 28 (spec "Failure → needs-human", plan P16): the worker marked the event FAILED. Only an error marked after
   * the claim (plan P2) can stop the run, and only as decide() says: a running run, not a `/retry`, not stale.
   */
  async failed(event: WebhookEvent, error: unknown): Promise<void> {
    const mark = routerMarkOf(error);
    if (!mark) return; // Before the claim (intake): a silent FAILED (IA9).
    const lease = { taskId: mark.taskId, eventId: event.id };
    const result = await this.leases.withLease(lease, () =>
      this.stopOnFailure(event, error, mark, lease),
    );
    if (!result.claimed) {
      // Plan P10: only with two instances on one database; a redelivery runs the event again.
      this.logger.error(
        `task ${mark.taskId}: the session lease is taken, so event ${event.deliveryId} stays FAILED without a stop`,
      );
    }
  }

  private async stopOnFailure(
    event: WebhookEvent,
    error: unknown,
    mark: RouterMark,
    lease: HeldLease,
  ): Promise<void> {
    const task = await this.tasks.get(lease.taskId);
    const run = await this.runs.current(task);
    const target = { lease, ref: refOf(task), tag: issueTag(task.externalRef) };
    const { cause, message } = stopCauseOf(error, event.deliveryId);
    // decide() reads only the run for a failure: the issue isn't read here (GitHub may be what failed).
    const state = stateOf(task, run, event.id, {
      lanes: [],
      grillSkip: false,
      open: true,
    });
    const { action } = decide(state, {
      type: 'FAILED',
      cause,
      message,
      step: mark.step,
      retry: mark.retry,
      stale: mark.stale,
    });
    if (action.kind !== 'stop' || !run) {
      this.logger.log(
        `${target.tag} failure without a stop (${failureWithoutStop(run, mark)}): ${cause}`,
      );
      return;
    }
    const stopped = await this.needsHuman.save(
      target,
      run,
      action.stop,
      event.id,
    );
    try {
      await this.needsHuman.notify(target, stopped);
    } catch (notifyError) {
      // RL5: the event is FAILED already; the next event on the issue completes the label and the comment.
      this.logger.error(
        `${target.tag} run ${stopped.number}: the stop's label or comment is pending: ${messageOf(notifyError)}`,
      );
    }
  }

  private async handle(job: Job): Promise<ProcessResult> {
    const task = await this.tasks.get(job.lease.taskId);
    const run = await this.runs.current(task);
    const status = task.status as TaskStatus;
    job.mark.step = waitingStep(status, run && runLane(run));
    if (task.externalRef !== job.ref.externalRef)
      await this.tasks.refreshExternalRef(job.lease, job.ref.externalRef);

    // RL5: the pending side effects first, even when the event then does nothing.
    let shownStatus = task.shownStatus as TaskStatus | null;
    if (labelPending(status, shownStatus)) {
      await this.showStatus(job, status);
      shownStatus = status;
    }
    if (run?.stoppedAt && run.stopCommentId === null)
      await this.needsHuman.postStopComment(job, run);

    // One read per routed issue event: lanes, `grill: skip` and `open` together.
    const details = await this.issues.getTaskDetails(job.ref);
    const controls = this.issues.readControls(details);
    const routing: Routing = {
      state: {
        ...stateOf(task, run, job.event.id, {
          lanes: controls.lanes,
          grillSkip: controls.grillSkip,
          open: details.open,
        }),
        shownStatus,
      },
      run,
      description: details.description,
    };
    return this.act(job, routing, decide(routing.state, job.input).action);
  }

  /** The dispatch loop: an action, its handler calls, their outcome back into decide() … until the job ends. */
  private async act(
    job: Job,
    routing: Routing,
    action: Action,
  ): Promise<ProcessResult> {
    switch (action.kind) {
      case 'label-draft':
        // Row 1 (plan P6).
        await this.showStatus(job, 'draft');
        this.logger.log(`${job.tag} status: draft`);
        return { status: 'DONE' };
      case 'start-run': {
        // Rows 2, 4 (RL3 step 1).
        const run = await this.runStart.create(job.lease, job.tag, {
          lane: action.lane,
          grillSkip: action.grillSkip,
          startEventId: job.event.id,
        });
        return this.startRun(job, routing, run);
      }
      case 'continue-run': {
        // RL14, RLW9: this event started the running run; its start again from the check, stored lane and skip.
        const run = requireRun(routing);
        this.logger.log(`${job.tag} run ${run.number} start continued`);
        return this.startRun(job, routing, run);
      }
      case 'steps': {
        if (action.statusFirst)
          await this.setStatus(job, routing, action.statusFirst);
        for (const call of action.calls) {
          const outcome = await this.callHandler(job, routing, call);
          if (outcome)
            return this.act(
              job,
              routing,
              decide(routing.state, outcome).action,
            );
        }
        // Plan P4: every call returned nothing (a document or the go-signal was posted).
        if (action.statusAfter)
          await this.setStatus(job, routing, action.statusAfter);
        return { status: 'DONE' };
      }
      case 'set-status':
        await this.setStatus(job, routing, action.status);
        return { status: 'DONE' };
      case 'stop': {
        // A result of the work (rows 14, 22, 25, 26; plan P4): the step's body, only a restart continues.
        const stopped = await this.needsHuman.stop(
          job,
          requireRun(routing),
          action.stop,
          job.event.id,
        );
        routing.run = stopped;
        routing.state.status = 'needs-human';
        return { status: 'DONE' };
      }
      case 'ignore':
        this.logger.log(
          `${job.tag} ignored ${action.reason} (status ${routing.state.status})`,
        );
        return ignored(action.reason);
      default:
        return this.notBuiltYet(job.tag, action.kind);
    }
  }

  /** RL3 steps 2–4: the check and the warning (safe to repeat), then the first step through decide(). */
  private async startRun(
    job: Job,
    routing: Routing,
    run: Run,
  ): Promise<ProcessResult> {
    job.mark.step = RUN_START;
    routing.run = run;
    routing.state.run = currentRunOf(run, job.event.id);
    await this.runStart.check(job.ref, run, routing.description);
    return this.act(
      job,
      routing,
      decide(routing.state, { type: 'RUN_START' }).action,
    );
  }

  /** One handler call (plan P4); an unregistered handler throws StepNotBuiltError (RL1). */
  private async callHandler(
    job: Job,
    routing: Routing,
    call: HandlerCall,
  ): Promise<StepOutcome | null> {
    const run = requireRun(routing);
    job.mark.step = call.handler;
    const handler = this.registry.resolve(call.handler);
    this.logger.log(
      `${job.tag} run ${run.number}: ${call.handler} (${call.op})`,
    );
    const outcome = await handler.run({
      task: { id: job.lease.taskId, ref: job.ref },
      run: stepRunOf(run),
      op: call.op,
      input: job.input,
      lease: job.lease,
    });
    job.mark.step = waitingStep(routing.state.status, runLane(run));
    return outcome ?? null;
  }

  /** The source of truth first, then its label (RLW5); the step a stop names follows the status (plan P3). */
  private async setStatus(
    job: Job,
    routing: Routing,
    status: TaskStatus,
  ): Promise<void> {
    await this.tasks.setStatus(job.lease, status);
    routing.state.status = status;
    job.mark.step = waitingStep(status, routing.run && runLane(routing.run));
    await this.showStatus(job, status);
    routing.state.shownStatus = status;
    this.logger.log(`${job.tag} status: ${status}`);
  }

  /** RLW5: what GitHub shows follows `Task.status`; `shownStatus` records it once the label is set. */
  private async showStatus(job: Job, status: TaskStatus): Promise<void> {
    await this.issues.setStatusLabel(job.ref, status);
    await this.tasks.setShownStatus(job.lease, status);
  }

  /** Plan P12: until its action is built, an accepted event ends `no-transition`. */
  private notBuiltYet(tag: string, what: string): ProcessResult {
    this.logger.log(`${tag} not built yet: ${what}`);
    return ignored('no-transition');
  }
}

/** Plan P6: a label differs from the status, except `draft` with no label shown (no label wanted, RLW5). */
function labelPending(
  status: TaskStatus,
  shownStatus: TaskStatus | null,
): boolean {
  return (
    status !== shownStatus && !(status === 'draft' && shownStatus === null)
  );
}

function requireRun(routing: Routing): Run {
  if (!routing.run) throw new Error('the action needs a current run');
  return routing.run;
}

function stepRunOf(run: Run): StepRun {
  return {
    id: run.id,
    number: run.number,
    lane: run.lane as Lane,
    grillSkip: run.grillSkip,
  };
}

function runLane(run: Run): { lane: Lane; stopStep: string | null } {
  return { lane: run.lane as Lane, stopStep: run.stopStep };
}

/** decide()'s state from the rows and what the issue shows now. */
function stateOf(
  task: Task,
  run: Run | null,
  eventId: string,
  issue: { lanes: Lane[]; grillSkip: boolean; open: boolean },
): RouterState {
  return {
    status: task.status as TaskStatus,
    shownStatus: task.shownStatus as TaskStatus | null,
    runCount: task.runCount,
    run: run && currentRunOf(run, eventId),
    lanesOnIssue: issue.lanes,
    grillSkipOnIssue: issue.grillSkip,
    open: issue.open,
    laneConflictOpen: task.laneConflictOpen,
    // Decided at Checkpoint 2: spec 7 provides the check; until then every /approve counts.
    approveValid: true,
  };
}

/** Why a failure posts nothing (RLW2, RL13, RL16), for the log. */
function failureWithoutStop(run: Run | null, mark: RouterMark): string {
  if (!run) return 'no current run';
  if (run.stoppedAt) return 'the run is already stopped';
  if (mark.retry) return 'a /retry event';
  return 'a stale event';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The run as decide() reads it. */
function currentRunOf(run: Run, eventId: string): CurrentRun {
  return {
    id: run.id,
    number: run.number,
    lane: run.lane as Lane,
    grillSkip: run.grillSkip,
    startedByThisEvent: run.startEventId === eventId,
    stop: run.stoppedAt
      ? {
          retryable: run.stopRetryable ?? true,
          at: run.stoppedAt,
          cause: run.stopCause ?? '',
        }
      : null,
  };
}

function ignored(reason: EventIgnoreReason): ProcessResult {
  return { status: 'IGNORED', reason };
}
