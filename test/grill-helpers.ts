// Spec 6: shared steps of the Grill Me suites (the real handler, the scripted model, real PostgreSQL).
import { Logger } from '@nestjs/common';
import { expect, vi } from 'vitest';
import type { TaskRef } from '../src/contracts/issue-provider.js';
import type {
  GrillAnswer,
  GrillEvaluation,
  GrillRound,
  GrillSession,
} from '../src/generated/prisma/client.js';
import type { TestApp } from './app.js';
import {
  issueCommentCreated,
  issuesLabeled,
} from './fixtures/github/payloads.js';
import { deliver, seedIssue } from './router-helpers.js';

/** A model answer for Grill Me; `questions` as a number makes "Question n?" with "Guess n.". */
export function grillAnswer({
  confidence,
  questions = 0,
  open = [],
  gaps = [],
}: {
  confidence: number;
  questions?: number | { question: string; guess: string }[];
  open?: number[];
  gaps?: string[];
}) {
  return {
    confidence,
    questions:
      typeof questions === 'number'
        ? Array.from({ length: questions }, (_, i) => ({
            question: `Question ${i + 1}?`,
            guess: `Guess ${i + 1}.`,
          }))
        : questions,
    open,
    gaps,
  };
}

/** The lane label added to issue `number`. */
export function laneAdded(number: number, lane = 'full-sdd') {
  return issuesLabeled({ number, label: `workflow: ${lane}` });
}

/** A comment on issue `number` by the test's human (an Approver unless the test says otherwise). */
export function commented(number: number, commentId: number, body: string) {
  return issueCommentCreated({ number, commentId, body });
}

/** Issue `number` in `workflow: full-sdd` with round 1 posted: Q1 … Q`questions` (one scripted model call). */
export async function askedRound1(
  t: TestApp,
  number: number,
  questions = 2,
): Promise<TaskRef> {
  const issue = seedIssue(t, number, { labels: ['workflow: full-sdd'] });
  t.models.replyJson(grillAnswer({ confidence: 50, questions }));
  expect(await deliver(t, laneAdded(number))).toMatchObject({
    status: 'DONE',
  });
  return issue;
}

export interface GrillRows {
  session: GrillSession | null;
  evaluations: GrillEvaluation[];
  rounds: GrillRound[];
  answers: GrillAnswer[];
}

/** The four Grill tables (one run per test). */
export async function grillRows(t: TestApp): Promise<GrillRows> {
  return {
    session: await t.prisma.grillSession.findFirst(),
    evaluations: await t.prisma.grillEvaluation.findMany({
      orderBy: { createdAt: 'asc' },
    }),
    rounds: await t.prisma.grillRound.findMany({ orderBy: { number: 'asc' } }),
    answers: await t.prisma.grillAnswer.findMany({
      orderBy: [{ createdAt: 'asc' }, { commentId: 'asc' }],
    }),
  };
}

/** The bot's comments on the issue, oldest first. */
export function botComments(t: TestApp, issue: TaskRef) {
  return t.issues.commentsOf(issue).filter(({ byBot }) => byBot);
}

/** Every app log line from now on (restored by `vi.restoreAllMocks`). */
export function captureLogs(): string[] {
  const lines: string[] = [];
  vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
    lines.push(String(message));
  });
  return lines;
}
