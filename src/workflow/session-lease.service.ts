// Spec 5 "Session lease" (overview D2, §7 rule 6; RL7, RLW4). One job per issue: the owner is the event being
// processed. Every time compared is PostgreSQL's (plan P7): Docker's clock and the Mac's can drift apart.
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LeaseLostError } from './workflow-errors.js';

/** The lease an event holds; every guarded write names it. */
export interface HeldLease {
  taskId: string;
  /** `webhook_events.id` of the event being processed. */
  eventId: string;
}

export type LeaseResult<T> = { claimed: false } | { claimed: true; value: T };

@Injectable()
export class SessionLeaseService {
  private readonly logger = new Logger(SessionLeaseService.name);
  private readonly seconds: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.seconds = config.get('SESSION_LEASE_SECONDS', { infer: true });
  }

  /** One atomic update: only where the lease is empty, expired, or already this event's (a retry after a crash). */
  async claim(lease: HeldLease): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE tasks
      SET lease_owner = ${lease.eventId}::uuid,
          lease_expires_at = now() + ${this.seconds}::int * interval '1 second'
      WHERE id = ${lease.taskId}::uuid
        AND (lease_owner IS NULL OR lease_expires_at <= now() OR lease_owner = ${lease.eventId}::uuid)`;
    return updated === 1;
  }

  /**
   * Spec 13 (BFW10, plan FP9): the startup sweep's claim, as a new owner: the lease is empty, expired, or owned by an
   * event that isn't `PROCESSING` (after a `kill -9`, the worker just reset the dead job's event to `PENDING`).
   */
  async claimIdle(lease: HeldLease): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE tasks
      SET lease_owner = ${lease.eventId}::uuid,
          lease_expires_at = now() + ${this.seconds}::int * interval '1 second'
      WHERE id = ${lease.taskId}::uuid
        AND (lease_owner IS NULL OR lease_expires_at <= now()
          OR NOT EXISTS (SELECT 1 FROM webhook_events e WHERE e.id = tasks.lease_owner AND e.status = 'PROCESSING'))`;
    return updated === 1;
  }

  /** The heartbeat's renewal, with the owner in the condition. Another owner → an error line (spec). */
  async renew(lease: HeldLease): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE tasks
      SET lease_expires_at = now() + ${this.seconds}::int * interval '1 second'
      WHERE id = ${lease.taskId}::uuid AND lease_owner = ${lease.eventId}::uuid`;
    if (updated !== 1) {
      this.logger.error(
        `task ${lease.taskId}: the session lease of event ${lease.eventId} was taken by another event`,
      );
    }
    return updated === 1;
  }

  /** Only the owner releases. */
  async release(lease: HeldLease): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE tasks SET lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ${lease.taskId}::uuid AND lease_owner = ${lease.eventId}::uuid`;
  }

  /**
   * Runs `job` under the lease: claim, a heartbeat every third of the lease while it runs, release in `finally`.
   * `{ claimed: false }` when another event holds it (the processor answers WAIT).
   */
  async withLease<T>(
    lease: HeldLease,
    job: () => Promise<T>,
  ): Promise<LeaseResult<T>> {
    if (!(await this.claim(lease))) return { claimed: false };
    return this.holding(lease, job);
  }

  /**
   * Spec 13 (BFW10, plan FP9): `job` under a fresh owner id, claimed with `claimIdle`; `{ claimed: false }` when a
   * live job (a `PROCESSING` event) holds the lease.
   */
  async withIdleLease<T>(
    taskId: string,
    job: (lease: HeldLease) => Promise<T>,
  ): Promise<LeaseResult<T>> {
    const lease: HeldLease = { taskId, eventId: randomUUID() };
    if (!(await this.claimIdle(lease))) return { claimed: false };
    return this.holding(lease, () => job(lease));
  }

  /** The claimed lease's heartbeat while `job` runs, then its release. */
  private async holding<T>(
    lease: HeldLease,
    job: () => Promise<T>,
  ): Promise<LeaseResult<T>> {
    const heartbeat = setInterval(
      () => {
        this.renew(lease).catch((error: unknown) =>
          this.logger.error(
            `task ${lease.taskId}: heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      },
      (this.seconds * 1000) / 3,
    );
    try {
      return { claimed: true, value: await job() };
    } finally {
      clearInterval(heartbeat);
      await this.release(lease);
    }
  }

  /**
   * The first statement of every guarded write's transaction (spec "Code style"): the owner is still this event,
   * or nothing is written (LeaseLostError: temporary, the worker retries against the new state).
   */
  async assertHeld(
    tx: Prisma.TransactionClient,
    lease: HeldLease,
  ): Promise<void> {
    const updated = await tx.$executeRaw`
      UPDATE tasks SET updated_at = now()
      WHERE id = ${lease.taskId}::uuid AND lease_owner = ${lease.eventId}::uuid`;
    if (updated !== 1) throw new LeaseLostError(lease.taskId, lease.eventId);
  }
}
