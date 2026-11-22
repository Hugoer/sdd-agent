// Spec 7: shared steps of the documents suites (the real handlers, the scripted model, real PostgreSQL).
import { expect } from 'vitest';
import type { TaskRef } from '../src/contracts/issue-provider.js';
import type {
  DocumentAction,
  TaskDocument,
} from '../src/generated/prisma/client.js';
import type { TestApp } from './app.js';
import { botComments, grillAnswer, laneAdded } from './grill-helpers.js';
import { deliver, seedIssue } from './router-helpers.js';

/** A short Spec the scripted model writes. */
export const SPEC_TEXT =
  '# Spec\n\n## Objective\n\nSplit a bill evenly between the people in it.\n\n## Success criteria\n\n- 1000 / 3 → 334, 333, 333\n';

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
 * call), then the model writes `spec` (a second one). Returns the issue once its lane event is processed.
 */
export async function specWritten(
  t: TestApp,
  number: number,
  options: { lane?: 'full-sdd' | 'spec-code'; spec?: string } = {},
): Promise<TaskRef> {
  const lane = options.lane ?? 'full-sdd';
  const issue = seedIssue(t, number, { labels: [`workflow: ${lane}`] });
  t.models
    .replyJson(grillAnswer({ confidence: 96 }))
    .reply({ answer: options.spec ?? SPEC_TEXT });
  expect(await deliver(t, laneAdded(number, lane))).toMatchObject({
    status: 'DONE',
  });
  return issue;
}
