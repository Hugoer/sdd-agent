// Spec 13 (bot-feedback) BF1–BF5, BFW1–BFW3: the working sign. On: the mark (`tasks.working_event_id`), 🚀 on the
// event's comment, `bot: working` on the issue, in that order (a crash between two steps never leaves a label without
// a mark). Off: the label, then the mark, when the event holding the mark is finished for good. Every write runs
// under the issue's session lease.
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
  type TaskRef,
} from '../contracts/issue-provider.js';
import { EventsService } from '../events/events.service.js';
import type { Task, WebhookEvent } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { HeldLease } from './session-lease.service.js';
import { TaskService } from './task.service.js';

/** The issue the sign is about, as the router's job knows it. */
export interface SignTarget {
  lease: HeldLease;
  ref: TaskRef;
  /** `#90`, for the log. */
  tag: string;
}

const FINISHED = new Set(['DONE', 'IGNORED', 'FAILED']);

@Injectable()
export class WorkingSignService {
  private readonly logger = new Logger(WorkingSignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TaskService,
    private readonly events: EventsService,
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
  ) {}

  /**
   * Plan FP6: `working_started_at` (kept), the mark (set when empty or already this event's), 🚀 on the event's
   * comment, then the label when this event holds the mark (also on a retried attempt: that repairs a crash between
   * the mark and the label, BFW2; FP2). A GitHub failure throws: the event is retried like any write (BF5).
   */
  async on(
    target: SignTarget,
    event: Pick<WebhookEvent, 'id' | 'deliveryId'>,
    commentId: string | null,
  ): Promise<void> {
    await this.events.workingStarted(event.id);
    const holds = await this.tasks.markWorking(target.lease, event.id);
    if (commentId) await this.issues.reactWorking(target.ref, commentId);
    if (holds) await this.issues.setWorkingLabel(target.ref, true);
    this.logger.log(
      `${target.tag} working on (event ${event.deliveryId})${holds ? '' : ' (the label is another event’s)'}`,
    );
  }

  /**
   * Plan FP7: the event is finished for good. The label comes off when the task's mark is this event (also a mark
   * from an earlier attempt), then the mark is cleared. A GitHub failure is one line and the mark stays (the sweep or
   * the next event removes it, BFW3); the event's own outcome is unchanged.
   */
  async end(target: SignTarget, eventId: string): Promise<void> {
    const task = await this.tasks.get(target.lease.taskId);
    if (task.workingEventId !== eventId) return;
    try {
      await this.issues.setWorkingLabel(target.ref, false);
    } catch (error) {
      this.logger.warn(
        `${target.tag} working off failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    await this.tasks.clearWorkingMark(target.lease, eventId);
    this.logger.log(`${target.tag} working off`);
  }

  /**
   * Plan FP8 (BFW3): first among the pending side effects. A mark naming another event that is finished or gone →
   * the label off, the mark cleared. A GitHub failure throws (the event is retried), as the pending status label.
   */
  async pending(
    target: SignTarget,
    task: Pick<Task, 'workingEventId'>,
    eventId: string,
  ): Promise<void> {
    const mark = task.workingEventId;
    if (!mark || mark === eventId) return;
    const holder = await this.prisma.webhookEvent.findUnique({
      where: { id: mark },
      select: { status: true },
    });
    if (holder && !FINISHED.has(holder.status)) return;
    await this.issues.setWorkingLabel(target.ref, false);
    await this.tasks.clearWorkingMark(target.lease, mark);
    this.logger.log(`${target.tag} working off (left by an earlier event)`);
  }
}
