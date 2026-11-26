// Spec 5 "Owned tables": one of the two writers of `tasks` (RunService writes a run's link to it). Every write
// inside a job is a transaction that first checks the lease owner (SessionLeaseService.assertHeld).
import { Injectable } from '@nestjs/common';
import type { Lane, TaskRef, TaskStatus } from '../contracts/issue-provider.js';
import type { Prisma, Task } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SessionLeaseService,
  type HeldLease,
} from './session-lease.service.js';

/** The issue as the ports name it, from its row (refreshed from every event). */
export function refOf(task: Task): TaskRef {
  return {
    platform: task.platform as TaskRef['platform'],
    id: task.platformId,
    externalRef: task.externalRef,
  };
}

/**
 * Plan P6: a label differs from the status, except `draft` with no label shown (no label wanted, RLW5). Spec 13:
 * shared by the router and the startup sweep.
 */
export function labelPending(
  status: TaskStatus,
  shownStatus: TaskStatus | null,
): boolean {
  return (
    status !== shownStatus && !(status === 'draft' && shownStatus === null)
  );
}

/** Spec "Logging": `#12` for `owner/repo#12` (a log line never holds issue text). */
export function issueTag(externalRef: string): string {
  const at = externalRef.lastIndexOf('#');
  return at >= 0 ? externalRef.slice(at) : externalRef;
}

@Injectable()
export class TaskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leases: SessionLeaseService,
  ) {}

  /**
   * RLW5: every routed issue event has a row (the lease lives on it). Insert-or-nothing before the lease, so two
   * events of a new issue make one row; a new row is `draft` with no label.
   */
  async findOrCreate(ref: TaskRef): Promise<Task> {
    await this.prisma.task.createMany({
      data: [
        {
          platform: ref.platform,
          platformId: ref.id,
          externalRef: ref.externalRef,
        },
      ],
      skipDuplicates: true,
    });
    return this.prisma.task.findUniqueOrThrow({
      where: {
        platform_platformId: { platform: ref.platform, platformId: ref.id },
      },
    });
  }

  get(taskId: string): Promise<Task> {
    return this.prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  }

  /** The `owner/repo#number` the event names (refreshed from every event, under the lease). */
  refreshExternalRef(lease: HeldLease, externalRef: string): Promise<void> {
    return this.write(lease, async (tx) => {
      await tx.task.update({
        where: { id: lease.taskId },
        data: { externalRef },
      });
    });
  }

  /** The source of truth; the label follows (RL5: `shownStatus` differs until it is set). */
  setStatus(lease: HeldLease, status: TaskStatus): Promise<void> {
    return this.write(lease, async (tx) => {
      await tx.task.update({ where: { id: lease.taskId }, data: { status } });
    });
  }

  /** What GitHub shows now, after `setStatusLabel` succeeded. */
  setShownStatus(lease: HeldLease, shownStatus: TaskStatus): Promise<void> {
    return this.write(lease, async (tx) => {
      await tx.task.update({
        where: { id: lease.taskId },
        data: { shownStatus },
      });
    });
  }

  /**
   * Spec 13 (BFW2): the mark set to `eventId` when empty or already this event's; true when this event holds it
   * (another unfinished event's mark is left as it is).
   */
  markWorking(lease: HeldLease, eventId: string): Promise<boolean> {
    return this.write(lease, async (tx) => {
      const { count } = await tx.task.updateMany({
        where: {
          id: lease.taskId,
          OR: [{ workingEventId: null }, { workingEventId: eventId }],
        },
        data: { workingEventId: eventId },
      });
      return count === 1;
    });
  }

  /** Spec 13 (plan FP7): the task whose mark names this event, if any (an event that ends outside the router). */
  byWorkingEvent(eventId: string): Promise<Task | null> {
    return this.prisma.task.findFirst({ where: { workingEventId: eventId } });
  }

  /** Spec 13 (BFW2): the mark cleared, only if it still names `eventId`; true when it did. */
  clearWorkingMark(lease: HeldLease, eventId: string): Promise<boolean> {
    return this.write(lease, async (tx) => {
      const { count } = await tx.task.updateMany({
        where: { id: lease.taskId, workingEventId: eventId },
        data: { workingEventId: null },
      });
      return count === 1;
    });
  }

  /**
   * RL8, plan Q3: after the reminder with marker `conflicts` was posted (post first, then record): the lanes it
   * lists.
   */
  recordLaneConflict(
    lease: HeldLease,
    conflicts: number,
    lanes: Lane[],
  ): Promise<void> {
    return this.write(lease, async (tx) => {
      await tx.task.update({
        where: { id: lease.taskId },
        data: { laneConflictLanes: lanes, laneConflicts: conflicts },
      });
    });
  }

  /** RL8: at most one lane left, or a cancel or restart (RL15). */
  closeLaneConflict(lease: HeldLease): Promise<void> {
    return this.write(lease, async (tx) => {
      await tx.task.update({
        where: { id: lease.taskId },
        data: { laneConflictLanes: [] },
      });
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
