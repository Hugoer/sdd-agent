import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { SessionLeaseService } from './session-lease.service.js';

const lease = { taskId: 'task-1', eventId: 'event-1' };

/** A lease service on a stub database: every update matches one row. */
function service(seconds = 120) {
  const executeRaw = vi.fn().mockResolvedValue(1);
  const prisma = { $executeRaw: executeRaw } as unknown as PrismaService;
  const config = new ConfigService<Env, true>({
    SESSION_LEASE_SECONDS: seconds,
  });
  return { leases: new SessionLeaseService(prisma, config), executeRaw };
}

/** The SQL text of each call, to tell claim, renew and release apart. */
const statements = (executeRaw: ReturnType<typeof vi.fn>) =>
  executeRaw.mock.calls.map(([sql]) =>
    (sql as TemplateStringsArray).join('?').replace(/\s+/g, ' ').trim(),
  );
const renewals = (executeRaw: ReturnType<typeof vi.fn>) =>
  statements(executeRaw).filter((sql) =>
    sql.startsWith('UPDATE tasks SET lease_expires_at'),
  ).length;

describe('SessionLeaseService heartbeat (spec "Session lease")', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renews every third of the lease while the job runs, then stops and releases', async () => {
    const { leases, executeRaw } = service(120);
    let finish!: () => void;
    const job = new Promise<void>((resolve) => (finish = resolve));

    const running = leases.withLease(lease, () => job);
    await vi.advanceTimersByTimeAsync(39_999);
    expect(renewals(executeRaw)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(renewals(executeRaw)).toBe(1);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(renewals(executeRaw)).toBe(3);

    finish();
    await expect(running).resolves.toEqual({
      claimed: true,
      value: undefined,
    });
    await vi.advanceTimersByTimeAsync(200_000);
    expect(renewals(executeRaw)).toBe(3);
    expect(statements(executeRaw).at(-1)).toMatch(
      /^UPDATE tasks SET lease_owner = NULL/,
    );
  });

  it('stops and releases also when the job throws', async () => {
    const { leases, executeRaw } = service(30);
    let fail!: (error: Error) => void;
    const job = new Promise<void>((_, reject) => (fail = reject));

    const running = leases.withLease(lease, () => job);
    await vi.advanceTimersByTimeAsync(10_000);
    fail(new Error('step broke'));
    await expect(running).rejects.toThrow('step broke');
    await vi.advanceTimersByTimeAsync(100_000);

    expect(renewals(executeRaw)).toBe(1);
    expect(statements(executeRaw).at(-1)).toMatch(
      /^UPDATE tasks SET lease_owner = NULL/,
    );
  });

  it('a lease held by another event: the job never runs', async () => {
    const { leases, executeRaw } = service();
    executeRaw.mockResolvedValueOnce(0);
    const job = vi.fn();

    await expect(leases.withLease(lease, job)).resolves.toEqual({
      claimed: false,
    });
    expect(job).not.toHaveBeenCalled();
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });
});
