import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from './db.js';
import { newDeliveryId, postWebhook, startApp, type TestApp } from './app.js';
import {
  HUMAN,
  TARGET_REPO,
  issuesOpened,
  ping,
  type Delivery,
} from './fixtures/github/payloads.js';

// Spec 2: signed requests through the controller, the real worker drain, the fake provider.

describe('intake (signed webhooks → rows)', () => {
  let t: TestApp;

  /** Posts a signed delivery, drains the worker once, returns its row. */
  async function deliver(
    delivery: Delivery | { eventName: string; body: string },
  ) {
    const deliveryId = newDeliveryId();
    const body =
      'body' in delivery ? delivery.body : JSON.stringify(delivery.payload);
    const res = await postWebhook(t.baseUrl, body, {
      'x-github-event': delivery.eventName,
      'x-github-delivery': deliveryId,
    });
    expect(res.status).toBe(202);
    await t.worker.drainOnce();
    return t.prisma.webhookEvent.findUniqueOrThrow({ where: { deliveryId } });
  }

  beforeAll(async () => {
    t = await startApp();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.issues.calls.length = 0;
    t.issues.setAccessLevel(HUMAN, 'none');
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('issues.opened from an Approver → DONE, no comment, one lookup', async () => {
    t.issues.setAccessLevel(HUMAN, 'approver');

    const row = await deliver(issuesOpened({ number: 12 }));

    expect(row).toMatchObject({
      status: 'DONE',
      ignoreReason: null,
      attempts: 1,
      externalRef: `${TARGET_REPO}#12`,
    });
    expect(t.issues.calls.map((call) => call.method)).toEqual([
      'getAccessLevel',
    ]);
  });

  it('issues.opened from a Participant → DONE', async () => {
    t.issues.setAccessLevel(HUMAN, 'participant');
    expect(await deliver(issuesOpened())).toMatchObject({ status: 'DONE' });
  });

  it('issues.opened from a sender with no access → IGNORED unauthorized, nothing posted', async () => {
    const row = await deliver(issuesOpened({ sender: 'octocat' }));

    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'unauthorized',
    });
    expect(t.issues.calls.map((call) => call.method)).toEqual([
      'getAccessLevel',
    ]);
  });

  it('another repo → IGNORED other-repo with zero provider calls', async () => {
    const row = await deliver(issuesOpened({ repo: 'someone/other-repo' }));

    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'other-repo',
      externalRef: 'someone/other-repo#7',
    });
    expect(t.issues.calls).toEqual([]);
  });

  it('a body without sender → IGNORED invalid-payload after one attempt', async () => {
    const row = await deliver({
      eventName: 'issues',
      body: JSON.stringify({
        action: 'opened',
        repository: { full_name: TARGET_REPO },
        issue: { id: 1, number: 7 },
      }),
    });

    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'invalid-payload',
      attempts: 1,
    });
    expect(t.issues.calls).toEqual([]);
  });

  it('only {"action":"opened"} → IGNORED invalid-payload, stored with no reference', async () => {
    const row = await deliver({
      eventName: 'issues',
      body: '{"action":"opened"}',
    });

    expect(row).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'invalid-payload',
      attempts: 1,
      externalRef: null,
    });
  });

  it('ping → IGNORED ping', async () => {
    expect(await deliver(ping())).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'ping',
    });
    expect(t.issues.calls).toEqual([]);
  });

  it('an event the bot does not use → IGNORED unsupported-event', async () => {
    expect(
      await deliver({
        eventName: 'installation',
        body: '{"action":"created"}',
      }),
    ).toMatchObject({ status: 'IGNORED', ignoreReason: 'unsupported-event' });
  });
});
