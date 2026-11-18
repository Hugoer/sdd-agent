// Spec 6 "Which comments are answers" (GMW1, GM4, GM12): the run's comments that its session hasn't read yet, read
// back from the stored events whatever their processing state, through intake's rules.
import { Injectable } from '@nestjs/common';
import type { TaskRef } from '../contracts/issue-provider.js';
import { EventsService } from '../events/events.service.js';
import { IntakeService } from '../intake/intake.service.js';
import { GrillStore, type AnswerRecord } from './grill.store.js';

@Injectable()
export class AnswerReader {
  constructor(
    private readonly events: EventsService,
    private readonly intake: IntakeService,
    private readonly store: GrillStore,
  ) {}

  /**
   * The comment events received from the run's start on (and before `before`, when given: the cancel hook) that
   * are plain comments on the issue by someone with access now (one lookup per author; a failed one throws, IA9),
   * less the comments the session has read; in creation order, then by comment id.
   */
  async unread(
    task: TaskRef,
    run: { startEventReceivedAt: Date },
    sessionId: string | null,
    before?: Date,
  ): Promise<AnswerRecord[]> {
    const stored = await this.events.commentEventsSince(
      task.externalRef,
      run.startEventReceivedAt,
    );
    const events = before
      ? stored.filter(({ receivedAt }) => receivedAt < before)
      : stored;
    const read = sessionId
      ? await this.store.readCommentIds(sessionId)
      : new Set<string>();
    const unread = new Map<string, AnswerRecord>();
    for (const { comment, sender } of await this.intake.answerComments(
      task,
      events,
    )) {
      if (read.has(comment.id) || unread.has(comment.id)) continue;
      unread.set(comment.id, {
        commentId: comment.id,
        author: sender,
        body: comment.body,
        url: comment.url,
        createdAt: comment.createdAt,
      });
    }
    return [...unread.values()].sort(byCreation);
  }
}

/** Creation time, then the comment id as a number (ids are digits). */
export function byCreation(a: AnswerRecord, b: AnswerRecord): number {
  return (
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.commentId.length - b.commentId.length ||
    a.commentId.localeCompare(b.commentId)
  );
}
