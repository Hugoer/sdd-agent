import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import type { Env } from '../src/config/env.schema.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SessionLeaseService } from '../src/workflow/session-lease.service.js';
import { LeaseLostError } from '../src/workflow/workflow-errors.js';
import { resetDatabase } from './db.js';
import { testEnv } from './test-env.js';

// Spec 5 "Session lease" against PostgreSQL: the claim is one atomic update, times are the database's (plan P7).

const EVENT_A = '00000000-0000-4000-8000-00000000000a';
const EVENT_B = '00000000-0000-4000-8000-00000000000b';

describe('SessionLeaseService (PostgreSQL)', () => {
  let prisma: PrismaService;
  let leases: SessionLeaseService;
  let taskId: string;

  const owner = async () =>
    (
      await prisma.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { leaseOwner: true, leaseExpiresAt: true },
      })
    ).leaseOwner;

  beforeAll(async () => {
    const config = new ConfigService<Env, true>({
      DATABASE_URL: testEnv.DATABASE_URL,
      SESSION_LEASE_SECONDS: 120,
    });
    prisma = new PrismaService(config);
    await prisma.$connect();
    leases = new SessionLeaseService(prisma, config);
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    taskId = (
      await prisma.task.create({
        data: { platform: 'GITHUB', platformId: '1012', externalRef: 'o/r#12' },
      })
    ).id;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('two claims at once for two events → exactly one wins', async () => {
    const results = await Promise.all([
      leases.claim({ taskId, eventId: EVENT_A }),
      leases.claim({ taskId, eventId: EVENT_B }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect([EVENT_A, EVENT_B]).toContain(await owner());
  });

  it('the lease expires SESSION_LEASE_SECONDS after the claim, by the database clock', async () => {
    await leases.claim({ taskId, eventId: EVENT_A });

    const [{ seconds }] = await prisma.$queryRaw<{ seconds: number }[]>`
      SELECT round(extract(epoch FROM lease_expires_at - now()))::int AS seconds FROM tasks WHERE id = ${taskId}::uuid`;
    expect(seconds).toBe(120);
  });

  it('an expired lease is taken by another event; a live one is not', async () => {
    await leases.claim({ taskId, eventId: EVENT_A });
    expect(await leases.claim({ taskId, eventId: EVENT_B })).toBe(false);

    await prisma.$executeRaw`UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id = ${taskId}::uuid`;

    expect(await leases.claim({ taskId, eventId: EVENT_B })).toBe(true);
    expect(await owner()).toBe(EVENT_B);
  });

  it('expiry is PostgreSQL’s now(), never Node’s clock (plan P7)', async () => {
    await prisma.$executeRaw`UPDATE tasks SET lease_owner = ${EVENT_A}::uuid, lease_expires_at = now() + interval '1 hour' WHERE id = ${taskId}::uuid`;
    // Node's clock two hours ahead: compared in Node, the lease would look expired.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 2 * 3_600_000));
    try {
      expect(await leases.claim({ taskId, eventId: EVENT_B })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(await owner()).toBe(EVENT_A);
  });

  it('the same event takes its own lease back at once (a retry after a crash)', async () => {
    await leases.claim({ taskId, eventId: EVENT_A });

    expect(await leases.claim({ taskId, eventId: EVENT_A })).toBe(true);
  });

  it('release by a non-owner changes nothing; by the owner it frees the lease', async () => {
    await leases.claim({ taskId, eventId: EVENT_A });

    await leases.release({ taskId, eventId: EVENT_B });
    expect(await owner()).toBe(EVENT_A);

    await leases.release({ taskId, eventId: EVENT_A });
    expect(await owner()).toBeNull();
    expect(await leases.claim({ taskId, eventId: EVENT_B })).toBe(true);
  });

  it('a renew that finds another owner logs an error and changes nothing', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await leases.claim({ taskId, eventId: EVENT_B });

    expect(await leases.renew({ taskId, eventId: EVENT_A })).toBe(false);
    expect(error).toHaveBeenCalledWith(
      `task ${taskId}: the session lease of event ${EVENT_A} was taken by another event`,
    );
    expect(await owner()).toBe(EVENT_B);
  });

  it('withLease releases after the job; while it runs, another event is refused', async () => {
    const result = await leases.withLease(
      { taskId, eventId: EVENT_A },
      async () => {
        expect(await leases.claim({ taskId, eventId: EVENT_B })).toBe(false);
        return 'done';
      },
    );

    expect(result).toEqual({ claimed: true, value: 'done' });
    expect(await owner()).toBeNull();
  });

  it('assertHeld: the owner passes; another event gets LeaseLostError and the transaction writes nothing', async () => {
    await leases.claim({ taskId, eventId: EVENT_A });

    await expect(
      prisma.$transaction(async (tx) => {
        await leases.assertHeld(tx, { taskId, eventId: EVENT_A });
        await tx.task.update({
          where: { id: taskId },
          data: { status: 'grilling' },
        });
      }),
    ).resolves.toBeUndefined();

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.task.update({
          where: { id: taskId },
          data: { status: 'executing' },
        });
        await leases.assertHeld(tx, { taskId, eventId: EVENT_B });
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(
      (await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status,
    ).toBe('grilling');
  });
});
