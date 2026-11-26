import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EventProcessor } from './event-processor.js';
import { EventsWorker } from './events.worker.js';

const done: EventProcessor = {
  process: () => Promise.resolve({ status: 'DONE' }),
  failed: () => Promise.resolve(),
};

/** A worker on a stub database that has no due event. */
function workerWithStubDb() {
  const prisma = {
    webhookEvent: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
  const worker = new EventsWorker(prisma as unknown as PrismaService);
  return { worker, prisma };
}

describe('EventsWorker.registerProcessor (spec 2, AW5)', () => {
  let started: EventsWorker | undefined;
  afterEach(async () => {
    await started?.onModuleDestroy();
    started = undefined;
  });

  it('no registered processor → the app does not start, and the error says why', async () => {
    const { worker, prisma } = workerWithStubDb();

    await expect(worker.onApplicationBootstrap()).rejects.toThrow(
      /no event processor registered.*registerProcessor\(\)/,
    );
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('a second registration is refused; the first one stays', async () => {
    const { worker } = workerWithStubDb();
    worker.registerProcessor(done);

    expect(() => worker.registerProcessor(done)).toThrow(
      /already registered.*exactly one/,
    );
    started = worker;
    await expect(worker.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('with one registered processor it starts: crash reset first', async () => {
    const { worker, prisma } = workerWithStubDb();
    worker.registerProcessor(done);

    started = worker;
    await worker.onApplicationBootstrap();

    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: { status: 'PROCESSING' },
      data: { status: 'PENDING' },
    });
  });
});

describe('EventsWorker startup log (spec 5 matrix "Startup")', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names the registered processor', async () => {
    const log = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    class WorkflowEventProcessor implements EventProcessor {
      process = () => Promise.resolve({ status: 'DONE' as const });
      failed = () => Promise.resolve();
    }
    const { worker } = workerWithStubDb();
    worker.registerProcessor(new WorkflowEventProcessor());

    await worker.onApplicationBootstrap();
    await worker.onModuleDestroy();

    expect(log).toHaveBeenCalledWith('event processor: WorkflowEventProcessor');
  });
});

describe('EventsWorker recovery hook (spec 13 BFW10, plan FP13, FP23)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** A stub database that records the order of the reset and the claims; no event is due. */
  function recording(order: string[]) {
    const prisma = {
      webhookEvent: {
        updateMany: vi.fn(() => {
          order.push('reset');
          return Promise.resolve({ count: 0 });
        }),
        findFirst: vi.fn(() => {
          order.push('claim');
          return Promise.resolve(null);
        }),
      },
    };
    return new EventsWorker(prisma as unknown as PrismaService);
  }

  it('reset → (bootstrap returns) → first tick → the hook → the first claim; the hook once, not on later ticks', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const worker = recording(order);
    let release!: () => void;
    worker.registerProcessor({
      ...done,
      recover: () => {
        order.push('recover');
        return new Promise<void>((resolve) => (release = resolve));
      },
    });

    await worker.onApplicationBootstrap();
    order.push('bootstrap returned');
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['reset', 'bootstrap returned', 'recover']);

    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await worker.onModuleDestroy();
    vi.useRealTimers();

    expect(order.filter((step) => step === 'recover')).toHaveLength(1);
    expect(order.slice(0, 4)).toEqual([
      'reset',
      'bootstrap returned',
      'recover',
      'claim',
    ]);
    expect(order.filter((step) => step === 'claim').length).toBeGreaterThan(1);
  });

  it('a processor without recover starts as before', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const worker = recording(order);
    worker.registerProcessor(done);

    await worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    await worker.onModuleDestroy();
    vi.useRealTimers();

    expect(order).toEqual(['reset', 'claim']);
  });

  it('a throwing hook → one error line, and the worker still claims', async () => {
    vi.useFakeTimers();
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const order: string[] = [];
    const worker = recording(order);
    worker.registerProcessor({
      ...done,
      recover: () => Promise.reject(new Error('GitHub down')),
    });

    await worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    await worker.onModuleDestroy();
    vi.useRealTimers();

    expect(error.mock.calls.map(([line]) => String(line))).toEqual([
      'recovery hook failed, the worker starts anyway: GitHub down',
    ]);
    expect(order).toEqual(['reset', 'claim']);
  });
});
