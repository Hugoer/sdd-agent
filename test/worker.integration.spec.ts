import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { LlmError, StepConfigError } from '../src/contracts/llm-error.js';
import { ProviderError } from '../src/contracts/provider-error.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { resetDatabase } from './db.js';
import {
  ScriptedProcessor,
  newDeliveryId,
  postWebhook,
  startApp,
  waitFor,
  type TestApp,
} from './app.js';

// The worker's rules (spec 1, spec 3) with a scripted processor (spec 2, plan P3): nothing here
// depends on what the app's own processor decides.

type EventInput = Partial<Prisma.WebhookEventCreateInput>;

const unavailable = (message = 'GitHub POST … → 503: Unavailable') =>
  new ProviderError(message, 'transient', { status: 503 });

describe('EventsWorker (manual drain)', () => {
  let t: TestApp;
  let processor: ScriptedProcessor;

  /** Inserts an event row directly (default: a due, PENDING issues.opened). */
  function insertEvent(data: EventInput = {}) {
    return t.prisma.webhookEvent.create({
      data: {
        deliveryId: newDeliveryId(),
        eventName: 'issues',
        action: 'opened',
        payload: { action: 'opened' },
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
    processor = new ScriptedProcessor();
    t = await startApp({ processor });
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    processor.processed.length = 0;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await t.app.close();
  });

  it('DONE from the processor → row DONE, attempts 1, processedAt set', async () => {
    const event = await insertEvent();

    expect(await t.worker.drainOnce()).toBe(1);

    expect(processor.processed).toEqual([event.deliveryId]);
    expect(await row(event.id)).toMatchObject({
      status: 'DONE',
      attempts: 1,
      ignoreReason: null,
      processedAt: expect.any(Date) as Date,
    });
  });

  it('IGNORED from the processor → row IGNORED with its reason', async () => {
    const event = await insertEvent();
    processor.ignoreNext('some-reason');

    await t.worker.drainOnce();

    expect(await row(event.id)).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'some-reason',
      attempts: 1,
      processedAt: expect.any(Date) as Date,
    });
  });

  it('the processor gets the claimed row as stored', async () => {
    const event = await insertEvent({ payload: { action: 'opened', x: 1 } });
    let seen: unknown;
    processor.then((claimed) => {
      seen = claimed;
      return Promise.resolve({ status: 'DONE' });
    });

    await t.worker.drainOnce();

    expect(seen).toEqual({ ...event, status: 'PROCESSING', attempts: 1 });
  });

  it('claims the oldest received first and skips events not yet due', async () => {
    const base = Date.now() - 60_000;
    const second = await insertEvent({ receivedAt: new Date(base + 2_000) });
    const first = await insertEvent({ receivedAt: new Date(base + 1_000) });
    const notDue = await insertEvent({
      receivedAt: new Date(base),
      availableAt: new Date(Date.now() + 60_000),
    });

    expect(await t.worker.drainOnce()).toBe(2);

    expect(processor.processed).toEqual([first.deliveryId, second.deliveryId]);
    expect(await row(notDue.id)).toMatchObject({
      status: 'PENDING',
      attempts: 0,
    });
  });

  it('retries after 5 s then 30 s, then FAILED with lastError; the next event still runs', async () => {
    const event = await insertEvent();

    processor.failNext(unavailable());
    let before = Date.now();
    await t.worker.drainOnce();
    let r = await row(event.id);
    expect(r).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'GitHub POST … → 503: Unavailable',
    });
    expect(r.availableAt.getTime() - before).toBeGreaterThanOrEqual(5_000);
    expect(r.availableAt.getTime() - before).toBeLessThan(6_000);
    expect(await t.worker.drainOnce()).toBe(0); // backing off: not due yet

    await makeDue(event.id);
    processor.failNext(unavailable());
    before = Date.now();
    await t.worker.drainOnce();
    r = await row(event.id);
    expect(r).toMatchObject({ status: 'PENDING', attempts: 2 });
    expect(r.availableAt.getTime() - before).toBeGreaterThanOrEqual(30_000);
    expect(r.availableAt.getTime() - before).toBeLessThan(31_000);

    await makeDue(event.id);
    processor.failNext(unavailable());
    await t.worker.drainOnce();
    expect(await row(event.id)).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      lastError: 'GitHub POST … → 503: Unavailable',
      processedAt: expect.any(Date) as Date,
    });

    const next = await insertEvent();
    await t.worker.drainOnce();
    expect(await row(next.id)).toMatchObject({ status: 'DONE' });
  });

  it('a permanent error → FAILED after the first attempt; the next event still runs', async () => {
    const event = await insertEvent();
    processor.failNext(
      new ProviderError('GitHub POST … → 404: Not Found', 'permanent', {
        status: 404,
      }),
    );

    await t.worker.drainOnce();

    expect(await row(event.id)).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'GitHub POST … → 404: Not Found',
      processedAt: expect.any(Date) as Date,
    });
    const next = await insertEvent();
    await t.worker.drainOnce();
    expect(await row(next.id)).toMatchObject({ status: 'DONE' });
  });

  it('any other error keeps the retries: PENDING, next attempt in 5 s', async () => {
    processor.failNext(new Error('something odd'));
    const event = await insertEvent();

    const before = Date.now();
    await t.worker.drainOnce();

    const r = await row(event.id);
    expect(r).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'something odd',
    });
    expect(r.availableAt.getTime() - before).toBeGreaterThanOrEqual(5_000);
    expect(r.availableAt.getTime() - before).toBeLessThan(6_000);
  });

  it.each([
    [120, 120_000],
    [1, 5_000],
  ])(
    'retryAfterSeconds %i → the next attempt is due %i ms later (never sooner than the backoff)',
    async (retryAfterSeconds, waitMs) => {
      const event = await insertEvent();
      processor.failNext(
        new ProviderError('GitHub POST … → 429: rate limited', 'transient', {
          status: 429,
          retryAfterSeconds,
        }),
      );

      const before = Date.now();
      await t.worker.drainOnce();

      const r = await row(event.id);
      expect(r).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(r.availableAt.getTime() - before).toBeGreaterThanOrEqual(waitMs);
      expect(r.availableAt.getTime() - before).toBeLessThan(waitMs + 1_000);
    },
  );

  it('a transient LlmError: 3 attempts, 5 s then 30 s and at least retryAfterSeconds, then FAILED (spec 4)', async () => {
    const event = await insertEvent();
    const rateLimited = () =>
      new LlmError(
        'Google rate-limited model `m` (HTTP 429, RESOURCE_EXHAUSTED)',
        'transient',
        'rate-limited',
        { retryAfterSeconds: 60 },
      );
    const down = () =>
      new LlmError(
        'Google could not serve model `m` (HTTP 503, UNAVAILABLE)',
        'transient',
        'provider-unavailable',
      );

    processor.failNext(rateLimited());
    let before = Date.now();
    await t.worker.drainOnce();
    let r = await row(event.id);
    expect(r).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(r.availableAt.getTime() - before).toBeGreaterThanOrEqual(60_000);
    expect(r.availableAt.getTime() - before).toBeLessThan(61_000);

    await makeDue(event.id);
    processor.failNext(down());
    before = Date.now();
    await t.worker.drainOnce();
    r = await row(event.id);
    expect(r).toMatchObject({ status: 'PENDING', attempts: 2 });
    expect(r.availableAt.getTime() - before).toBeGreaterThanOrEqual(30_000);
    expect(r.availableAt.getTime() - before).toBeLessThan(31_000);

    await makeDue(event.id);
    processor.failNext(down());
    await t.worker.drainOnce();
    expect(await row(event.id)).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      lastError: 'Google could not serve model `m` (HTTP 503, UNAVAILABLE)',
    });
  });

  it('a transient LlmError without a delay → next attempt in 5 s', async () => {
    const event = await insertEvent();
    processor.failNext(
      new LlmError('no answer in time', 'transient', 'provider-unavailable'),
    );

    const before = Date.now();
    await t.worker.drainOnce();

    const r = await row(event.id);
    expect(r).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(r.availableAt.getTime() - before).toBeGreaterThanOrEqual(5_000);
    expect(r.availableAt.getTime() - before).toBeLessThan(6_000);
  });

  it.each<[string, Error]>([
    [
      'a permanent LlmError',
      new LlmError(
        'Google refused the key (HTTP 400, INVALID_ARGUMENT, API_KEY_INVALID): check GOOGLE_API_KEY',
        'permanent',
        'bad-api-key',
      ),
    ],
    ['a StepConfigError', new StepConfigError('missing skills: plan, code')],
  ])(
    '%s → FAILED after the first attempt, its message in lastError (spec 4)',
    async (_name, error) => {
      const event = await insertEvent();
      processor.failNext(error);

      await t.worker.drainOnce();

      expect(await row(event.id)).toMatchObject({
        status: 'FAILED',
        attempts: 1,
        lastError: error.message,
        processedAt: expect.any(Date) as Date,
      });
    },
  );

  it('truncates lastError to 2,000 characters', async () => {
    processor.failNext(unavailable('e'.repeat(5_000)));
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
    expect([...processor.processed].sort()).toEqual(
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

    const restarted = await startApp({
      keepData: true,
      processor: new ScriptedProcessor(),
    });
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
    vi.restoreAllMocks();
    await t?.app.close();
    t = undefined;
  });

  it('a signed webhook is processed once and its row ends DONE', async () => {
    const processor = new ScriptedProcessor();
    t = await startApp({ pollingWorker: true, processor });
    const app = t;
    const deliveryId = newDeliveryId();

    const res = await postWebhook(app.baseUrl, '{"action":"opened"}', {
      'x-github-event': 'issues',
      'x-github-delivery': deliveryId,
    });
    expect(res.status).toBe(202);

    const done = await waitFor(() =>
      app.prisma.webhookEvent.findFirst({
        where: { deliveryId, status: 'DONE' },
      }),
    );
    expect(done.attempts).toBe(1);
    expect(processor.processed).toEqual([deliveryId]);
  });

  it('on shutdown, finishes the event in progress before Prisma disconnects', async () => {
    let release!: () => void;
    let started!: () => void;
    const inProgress = new Promise<void>((resolve) => (started = resolve));
    // The processor hangs until released.
    const processor = new ScriptedProcessor().then(() => {
      started();
      return new Promise((resolve) => {
        release = () => resolve({ status: 'DONE' });
      });
    });
    t = await startApp({ pollingWorker: true, processor });
    const app = t;
    const event = await app.prisma.webhookEvent.create({
      data: {
        deliveryId: newDeliveryId(),
        eventName: 'issues',
        action: 'opened',
        payload: { action: 'opened' },
      },
    });
    await inProgress;

    const closing = app.app.close();
    t = undefined;
    setTimeout(() => release(), 200);
    await closing;

    const check = await startApp({
      keepData: true,
      processor: new ScriptedProcessor(),
    });
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
