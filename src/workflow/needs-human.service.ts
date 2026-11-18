// Spec 5 "Failure → needs-human" (row 28; RL4, RL5) and the stops that are a result of the work (rows 14, 22, 25,
// 26; plan P4): the database first (D13), then the label and one comment with its marker.
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ISSUE_PROVIDER,
  type IssueProvider,
  type Lane,
  type TaskRef,
} from '../contracts/issue-provider.js';
import type { Run } from '../generated/prisma/client.js';
import type { StopDecision } from './decide.js';
import { RunService } from './run.service.js';
import type { HeldLease } from './session-lease.service.js';
import { workResultReason } from './stop-cause.js';
import { TaskService } from './task.service.js';
import {
  needsHumanMarker,
  RUN_START,
  stopComment,
} from './workflow-comments.js';

/** The issue a stop is for, and the lease the job holds. */
export interface StopTarget {
  lease: HeldLease;
  ref: TaskRef;
  /** `#12`, for the log. */
  tag: string;
}

@Injectable()
export class NeedsHumanService {
  private readonly logger = new Logger(NeedsHumanService.name);

  constructor(
    private readonly runs: RunService,
    private readonly tasks: TaskService,
    @Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider,
  ) {}

  /** `save`, then `notify`; a GitHub error propagates with the label and the comment pending (RL5). */
  async stop(
    target: StopTarget,
    run: Run,
    stop: StopDecision,
    eventId: string,
  ): Promise<Run> {
    const stopped = await this.save(target, run, stop, eventId);
    await this.notify(target, stopped);
    return stopped;
  }

  /**
   * One transaction: the run stopped (step, cause, message, retryable, the event `/retry` re-queues, the status
   * before), `stops + 1`, `needs-human`. A work-result stop keeps the step's body as its message, so a pending
   * comment can be posted later.
   */
  async save(
    target: StopTarget,
    run: Run,
    stop: StopDecision,
    eventId: string,
  ): Promise<Run> {
    const stopped = await this.runs.stop(target.lease, run, {
      step: stop.step,
      cause: stop.cause,
      message: stop.kind === 'failure' ? stop.message : stop.body,
      retryable: stop.retryable,
      eventId,
    });
    this.logger.log(
      `${target.tag} run ${stopped.number} stopped at ${stop.step}: ${stop.cause}`,
    );
    return stopped;
  }

  /** The label, then the comment (recorded as shown and posted, each once it succeeded). */
  async notify(target: StopTarget, stopped: Run): Promise<void> {
    await this.issues.setStatusLabel(target.ref, 'needs-human');
    await this.tasks.setShownStatus(target.lease, 'needs-human');
    await this.postStopComment(target, stopped);
  }

  /** RL5: the comment of a stop not yet recorded. Its marker is searched first, so it is never posted twice. */
  async postStopComment(target: StopTarget, run: Run): Promise<void> {
    const marker = needsHumanMarker(run.id, run.stops);
    const comment =
      (await this.issues.findCommentByMarker(target.ref, marker)) ??
      (await this.issues.postComment(target.ref, stopCommentOf(run)));
    await this.runs.recordStopComment(target.lease, run.id, comment.id);
  }
}

/** The stop comment, from the run's row alone (its latest stop). */
export function stopCommentOf(run: Run): string {
  const cause = run.stopCause ?? 'internal-error';
  const message = run.stopMessage ?? '';
  return stopComment(
    { id: run.id, number: run.number, lane: run.lane as Lane },
    run.stops,
    workResultReason(cause) !== null
      ? { kind: 'work-result', cause, body: message }
      : { kind: 'failure', step: run.stopStep ?? RUN_START, message, cause },
  );
}
