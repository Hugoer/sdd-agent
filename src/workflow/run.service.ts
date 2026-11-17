// Spec 5 "Owned tables", "A run's life": the only writer of `runs`. Every write is a transaction that first
// checks the lease owner; the times the router compares (`stoppedAt`, `startEventReceivedAt`) are PostgreSQL's
// (plan P7).
import { Injectable } from '@nestjs/common';
import type { Lane, TaskStatus } from '../contracts/issue-provider.js';
import { EventsService } from '../events/events.service.js';
import type { Prisma, Run, Task } from '../generated/prisma/client.js';
import { senderLoginOf } from '../intake/github-payload.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SessionLeaseService,
  type HeldLease,
} from './session-lease.service.js';

/** What a new run starts from (RL3 step 1). */
export interface RunStart {
  lane: Lane;
  /** `grill: skip`, read from the API now. */
  grillSkip: boolean;
  /** `webhook_events.id` of the event that starts it. */
  startEventId: string;
}

/** A stop's record (RLW1): the latest stop stays on the run after `/retry` and after it ends. */
export interface RunStop {
  /** Plan P3: the handler's name, or `run-start`. */
  step: string;
  cause: string;
  message: string;
  retryable: boolean;
  /** The event `/retry` re-queues. */
  eventId: string;
}

@Injectable()
export class RunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leases: SessionLeaseService,
    private readonly events: EventsService,
  ) {}

  current(task: Pick<Task, 'currentRunId'>): Promise<Run | null> {
    return task.currentRunId
      ? this.prisma.run.findUnique({ where: { id: task.currentRunId } })
      : Promise.resolve(null);
  }

  /** The issue's latest run, current or ended (the stale rule, RL10; a pending run-ended comment, plan Q1). */
  latest(taskId: string): Promise<Run | null> {
    return this.prisma.run.findFirst({
      where: { taskId },
      orderBy: { number: 'desc' },
    });
  }

  /** Rows 2, 4 (RL3 step 1). Plan P15: refused while a run is current; a restart ends it first. */
  create(lease: HeldLease, start: RunStart): Promise<Run> {
    return this.write(lease, (tx) => this.createIn(tx, lease, start));
  }

  /** The issue's latest ended run: its run-ended comment may be pending (plan Q1). */
  lastEnded(taskId: string): Promise<Run | null> {
    return this.prisma.run.findFirst({
      where: { taskId, endedAt: { not: null } },
      orderBy: { number: 'desc' },
    });
  }

  /** The run that replaced a restarted one: the restart created it as number N+1 (RL12). */
  replacement(run: Run): Promise<Run> {
    return this.prisma.run.findUniqueOrThrow({
      where: { taskId_number: { taskId: run.taskId, number: run.number + 1 } },
    });
  }

  /** Plan Q2: the login of the event that ended the run, also when another event posts its comment later. */
  async endedBy(run: Run): Promise<string> {
    if (!run.endEventId) throw new Error(`run ${run.id} has not ended`);
    const event = await this.prisma.webhookEvent.findUniqueOrThrow({
      where: { id: run.endEventId },
      select: { payload: true },
    });
    const login = senderLoginOf(event);
    if (!login) throw new Error(`event ${run.endEventId} has no sender login`);
    return login;
  }

  /**
   * Rows 6, 7 (RL12): run N ends `restarted` and run N+1 starts, in one transaction. The start event ended it
   * (plan Q2).
   */
  restart(lease: HeldLease, run: Run, start: RunStart): Promise<Run> {
    return this.write(lease, async (tx) => {
      await this.endIn(tx, lease, run, 'restarted', start.startEventId);
      return this.createIn(tx, lease, start);
    });
  }

  /** Row 6, RL19: the run ends `cancelled`; the issue goes back to `draft` with no current run. */
  cancel(lease: HeldLease, run: Run, endEventId: string): Promise<void> {
    return this.write(lease, (tx) =>
      this.endIn(tx, lease, run, 'cancelled', endEventId),
    );
  }

  /**
   * Rows 14, 22, 25, 26, 28 (RL5: the database first). The stop comment is pending until `recordStopComment`.
   * Returns the stopped run (its `stops` numbers the comment's marker).
   */
  stop(lease: HeldLease, run: Run, stop: RunStop): Promise<Run> {
    return this.write(lease, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE runs SET
          stopped_at = now(),
          stop_step = ${stop.step},
          stop_cause = ${stop.cause},
          stop_message = ${stop.message},
          stop_retryable = ${stop.retryable},
          stop_event_id = ${stop.eventId}::uuid,
          status_before_stop = (SELECT status FROM tasks WHERE id = ${lease.taskId}::uuid),
          stop_comment_id = NULL,
          stops = stops + 1
        WHERE id = ${run.id}::uuid AND ended_at IS NULL AND stopped_at IS NULL`;
      if (updated !== 1)
        throw new Error(`run ${run.id} is not running, so it cannot stop`);
      await tx.task.update({
        where: { id: lease.taskId },
        data: { status: 'needs-human' },
      });
      return tx.run.findUniqueOrThrow({ where: { id: run.id } });
    });
  }

  /**
   * Row 30 (plan P8): the status before the stop, the stop cleared (its `stop_*` fields kept), `retries + 1`, and
   * the stop's event re-queued, all in one transaction. Returns the restored status.
   */
  acceptRetry(lease: HeldLease, run: Run): Promise<TaskStatus> {
    return this.write(lease, async (tx) => {
      const { statusBeforeStop, stopEventId } = run;
      if (!statusBeforeStop || !stopEventId)
        throw new Error(`run ${run.id} has no stop to retry`);
      const updated = await tx.$executeRaw`
        UPDATE runs SET stopped_at = NULL, retries = retries + 1
        WHERE id = ${run.id}::uuid AND ended_at IS NULL AND stopped_at IS NOT NULL`;
      if (updated !== 1) throw new Error(`run ${run.id} is not stopped`);
      await tx.task.update({
        where: { id: lease.taskId },
        data: { status: statusBeforeStop },
      });
      await this.events.requeue(stopEventId, tx);
      return statusBeforeStop as TaskStatus;
    });
  }

  /** RL5: the stop comment was posted. */
  recordStopComment(
    lease: HeldLease,
    runId: string,
    commentId: string,
  ): Promise<void> {
    return this.write(lease, async (tx) => {
      await tx.run.update({
        where: { id: runId },
        data: { stopCommentId: commentId },
      });
    });
  }

  /** Plan Q1: the run-ended comment was posted. */
  recordEndComment(
    lease: HeldLease,
    runId: string,
    commentId: string,
  ): Promise<void> {
    return this.write(lease, async (tx) => {
      await tx.run.update({
        where: { id: runId },
        data: { endCommentId: commentId },
      });
    });
  }

  private async createIn(
    tx: Prisma.TransactionClient,
    lease: HeldLease,
    start: RunStart,
  ): Promise<Run> {
    const task = await tx.task.findUniqueOrThrow({
      where: { id: lease.taskId },
    });
    if (task.currentRunId)
      throw new Error(
        `task ${task.id} already has a current run (${task.currentRunId}); only a restart replaces it`,
      );
    const { receivedAt } = await tx.webhookEvent.findUniqueOrThrow({
      where: { id: start.startEventId },
      select: { receivedAt: true },
    });
    const number = task.runCount + 1;
    const run = await tx.run.create({
      data: {
        taskId: task.id,
        number,
        lane: start.lane,
        grillSkip: start.grillSkip,
        startEventId: start.startEventId,
        startEventReceivedAt: receivedAt,
      },
    });
    await tx.task.update({
      where: { id: task.id },
      data: { currentRunId: run.id, runCount: number },
    });
    return run;
  }

  /**
   * RLW1: an end keeps the latest stop (`stop_*`, `stopped_at`), so "wasted by cause" is one query. Its comment
   * is pending until `recordEndComment` (plan Q1). RL15: the lane conflict is closed, so the check that follows
   * posts a fresh reminder.
   */
  private async endIn(
    tx: Prisma.TransactionClient,
    lease: HeldLease,
    run: Run,
    reason: 'cancelled' | 'restarted',
    endEventId: string,
  ): Promise<void> {
    const updated = await tx.$executeRaw`
      UPDATE runs SET ended_at = now(), end_reason = ${reason}, end_event_id = ${endEventId}::uuid
      WHERE id = ${run.id}::uuid AND ended_at IS NULL`;
    if (updated !== 1) throw new Error(`run ${run.id} has already ended`);
    await tx.task.update({
      where: { id: lease.taskId },
      data: { currentRunId: null, status: 'draft', laneConflictLanes: [] },
    });
  }

  private write<T>(
    lease: HeldLease,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.leases.assertHeld(tx, lease);
      return work(tx);
    });
  }
}
