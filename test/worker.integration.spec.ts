import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { Prisma } from '../src/generated/prisma/client.js';
import { resetDatabase } from './db.js';
import {
  issuesOpenedPayload,
  newDeliveryId,
  postWebhook,
  startApp,
  waitFor,
  type TestApp,
} from './app.js';

type EventInput = Partial<Prisma.WebhookEventCreateInput>;

describe('EventsWorker (manual drain)', () => {
  let t: TestApp;

  /** Inserts an event row directly (default: a due, PENDING issues.opened). */
  function insertEvent(data: EventInput = {}) {
    return t.prisma.webhookEvent.create({
      data: {
        deliveryId: newDeliveryId(),
        eventName: 'issues',
        action: 'opened',
        payload: issuesOpenedPayload(),
        ...data,
      },
    });
  }
  const row = (id: string) =>
    t.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
  /** Makes a backed-off event due now. */
  const makeDue = (id: string) =>
    t.prisma.webhookEvent.update({
      where: { id },
      data: { availableAt: new Date(Date.now() - 1) },
    });

  beforeAll(async () => {
    t = await startApp();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    t.hello.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('issues.opened → one hello naming the delivery, DONE, attempts 1', async () => {
    const event = await insertEvent();

    expect(await t.worker.drainOnce()).toBe(1);

    expect(t.hello.calls).toEqual([
      {
        installationId: 42,
        owner: 'octo',
        repo: 'sdd-agent-sandbox',
        issueNumber: 7,
        deliveryId: event.deliveryId,
      },
    ]);
    expect(await row(event.id)).toMatchObject({
      status: 'DONE',
      attempts: 1,
      ignoreReason: null,
      processedAt: expect.any(Date) as Date,
    });
  });

  it.each([
    ['ping', null, { zen: 'x' }, 'ping'],
    ['issues', 'opened', issuesOpenedPayload(null), 'no-installation'],
    ['issue_comment', 'created', { action: 'created' }, 'not-handled'],
    ['issues', 'labeled', { action: 'labeled' }, 'not-handled'],
  ])(
    '%s.%s → IGNORED %s… nothing posted',
    async (eventName, action, payload, reason) => {
      const event = await insertEvent({ eventName, action, payload });

      await t.worker.drainOnce();

      expect(t.hello.calls).toEqual([]);
      expect(await row(event.id)).toMatchObject({
        status: 'IGNORED',
        ignoreReason: reason,
        attempts: 1,
        processedAt: expect.any(Date) as Date,
      });
    },
  );

  it('claims the oldest received first and skips events not yet due', async () => {
    const base = Date.now() - 60_000;
    const second = await insertEvent({ receivedAt: new Date(base + 2_000) });
    const first = await insertEvent({ receivedAt: new Date(base + 1_000) });
    const notDue = await insertEvent({
      receivedAt: new Date(base),
      availableAt: new Date(Date.now() + 60_000),
    });

    expect(await t.worker.drainOnce()).toBe(2);

    expect(t.hello.calls.map((c) => c.deliveryId)).toEqual([
      first.deliveryId,
      second.deliveryId,
    ]);
    expect(await row(notDue.id)).toMatchObject({
      status: 'PENDING',
      attempts: 0,
    });
  });

  it('retries after 5 s then 30 s, then FAILED with lastError; the next event still runs', async () => {
    t.hello.behavior = () => Promise.reject(new Error('Bad credentials'));
    const event = await insertEvent();

    let before = Date.now();
    await t.worker.drainOnce();
    let r = await row(event.id);
    expect(r).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'Bad credentials',
    });
    expect(r.availableAt.getTime() - before).toBeGreaterThanOrEqual(5_000);
    expect(r.availableAt.getTime() - before).toBeLessThan(6_000);
    expect(await t.worker.drainOnce()).toBe(0); // backing off: not due yet

    await makeDue(event.id);
    before = Date.now();
    await t.worker.drainOnce();
    r = await row(event.id);
    expect(r).toMatchObject({ status: 'PENDING', attempts: 2 });
    expect(r.availableAt.getTime() - before).toBeGreaterThanOrEqual(30_000);
    expect(r.availableAt.getTime() - before).toBeLessThan(31_000);

    await makeDue(event.id);
    await t.worker.drainOnce();
    expect(await row(event.id)).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      lastError: 'Bad credentials',
      processedAt: expect.any(Date) as Date,
    });

    t.hello.reset();
    const next = await insertEvent();
    await t.worker.drainOnce();
    expect(await row(next.id)).toMatchObject({ status: 'DONE' });
  });

  it('truncates lastError to 2,000 characters', async () => {
    t.hello.behavior = () => Promise.reject(new Error('e'.repeat(5_000)));
    const event = await insertEvent();

    await t.worker.drainOnce();

    expect((await row(event.id)).lastError).toHaveLength(2_000);
  });

  it('two concurrent drains process each event exactly once', async () => {
    const events = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        insertEvent({ receivedAt: new Date(Date.now() - 10_000 + i) }),
      ),
    );

    const [a, b] = await Promise.all([
      t.worker.drainOnce(),
      t.worker.drainOnce(),
    ]);

    expect(a + b).toBe(8);
    expect(t.hello.calls.map((c) => c.deliveryId).sort()).toEqual(
      events.map((e) => e.deliveryId).sort(),
    );
    const rows = await t.prisma.webhookEvent.findMany();
    expect(rows.every((r) => r.status === 'DONE' && r.attempts === 1)).toBe(
      true,
    );
  });

  it('startup resets PROCESSING rows to PENDING (left over from a crash)', async () => {
    const interrupted = await insertEvent({
      status: 'PROCESSING',
      attempts: 1,
    });

    const restarted = await startApp({ keepData: true });
    try {
      expect(await row(interrupted.id)).toMatchObject({
        status: 'PENDING',
        attempts: 1,
      });
      await restarted.worker.drainOnce();
      expect(await row(interrupted.id)).toMatchObject({
        status: 'DONE',
        attempts: 2,
      });
    } finally {
      await restarted.app.close();
    }
  });
});

describe('EventsWorker (polling loop)', () => {
  let t: TestApp | undefined;

  afterEach(async () => {
    await t?.app.close();
    t = undefined;
  });

  it('a signed issues.opened webhook becomes one hello and a DONE row', async () => {
    t = await startApp({ pollingWorker: true });
    const app = t;
    const deliveryId = newDeliveryId();

    const res = await postWebhook(
      app.baseUrl,
      JSON.stringify(issuesOpenedPayload()),
      {
        'x-github-event': 'issues',
        'x-github-delivery': deliveryId,
      },
    );
    expect(res.status).toBe(202);

    const done = await waitFor(() =>
      app.prisma.webhookEvent.findFirst({
        where: { deliveryId, status: 'DONE' },
      }),
    );
    expect(done.attempts).toBe(1);
    expect(app.hello.calls.map((c) => c.deliveryId)).toEqual([deliveryId]);
  });

  it('on shutdown, finishes the event in progress before Prisma disconnects', async () => {
    t = await startApp({ pollingWorker: true });
    const app = t;
    let release!: () => void;
    let started!: () => void;
    const inProgress = new Promise<void>((resolve) => (started = resolve));
    app.hello.behavior = () => {
      started();
      return new Promise<void>((resolve) => (release = resolve));
    };
    const event = await app.prisma.webhookEvent.create({
      data: {
        deliveryId: newDeliveryId(),
        eventName: 'issues',
        action: 'opened',
        payload: issuesOpenedPayload(),
      },
    });
    await inProgress;

    const closing = app.app.close();
    t = undefined;
    setTimeout(() => release(), 200);
    await closing;

    const check = await startApp({ keepData: true });
    try {
      expect(
        await check.prisma.webhookEvent.findUniqueOrThrow({
          where: { id: event.id },
        }),
      ).toMatchObject({ status: 'DONE', attempts: 1 });
    } finally {
      await check.app.close();
    }
  });
});
