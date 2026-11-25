import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TaskRef } from '../src/contracts/issue-provider.js';
import { EventsService } from '../src/events/events.service.js';
import type {
  Prisma,
  WebhookEventStatus,
} from '../src/generated/prisma/client.js';
import { AnswerReader } from '../src/grill/answer-reader.service.js';
import { GrillStore } from '../src/grill/grill.store.js';
import { IntakeService } from '../src/intake/intake.service.js';
import { SessionLeaseService } from '../src/workflow/session-lease.service.js';
import { newDeliveryId, startApp, type TestApp } from './app.js';
import { resetDatabase } from './db.js';
import { testScanner } from './fakes/in-memory-context-loads.js';
import {
  BOT_LOGIN,
  HUMAN,
  TARGET_REPO,
  issueCommentCreated,
  issueCommentDeleted,
  issueCommentEdited,
  type CommentOptions,
  type Delivery,
} from './fixtures/github/payloads.js';
import { fixtureIssueId, seedIssue } from './router-helpers.js';

// Spec 6 "Which comments are answers" (GMW1, GM4, GM12; plan T10): read back from the stored events.

const PARTICIPANT = 'part-user';
const OUTSIDER = 'outsider';
const START = new Date('2026-11-18T10:00:00Z');
const at = (seconds: number) => new Date(START.getTime() + seconds * 1000);
const created = (seconds: number) => at(seconds).toISOString();

describe('AnswerReader.unread (spec 6, T10)', () => {
  let t: TestApp;
  let reader: AnswerReader;
  let issue: TaskRef;
  let sessionId: string;
  const run = { startEventReceivedAt: START };

  /** Stores one delivery on issue 31 (or the payload's issue) as the controller would. */
  async function stored(
    delivery: Delivery,
    receivedAt: Date,
    status: WebhookEventStatus = 'PENDING',
  ): Promise<void> {
    const number = (delivery.payload.issue as { number: number }).number;
    await t.prisma.webhookEvent.create({
      data: {
        deliveryId: newDeliveryId(),
        eventName: delivery.eventName,
        action: delivery.payload.action as string,
        payload: delivery.payload as Prisma.InputJsonValue,
        externalRef: `${TARGET_REPO}#${number}`,
        receivedAt,
        status,
      },
    });
  }
  const comment = (commentId: number, options: CommentOptions = {}) =>
    issueCommentCreated({
      number: 31,
      commentId,
      body: `answer ${commentId}`,
      ...options,
    });
  const lookups = () =>
    t.issues.calls
      .filter(({ method }) => method === 'getAccessLevel')
      .map(({ args }) => args[1]);

  beforeAll(async () => {
    t = await startApp();
    reader = new AnswerReader(
      t.app.get(EventsService),
      t.app.get(IntakeService),
      new GrillStore(t.prisma, t.app.get(SessionLeaseService)),
      testScanner(),
    );
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    issue = seedIssue(t, 31);
    t.issues.setAccessLevel(HUMAN, 'approver');
    t.issues.setAccessLevel(PARTICIPANT, 'participant');
    const task = await t.prisma.task.create({
      data: {
        platform: 'GITHUB',
        platformId: fixtureIssueId(31),
        externalRef: issue.externalRef,
      },
    });
    const runRow = await t.prisma.run.create({
      data: {
        taskId: task.id,
        number: 1,
        lane: 'full-sdd',
        grillSkip: false,
        startEventId: randomUUID(),
        startEventReceivedAt: START,
      },
    });
    const session = await t.prisma.grillSession.create({
      data: { taskId: task.id, runId: runRow.id, status: 'ASKING' },
    });
    sessionId = session.id;
    await t.prisma.grillAnswer.create({
      data: {
        sessionId,
        afterRound: 0,
        commentId: '108',
        author: HUMAN,
        body: 'answer 108',
        createdAt: at(1),
      },
    });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('reads plain comments by people with access, in any event state, unread only, in creation order then by comment id', async () => {
    // Stored out of creation order, so the order comes from the comments' own times.
    await stored(comment(113, { createdAt: created(8) }), at(2), 'FAILED');
    await stored(comment(10, { createdAt: created(9) }), at(3));
    await stored(comment(110, { createdAt: created(5) }), at(4));
    await stored(
      comment(9, { createdAt: created(9), sender: PARTICIPANT }),
      at(5),
    );
    await stored(comment(111, { createdAt: created(6) }), at(6), 'PROCESSING');
    await stored(comment(112, { createdAt: created(7) }), at(7), 'IGNORED');
    // Left out:
    await stored(comment(100, { createdAt: created(-5) }), at(-1), 'DONE'); // before the run
    await stored(comment(101, { body: '/approve' }), at(8));
    await stored(comment(102, { body: '/retry' }), at(8));
    await stored(comment(103, { sender: BOT_LOGIN }), at(8));
    await stored(issueCommentEdited({ number: 31, commentId: 104 }), at(8));
    await stored(issueCommentDeleted({ number: 31, commentId: 105 }), at(8));
    await stored(
      issueCommentCreated({
        number: 32,
        commentId: 106,
        body: 'on another issue',
      }),
      at(8),
    );
    await stored(comment(107, { sender: OUTSIDER }), at(8));
    await stored(comment(108, { createdAt: created(1) }), at(8), 'DONE'); // already read

    const unread = await reader.unread(issue, run, sessionId);

    expect(unread.map(({ commentId }) => commentId)).toEqual([
      '110',
      '111',
      '112',
      '113',
      '9',
      '10',
    ]);
    expect(unread[0]).toEqual({
      commentId: '110',
      author: HUMAN,
      body: 'answer 110',
      url: `https://github.com/${TARGET_REPO}/issues/31#issuecomment-110`,
      createdAt: at(5),
    });
    expect(unread[4]).toMatchObject({ commentId: '9', author: PARTICIPANT });
  });

  it('one access lookup per distinct author per call', async () => {
    await stored(comment(110), at(1));
    await stored(comment(111), at(2));
    await stored(comment(112, { sender: PARTICIPANT }), at(3));
    await stored(comment(113, { sender: OUTSIDER }), at(4));
    await stored(comment(114, { sender: PARTICIPANT }), at(5));

    await reader.unread(issue, run, sessionId);

    expect(lookups().sort()).toEqual([HUMAN, OUTSIDER, PARTICIPANT].sort());
    await reader.unread(issue, run, sessionId);
    expect(lookups()).toHaveLength(6);
  });

  it('with no session nothing counts as read; `before` keeps only the events received before it (the cancel hook)', async () => {
    await stored(comment(108, { createdAt: created(1) }), at(1), 'DONE');
    await stored(comment(110, { createdAt: created(2) }), at(2));
    await stored(comment(111, { createdAt: created(3) }), at(3));

    expect(
      (await reader.unread(issue, run, null)).map(({ commentId }) => commentId),
    ).toEqual(['108', '110', '111']);
    expect(
      (await reader.unread(issue, run, sessionId, at(3))).map(
        ({ commentId }) => commentId,
      ),
    ).toEqual(['110']);
  });
});
