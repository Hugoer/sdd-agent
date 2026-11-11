import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventsService } from '../src/events/events.service.js';
import { externalRefOf } from '../src/events/external-ref.js';
import { resetDatabase } from './db.js';
import {
  newDeliveryId,
  postWebhook,
  sign,
  startApp,
  type TestApp,
} from './app.js';

describe('POST /webhooks/github', () => {
  let t: TestApp;
  const rowCount = () => t.prisma.webhookEvent.count();

  beforeAll(async () => {
    t = await startApp();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('401 and nothing stored without a signature', async () => {
    const res = await postWebhook(t.baseUrl, '{"zen":"x"}', {
      'x-hub-signature-256': undefined,
    });
    expect(res.status).toBe(401);
    expect(await rowCount()).toBe(0);
  });

  it('401 and nothing stored when the body changed after signing', async () => {
    const res = await postWebhook(t.baseUrl, '{"zen":"y"}', {
      'x-hub-signature-256': sign('{"zen":"x"}'),
    });
    expect(res.status).toBe(401);
    expect(await rowCount()).toBe(0);
  });

  it.each(['x-github-delivery', 'x-github-event'])(
    '400 and nothing stored without %s',
    async (header) => {
      const res = await postWebhook(t.baseUrl, '{"zen":"x"}', {
        [header]: undefined,
      });
      expect(res.status).toBe(400);
      expect(await rowCount()).toBe(0);
    },
  );

  it('400 and nothing stored for invalid JSON (body parser runs first)', async () => {
    const res = await postWebhook(t.baseUrl, '{not json');
    expect(res.status).toBe(400);
    expect(await rowCount()).toBe(0);
  });

  it('202 with an empty body and one PENDING row for a new delivery', async () => {
    const deliveryId = newDeliveryId();
    const payload = { action: 'opened', issue: { number: 7 } };
    const res = await postWebhook(t.baseUrl, JSON.stringify(payload), {
      'x-github-event': 'issues',
      'x-github-delivery': deliveryId,
    });

    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
    const rows = await t.prisma.webhookEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deliveryId,
      eventName: 'issues',
      action: 'opened',
      payload,
      status: 'PENDING',
      attempts: 0,
      externalRef: null, // this payload has no repository
    });
  });

  it('stores the issue reference of an event (external_ref)', async () => {
    const deliveryId = newDeliveryId();
    const payload = {
      action: 'created',
      repository: { full_name: 'Octo/Sandbox' },
      issue: { id: 1012, number: 12 },
      comment: { id: 5 },
    };
    const res = await postWebhook(t.baseUrl, JSON.stringify(payload), {
      'x-github-event': 'issue_comment',
      'x-github-delivery': deliveryId,
    });

    expect(res.status).toBe(202);
    const row = await t.prisma.webhookEvent.findUniqueOrThrow({
      where: { deliveryId },
    });
    expect(row.externalRef).toBe('Octo/Sandbox#12');
  });

  it('a payload without an issue or PR is stored with no reference and still answers 202', async () => {
    const deliveryId = newDeliveryId();
    const res = await postWebhook(
      t.baseUrl,
      JSON.stringify({ action: 'created', repository: { full_name: 'a/b' } }),
      { 'x-github-event': 'installation', 'x-github-delivery': deliveryId },
    );

    expect(res.status).toBe(202);
    const row = await t.prisma.webhookEvent.findUniqueOrThrow({
      where: { deliveryId },
    });
    expect(row.externalRef).toBeNull();
  });

  it('202 for a redelivery, leaving the first row unchanged', async () => {
    const deliveryId = newDeliveryId();
    await postWebhook(t.baseUrl, '{"zen":"first"}', {
      'x-github-delivery': deliveryId,
    });
    const first = await t.prisma.webhookEvent.findUniqueOrThrow({
      where: { deliveryId },
    });

    const res = await postWebhook(t.baseUrl, '{"zen":"second"}', {
      'x-github-delivery': deliveryId,
      'x-github-event': 'issues',
    });

    expect(res.status).toBe(202);
    expect(await t.prisma.webhookEvent.findMany()).toEqual([first]);
  });

  describe('redelivery of a stored delivery (spec 2, IA13)', () => {
    const payload = {
      action: 'opened',
      repository: { full_name: 'Octo/Sandbox' },
      issue: { id: 1012, number: 12 },
    };
    const body = JSON.stringify(payload);
    const old = new Date('2026-01-01T00:00:00Z');

    /** Stores the delivery, then forces its row into `status` as the worker would leave it. */
    async function storedAs(
      status: 'PENDING' | 'PROCESSING' | 'DONE' | 'IGNORED' | 'FAILED',
    ) {
      const deliveryId = newDeliveryId();
      await postWebhook(t.baseUrl, body, {
        'x-github-event': 'issues',
        'x-github-delivery': deliveryId,
      });
      return t.prisma.webhookEvent.update({
        where: { deliveryId },
        data: {
          status,
          attempts: status === 'PENDING' ? 0 : 3,
          availableAt: old,
          lastError: status === 'FAILED' ? 'GitHub → 503: Unavailable' : null,
          ignoreReason: status === 'IGNORED' ? 'ping' : null,
          processedAt: status === 'PENDING' ? null : old,
        },
      });
    }
    const redeliver = (deliveryId: string, redeliveredBody = body) =>
      postWebhook(t.baseUrl, redeliveredBody, {
        'x-github-event': 'issues',
        'x-github-delivery': deliveryId,
      });

    it('a FAILED row goes back to PENDING; payload, receivedAt, externalRef and lastError are kept', async () => {
      const failed = await storedAs('FAILED');
      const before = Date.now();

      const res = await redeliver(failed.deliveryId, '{"zen":"other body"}');

      expect(res.status).toBe(202);
      const rows = await t.prisma.webhookEvent.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        ...failed,
        status: 'PENDING',
        attempts: 0,
        availableAt: expect.any(Date) as Date,
        processedAt: null,
      });
      expect(rows[0].availableAt.getTime()).toBeGreaterThanOrEqual(
        before - 1_000,
      );
      expect(rows[0].externalRef).toBe('Octo/Sandbox#12');
    });

    it('the worker then processes the re-queued row once', async () => {
      const failed = await storedAs('FAILED');
      await t.prisma.webhookEvent.update({
        where: { id: failed.id },
        data: { eventName: 'ping' }, // decided without GitHub
      });

      await redeliver(failed.deliveryId);

      expect(await t.worker.drainOnce()).toBe(1);
      expect(await t.worker.drainOnce()).toBe(0);
      const row = await t.prisma.webhookEvent.findUniqueOrThrow({
        where: { id: failed.id },
      });
      expect(row).toMatchObject({ status: 'IGNORED', attempts: 1 });
    });

    it('two redeliveries at the same time queue it once', async () => {
      const failed = await storedAs('FAILED');
      const events = t.app.get(EventsService);
      const input = {
        deliveryId: failed.deliveryId,
        eventName: 'issues',
        payload,
      };

      const results = await Promise.all([
        events.enqueue(input),
        events.enqueue(input),
        events.enqueue(input),
      ]);

      expect(results.filter((r) => r.requeued)).toHaveLength(1);
      expect(results.every((r) => r.duplicate)).toBe(true);
      expect(await t.prisma.webhookEvent.count()).toBe(1);
    });

    it('two redeliveries at the same time through the controller → 202 each, one row', async () => {
      const failed = await storedAs('FAILED');

      const responses = await Promise.all([
        redeliver(failed.deliveryId),
        redeliver(failed.deliveryId),
      ]);

      expect(responses.map((r) => r.status)).toEqual([202, 202]);
      const rows = await t.prisma.webhookEvent.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'PENDING', attempts: 0 });
    });

    it.each(['PENDING', 'PROCESSING', 'DONE', 'IGNORED'] as const)(
      'a %s row is left untouched',
      async (status) => {
        const stored = await storedAs(status);

        const res = await redeliver(stored.deliveryId);
        const result = await t.app.get(EventsService).enqueue({
          deliveryId: stored.deliveryId,
          eventName: 'issues',
          payload,
        });

        expect(res.status).toBe(202);
        expect(result).toEqual({ duplicate: true, requeued: false });
        expect(await t.prisma.webhookEvent.findMany()).toEqual([stored]);
      },
    );

    it('a new delivery → stored, neither duplicate nor requeued', async () => {
      const result = await t.app.get(EventsService).enqueue({
        deliveryId: newDeliveryId(),
        eventName: 'issues',
        payload,
      });
      expect(result).toEqual({ duplicate: false, requeued: false });
    });
  });

  it('accepts a signed ~5 MB payload (above the 100 kB Express default)', async () => {
    const body = JSON.stringify({ zen: 'x'.repeat(5 * 1024 * 1024) });
    const res = await postWebhook(t.baseUrl, body);
    expect(res.status).toBe(202);
    expect(await rowCount()).toBe(1);
  });
});

/** Plan P7: the migration's back-fill gives old rows the same reference as externalRefOf(). */
describe('external_ref back-fill (migration webhook_event_external_ref)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  function backfillStatement(): string {
    const dir = readdirSync('prisma/migrations').find((name) =>
      name.endsWith('_webhook_event_external_ref'),
    );
    if (!dir) throw new Error('migration webhook_event_external_ref not found');
    const sql = readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8');
    const start = sql.indexOf('WITH "candidates"');
    if (start < 0) throw new Error('back-fill statement not found');
    return sql.slice(start);
  }

  const repository = { full_name: 'Octo/Sandbox' };
  const payloads: unknown[] = [
    { action: 'opened', repository, issue: { id: 1, number: 12 } },
    { action: 'created', repository, issue: { number: 15, pull_request: {} } },
    { action: 'opened', repository, pull_request: { number: 16 } },
    {
      action: 'opened',
      repository,
      issue: { number: 3 },
      pull_request: { number: 4 },
    },
    { zen: 'x', repository },
    { action: 'created', repository },
    { issue: { number: 1 } },
    { repository: { full_name: 7 }, issue: { number: 1 } },
    { repository: { full_name: '' }, issue: { number: 1 } },
    { repository: 'x', issue: { number: 1 } },
    { repository, issue: { id: 1 } },
    { repository, issue: { number: '1' } },
    { repository, issue: { number: 1.5 } },
    { repository, issue: { number: 7.0 } },
    { repository, issue: { number: 0 } },
    { repository, issue: { number: -2 } },
    { repository, issue: { number: 1e20 } },
    { repository, issue: { number: 'x' }, pull_request: { number: 4 } },
    { repository, issue: null, pull_request: { number: 5 } },
    { repository, issue: [1] },
    [1, 2],
  ];

  it('writes the same value as externalRefOf for every row stored before it', async () => {
    await resetDatabase(t.prisma);
    for (const [i, payload] of payloads.entries()) {
      await t.prisma.webhookEvent.create({
        data: {
          deliveryId: `backfill-${i}`,
          eventName: 'issues',
          payload: payload as object,
        },
      });
    }

    await t.prisma.$executeRawUnsafe(backfillStatement());

    const rows = await t.prisma.webhookEvent.findMany();
    expect(rows).toHaveLength(payloads.length);
    for (const row of rows) {
      expect({ payload: row.payload, ref: row.externalRef }).toEqual({
        payload: row.payload,
        ref: externalRefOf(row.payload),
      });
    }
    // Not every row is null: the rule really ran.
    expect(rows.filter((row) => row.externalRef !== null)).toHaveLength(6);
  });
});
