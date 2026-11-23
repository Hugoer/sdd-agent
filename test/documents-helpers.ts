// Spec 7: shared steps of the documents suites (the real handlers, the scripted model, real PostgreSQL).
import { expect } from 'vitest';
import type { TaskRef } from '../src/contracts/issue-provider.js';
import type {
  DocumentAction,
  TaskDocument,
} from '../src/generated/prisma/client.js';
import type { TestApp } from './app.js';
import { issueCommentCreated } from './fixtures/github/payloads.js';
import { botComments, grillAnswer, laneAdded } from './grill-helpers.js';
import { deliver, seedIssue } from './router-helpers.js';

/** A short Spec the scripted model writes. */
export const SPEC_TEXT =
  '# Spec\n\n## Objective\n\nSplit a bill evenly between the people in it.\n\n## Success criteria\n\n- 1000 / 3 → 334, 333, 333\n';

/** A short Plan the scripted model writes. */
export const PLAN_TEXT =
  '# Plan\n\n## Task 1: `split()` in `src/index.ts`\n\n- Acceptance: 1000 / 3 → 334, 333, 333\n- Verify: `npm test`\n';

/** Every version, oldest first. */
export function documentRows(t: TestApp): Promise<TaskDocument[]> {
  return t.prisma.taskDocument.findMany({ orderBy: { createdAt: 'asc' } });
}

/** Every answered action, oldest first. */
export function actionRows(t: TestApp): Promise<DocumentAction[]> {
  return t.prisma.documentAction.findMany({ orderBy: { createdAt: 'asc' } });
}

/** The bot's comments on the issue that hold this marker. */
export function withMarker(t: TestApp, issue: TaskRef, marker: string) {
  return botComments(t, issue).filter(({ body }) => body.includes(marker));
}

/**
 * Issue `number` in `lane` whose run reaches the Spec at once: Grill Me is sure with no question (one scripted
 * call), then the model writes `spec` (a second one, after a load turn when it `reads` files). Returns the issue
 * once its lane event is processed.
 */
export async function specWritten(
  t: TestApp,
  number: number,
  options: {
    lane?: 'full-sdd' | 'spec-code';
    spec?: string;
    /** Repo files the Spec's call reads with `read_file` before it answers. */
    reads?: string[];
    description?: string;
  } = {},
): Promise<TaskRef> {
  const lane = options.lane ?? 'full-sdd';
  const issue = seedIssue(t, number, {
    labels: [`workflow: ${lane}`],
    description: options.description,
  });
  t.models.replyJson(grillAnswer({ confidence: 96 }));
  if (options.reads)
    t.models.reply({
      answer: '',
      toolCalls: options.reads.map((path, index) => ({
        name: 'read_file',
        args: { path, reason: 'The Spec names it.' },
        id: `read-${index}`,
      })),
    });
  t.models.reply({ answer: options.spec ?? SPEC_TEXT });
  expect(await deliver(t, laneAdded(number, lane))).toMatchObject({
    status: 'DONE',
  });
  return issue;
}

/**
 * Plan P23: a comment on issue `number` created now (the payload fixture's default date is before every document, so
 * every `/approve` would count as written before it); `secondsAgo` moves it back.
 */
export function commentNow(
  number: number,
  commentId: number,
  body: string,
  secondsAgo = 0,
) {
  return issueCommentCreated({
    number,
    commentId,
    body,
    createdAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  });
}

/** Runs a processed event again, as the worker does after a crash (its row back to PENDING, due now). */
export async function runAgain(t: TestApp, eventId: string): Promise<void> {
  await t.prisma.webhookEvent.update({
    where: { id: eventId },
    data: { status: 'PENDING', availableAt: new Date(0), ignoreReason: null },
  });
  await t.worker.drainOnce();
}

/** A load turn that reads these repo files, then the given answer: two scripted model replies. */
export function scriptReads(t: TestApp, reads: string[], answer: string): void {
  if (reads.length > 0)
    t.models.reply({
      answer: '',
      toolCalls: reads.map((path, index) => ({
        name: 'read_file',
        args: { path, reason: 'It names it.' },
        id: `read-${index}`,
      })),
    });
  t.models.reply({ answer });
}
