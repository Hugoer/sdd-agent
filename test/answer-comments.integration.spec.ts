import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventsService } from '../src/events/events.service.js';
import type {
  Prisma,
  WebhookEventStatus,
} from '../src/generated/prisma/client.js';
import { newDeliveryId, startApp, type TestApp } from './app.js';
import {
  TARGET_REPO,
  issueCommentCreated,
  issuesLabeled,
  type Delivery,
} from './fixtures/github/payloads.js';

// Spec 6 (GMW1, GM12): an issue's comment events are read back from what was stored, in any state.

describe('EventsService.commentEventsSince', () => {
  let t: TestApp;
  let events: EventsService;
  const since = new Date('2026-11-17T10:00:00Z');
  const at = (seconds: number) => new Date(since.getTime() + seconds * 1000);

  /** Stores one delivery as the controller would, with the given receipt time and state. */
  async function store(
    name: string,
    delivery: Delivery,
    receivedAt: Date,
    status: WebhookEventStatus = 'PENDING',
  ): Promise<[string, string]> {
    const row = await t.prisma.webhookEvent.create({
      data: {
        deliveryId: newDeliveryId(),
        eventName: delivery.eventName,
        action: delivery.payload.action as string,
        payload: delivery.payload as Prisma.InputJsonValue,
        externalRef: `${TARGET_REPO}#${(delivery.payload.issue as { number: number }).number}`,
        receivedAt,
        status,
      },
    });
    return [row.id, name];
  }

  beforeAll(async () => {
    t = await startApp();
    events = t.app.get(EventsService);
  });

  afterAll(async () => {
    await t.app.close();
  });

  it("returns the issue's comment events since the time, in every state, oldest first", async () => {
    // Stored out of order, so the order comes from the query.
    const stored = new Map([
      await store(
        'failed',
        issueCommentCreated({ commentId: 5 }),
        at(3),
        'FAILED',
      ),
      await store('at since', issueCommentCreated({ commentId: 2 }), at(0)),
      await store(
        'before since',
        issueCommentCreated({ commentId: 1 }),
        at(-1),
        'DONE',
      ),
      await store(
        'processing',
        issueCommentCreated({ commentId: 3 }),
        at(1),
        'PROCESSING',
      ),
      await store(
        'ignored',
        issueCommentCreated({ commentId: 4 }),
        at(2),
        'IGNORED',
      ),
      await store(
        'label event',
        issuesLabeled({ label: 'grill: skip' }),
        at(4),
        'DONE',
      ),
      await store('done', issueCommentCreated({ commentId: 6 }), at(5), 'DONE'),
      await store(
        'other issue',
        issueCommentCreated({ commentId: 7, number: 8 }),
        at(6),
      ),
      await store('pending', issueCommentCreated({ commentId: 8 }), at(7)),
    ]);

    const found = await events.commentEventsSince(`${TARGET_REPO}#7`, since);

    expect(found.map((event) => stored.get(event.id))).toEqual([
      'at since',
      'processing',
      'ignored',
      'failed',
      'done',
      'pending',
    ]);
  });

  it('returns nothing for an issue with no comment event', async () => {
    await expect(
      events.commentEventsSince(`${TARGET_REPO}#99`, since),
    ).resolves.toEqual([]);
  });
});
