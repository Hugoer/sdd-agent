// Spec 13 (bot-feedback) BFW10: at startup, before the worker claims its first event, the leftovers of a crash are
// repaired: a `bot: working` label whose event is finished or gone, and a status label that differs from the
// database (BF7). Each task under its session lease; a GitHub failure is one line and never stops the app (the next
// event on the issue completes it, BFW3).
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
  type TaskStatus,
} from '../contracts/issue-provider.js';
import type { Task } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SessionLeaseService,
  type HeldLease,
} from './session-lease.service.js';
import { issueTag, labelPending, refOf, TaskService } from './task.service.js';

interface Counts {
  removed: number;
  left: number;
  repaired: number;
  skipped: number;
  failed: number;
}

@Injectable()
export class StartupSweepService {
  private readonly logger = new Logger(StartupSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leases: SessionLeaseService,
    private readonly tasks: TaskService,
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
  ) {}

  async sweep(): Promise<void> {
    const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM tasks
      WHERE working_event_id IS NOT NULL OR shown_status IS DISTINCT FROM status
      ORDER BY created_at`;
    const counts: Counts = {
      removed: 0,
      left: 0,
      repaired: 0,
      skipped: 0,
      failed: 0,
    };
    for (const { id } of candidates) {
      try {
        const result = await this.leases.withIdleLease(id, (lease) =>
          this.repair(lease, counts),
        );
        if (!result.claimed) {
          counts.skipped++;
          const task = await this.tasks.get(id);
          this.logger.log(
            `${issueTag(task.externalRef)} skipped by the startup sweep (lease held)`,
          );
        }
      } catch (error) {
        counts.failed++;
        const task = await this.prisma.task.findUnique({ where: { id } });
        this.logger.error(
          `${task ? issueTag(task.externalRef) : id} startup sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const plural = (n: number, word: string) =>
      `${n} ${word}${n === 1 ? '' : 's'}`;
    this.logger.log(
      `startup sweep: ${plural(counts.removed, 'working label')} removed, ${counts.left} left for its event, ` +
        `${plural(counts.repaired, 'status label')} repaired, ${counts.skipped} skipped (lease held), ` +
        `${counts.failed} failed`,
    );
  }

  /** One task, read again under the lease: the mark first, then the status label. */
  private async repair(lease: HeldLease, counts: Counts): Promise<void> {
    const task: Task = await this.tasks.get(lease.taskId);
    const tag = issueTag(task.externalRef);
    const mark = task.workingEventId;
    if (mark) {
      const event = await this.prisma.webhookEvent.findUnique({
        where: { id: mark },
        select: { status: true, deliveryId: true },
      });
      if (
        event &&
        (event.status === 'PENDING' || event.status === 'PROCESSING')
      ) {
        counts.left++;
        this.logger.log(
          `${tag} working label left for event ${event.deliveryId} (pending)`,
        );
      } else {
        await this.issues.setWorkingLabel(refOf(task), false);
        await this.tasks.clearWorkingMark(lease, mark);
        counts.removed++;
        this.logger.log(`${tag} working off (startup sweep)`);
      }
    }
    const status = task.status as TaskStatus;
    if (labelPending(status, task.shownStatus as TaskStatus | null)) {
      await this.issues.setStatusLabel(refOf(task), status);
      await this.tasks.setShownStatus(lease, status);
      counts.repaired++;
      this.logger.log(`${tag} status label repaired: ${status}`);
    }
  }
}
