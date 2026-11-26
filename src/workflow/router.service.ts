// Spec 5 "Per-event flow": one accepted event from intake to its end state. The task row and the session lease
// (RLW4, RLW5), the pending side effects (RL5), one read of the issue, decide(), then its action and the
// lane-conflict check (RL8).
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ISSUE_PROVIDER,
  type CommentRef,
  type IssueProvider,
  type Lane,
  type TaskRef,
  type TaskStatus,
} from '../contracts/issue-provider.js';
import { ProviderError } from '../contracts/provider-error.js';
import type { WorkflowInput } from '../contracts/workflow-input.js';
import type { ProcessResult } from '../events/event-processor.js';
import type { Run, Task, WebhookEvent } from '../generated/prisma/client.js';
import {
  decide,
  isStale,
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
import { RunService, type RunEndedBy } from './run.service.js';
import {
  SessionLeaseService,
  type HeldLease,
} from './session-lease.service.js';
import { StepHandlerRegistry, type StepRun } from './step-handler.registry.js';
import { stopCauseOf, waitingStep } from './stop-cause.js';
import { issueTag, refOf, TaskService } from './task.service.js';
import {
  issueClosedComment,
  issueClosedMarker,
  laneConflictComment,
  laneConflictMarker,
  retryRefusedComment,
  retryRefusedMarker,
  RUN_START,
  runEndedComment,
  runEndedMarker,
  type ClosedCommand,
  type LaneConflictReminder,
  type RetryRefusal,
  type RunEnd,
} from './workflow-comments.js';

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
  /** Plan P9: the `/retry` was accepted and written; any later error ends the event `FAILED` at once. */
  retryWritten: boolean;
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
      retryWritten: false,
    };
    const result = await this.leases.withLease(job.lease, async () => {
      try {
        return await this.handle(job);
      } catch (error) {
        throw markError(
          job.retryWritten ? afterRetryWrite(error) : error,
          job.mark,
        );
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
    // RL10: received before the latest run's start event (current or ended). Known before the pending side
    // effects, so a stale event failing there never stops the run (plan P2).
    const latest = await this.runs.latest(task.id);
    job.mark.stale = isStale(
      job.input.receivedAt,
      latest?.startEventReceivedAt ?? null,
    );
    if (task.externalRef !== job.ref.externalRef)
      await this.tasks.refreshExternalRef(job.lease, job.ref.externalRef);

    // RL5: the pending side effects first, even when the event then does nothing.
    let shownStatus = task.shownStatus as TaskStatus | null;
    if (labelPending(status, shownStatus)) {
      await this.showStatus(job, status);
      shownStatus = status;
    }
    // Plan Q1: a run-ended comment first, so a restart's "replaced" comes before the new run's stop comment.
    const ended = await this.runs.lastEnded(task.id);
    if (ended && ended.endCommentId === null)
      await this.completeEndComment(job, ended);
    if (run?.stoppedAt && run.stopCommentId === null)
      await this.needsHuman.postStopComment(job, run);

    // RL10: a stale event does nothing more, not even a read of the issue.
    if (job.mark.stale) {
      this.logger.log(`${job.tag} ignored stale`);
      return ignored('stale');
    }

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
    routing.state.approval = await this.approvalOf(job, routing);
    const { action, laneConflict } = decide(routing.state, job.input);
    // RL8, plan Q3: a conflict that is over is recorded first (nothing to show), so a first step that fails
    // can't leave it open; a reminder is posted after the action, in the wording of what it left.
    if (laneConflict?.kind === 'close')
      await this.tasks.closeLaneConflict(job.lease);
    const result = await this.act(job, routing, action);
    if (laneConflict?.kind === 'post')
      await this.postLaneConflict(job, task.laneConflicts + 1, laneConflict);
    return result;
  }

  /** RL8: post first (its marker searched, so a retried job never posts twice), then record the listed lanes. */
  private async postLaneConflict(
    job: Job,
    conflicts: number,
    reminder: LaneConflictReminder,
  ): Promise<void> {
    await this.postOnce(job, laneConflictMarker(conflicts), () =>
      laneConflictComment(conflicts, reminder),
    );
    await this.tasks.recordLaneConflict(job.lease, conflicts, reminder.lanes);
    this.logger.log(`${job.tag} lane conflict (reminder posted)`);
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
      case 'cancel':
        return this.endRun(job, routing, action.start);
      case 'accept-retry':
        return this.acceptRetry(job, routing);
      case 'reply-retry':
        return this.replyRetry(job, action.refusal);
      case 'ignore':
        this.logger.log(
          `${job.tag} ignored ${action.reason} (status ${routing.state.status})`,
        );
        return ignored(action.reason);
      case 'reply-closed':
        return this.replyClosed(job, action.command);
      case 'reply-without-run': {
        // Spec 7 row 5 (plan P7, P36): the gate answers a document command on an issue with no run.
        const reason = await this.registry.gate().replyWithoutRun({
          task: { id: job.lease.taskId, ref: job.ref },
          input: job.input,
          lease: job.lease,
          lanes: routing.state.lanesOnIssue,
        });
        this.logger.log(`${job.tag} ignored ${reason} (no run)`);
        return ignored(reason);
      }
      case 'wait-workspace':
        // Row 21: spec 8 adds it (the `WAITING_WORKSPACE` event status) with the workspace handler, the only
        // source of `WS_BUSY`; until then no handler can return it.
        throw new Error('row 21 (WS_BUSY) needs spec 8');
      case 'stay-failed':
        // The failure hook's answer to a FAILED input (failed()), never an event's action.
        throw new Error('stay-failed is not an event action');
    }
  }

  /**
   * Rows 6, 7 (RL12, RL15, RL18): the run ends in the database first, its label and comment pending (plan Q1).
   * A cancel shows `draft`; a restart starts run N+1 in the same transaction and its run start follows the
   * "replaced" comment.
   */
  private async endRun(
    job: Job,
    routing: Routing,
    start: { lane: Lane; grillSkip: boolean } | null,
  ): Promise<ProcessResult> {
    const run = requireRun(routing);
    job.mark.step = RUN_START;
    routing.state.status = 'draft';
    if (!start) {
      await this.runs.cancel(job.lease, run, job.event.id);
      this.logger.log(`${job.tag} run ${run.number} cancelled`);
      routing.run = null;
      routing.state.run = null;
      await this.showStatus(job, 'draft');
      routing.state.shownStatus = 'draft';
      await this.postEndComment(
        job,
        run,
        { kind: 'cancelled' },
        endedByJob(job),
      );
      return { status: 'DONE' };
    }
    const next = await this.runs.restart(job.lease, run, {
      ...start,
      startEventId: job.event.id,
    });
    this.logger.log(
      `${job.tag} run ${run.number} restarted → run ${next.number} (${next.lane})`,
    );
    await this.postEndComment(
      job,
      run,
      {
        kind: 'replaced',
        by: { number: next.number, lane: next.lane as Lane },
      },
      endedByJob(job),
    );
    return this.startRun(job, routing, next);
  }

  /** Plan Q1, Q2: a run-ended comment still pending, from the run's row and the event that ended it. */
  private async completeEndComment(job: Job, ended: Run): Promise<void> {
    const end: RunEnd =
      ended.endReason === 'restarted'
        ? {
            kind: 'replaced',
            by: laneRefOf(await this.runs.replacement(ended)),
          }
        : { kind: 'cancelled' };
    await this.postEndComment(job, ended, end, await this.runs.endedBy(ended));
  }

  /**
   * RL18: one comment per ended run, with the cancel hooks' blocks. Its marker is searched first, so a retried
   * job never posts it twice; the hooks are asked only when it is posted (again, if a later event posts it), and
   * told how and when the run ended (spec 6 plan P6).
   */
  private async postEndComment(
    job: Job,
    run: Run,
    end: RunEnd,
    by: RunEndedBy,
  ): Promise<void> {
    const comment = await this.postOnce(job, runEndedMarker(run.id), async () =>
      runEndedComment(
        { id: run.id, ...laneRefOf(run) },
        end,
        by.login,
        await this.registry.cancelBlocks({
          task: { id: job.lease.taskId, ref: job.ref },
          run: stepRunOf(run),
          lease: job.lease,
          end,
          endEventReceivedAt: by.receivedAt,
        }),
      ),
    );
    await this.runs.recordEndComment(job.lease, run.id, comment.id);
  }

  /**
   * Row 30 (plan P8): the status before the stop, `retries + 1` and the stop's event re-queued in one
   * transaction, then the label. The re-queued event is older, so the worker takes it next.
   */
  private async acceptRetry(
    job: Job,
    routing: Routing,
  ): Promise<ProcessResult> {
    const run = requireRun(routing);
    const status = await this.runs.acceptRetry(job.lease, run);
    job.retryWritten = true;
    this.logger.log(
      `${job.tag} /retry accepted: run ${run.number} back to ${status}`,
    );
    await this.showStatus(job, status);
    return { status: 'DONE' };
  }

  /** Row 31, RL20: one reply per `/retry`; its marker is searched first, so a retried job never posts twice. */
  private async replyRetry(
    job: Job,
    refusal: RetryRefusal,
  ): Promise<ProcessResult> {
    const commentId = commentOf(job.input).id;
    await this.postOnce(job, retryRefusedMarker(commentId), () =>
      retryRefusedComment(commentId, refusal),
    );
    this.logger.log(`${job.tag} /retry refused: ${refusal.kind}`);
    return ignored('retry-refused');
  }

  /** RL19: one reply to a command on a closed issue (marker per delivery); nothing starts or continues. */
  private async replyClosed(
    job: Job,
    command: ClosedCommand,
  ): Promise<ProcessResult> {
    const { deliveryId } = job.event;
    await this.postOnce(job, issueClosedMarker(deliveryId), () =>
      issueClosedComment(deliveryId, command),
    );
    this.logger.log(`${job.tag} ignored issue-closed (replied)`);
    return ignored('issue-closed');
  }

  /**
   * A bot comment posted at most once: its marker is searched first, so a retried job finds the comment it
   * posted before (RL5). `body` is built only when the comment is posted.
   */
  private async postOnce(
    job: Job,
    marker: string,
    body: () => string | Promise<string>,
  ): Promise<CommentRef> {
    return (
      (await this.issues.findCommentByMarker(job.ref, marker)) ??
      (await this.issues.postComment(job.ref, await body()))
    );
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

  /**
   * Spec 7 (R2, plan P26): the gate's verdict on an `/approve` in `spec-review` or `ready-for-dev` with a run, on an
   * open issue (spec 5 answers a closed one first, RL19); null for every other event.
   */
  private async approvalOf(job: Job, routing: Routing) {
    const { state, run } = routing;
    if (
      job.input.type !== 'APPROVE' ||
      !run ||
      !state.open ||
      (state.status !== 'spec-review' &&
        state.status !== 'plan-review' &&
        state.status !== 'ready-for-dev')
    )
      return null;
    return this.registry.gate().verdict({
      task: { id: job.lease.taskId, ref: job.ref },
      run: stepRunOf(run),
      input: job.input,
      lease: job.lease,
      status: state.status,
    });
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
      status: routing.state.status,
      statusBeforeStop: run.statusBeforeStop as TaskStatus | null,
      approval: routing.state.approval,
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
    startEventReceivedAt: run.startEventReceivedAt,
  };
}

/** The event being processed ended the run (rows 6, 7): its sender and its `received_at`. */
function endedByJob(job: Job): RunEndedBy {
  return { login: job.input.sender, receivedAt: job.event.receivedAt };
}

function laneRefOf(run: Run): { number: number; lane: Lane } {
  return { number: run.number, lane: run.lane as Lane };
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
    laneConflictLanes: task.laneConflictLanes as Lane[],
    // Asked of spec 7's gate only for an /approve in review (handle()).
    approval: null,
  };
}

/** Why a failure posts nothing (RLW2, RL13, RL16), for the log. */
function failureWithoutStop(run: Run | null, mark: RouterMark): string {
  if (!run) return 'no current run';
  if (run.stoppedAt) return 'the run is already stopped';
  if (mark.retry) return 'a /retry event';
  return 'a stale event';
}

/**
 * Plan P9 (RL13): after an accepted `/retry` was written, a worker retry would find the run running and answer
 * "isn't stopped". The event ends `FAILED` at once, silent; the re-queued event completes the label first.
 */
function afterRetryWrite(error: unknown): ProviderError {
  return new ProviderError(messageOf(error), 'permanent');
}

/** The `/retry` comment of a RETRY input (decide() replies only to one). */
function commentOf(input: IssueInput): { id: string } {
  if (input.type !== 'RETRY')
    throw new Error(`a /retry reply needs a RETRY input, got ${input.type}`);
  return input.comment;
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
