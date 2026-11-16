// Spec 5 "Owned tables": one of the two writers of `tasks` (RunService writes a run's link to it). Every write
// inside a job is a transaction that first checks the lease owner (SessionLeaseService.assertHeld).
import { Injectable } from '@nestjs/common';
import type { TaskRef, TaskStatus } from '../contracts/issue-provider.js';
import type { Prisma, Task } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SessionLeaseService,
  type HeldLease,
} from './session-lease.service.js';

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

  /** RL8, after the reminder with marker `conflicts` was posted (post first, then record). */
  recordLaneConflict(lease: HeldLease, conflicts: number): Promise<void> {
    return this.write(lease, async (tx) => {
      await tx.task.update({
        where: { id: lease.taskId },
        data: { laneConflictOpen: true, laneConflicts: conflicts },
      });
    });
  }

  /** RL8: at most one lane left, or a cancel or restart (RL15). */
  closeLaneConflict(lease: HeldLease): Promise<void> {
    return this.write(lease, async (tx) => {
      await tx.task.update({
        where: { id: lease.taskId },
        data: { laneConflictOpen: false },
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
