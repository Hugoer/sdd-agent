import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EventProcessor } from './event-processor.js';
import { EventsWorker } from './events.worker.js';

const done: EventProcessor = {
  process: () => Promise.resolve({ status: 'DONE' }),
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
