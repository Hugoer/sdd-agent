import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
    });
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

  it('accepts a signed ~5 MB payload (above the 100 kB Express default)', async () => {
    const body = JSON.stringify({ zen: 'x'.repeat(5 * 1024 * 1024) });
    const res = await postWebhook(t.baseUrl, body);
    expect(res.status).toBe(202);
    expect(await rowCount()).toBe(1);
  });
});
