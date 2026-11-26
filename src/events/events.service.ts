import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, WebhookEvent } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { kindList, SecretScanner } from '../secret-scan/secret-scanner.js';
import { externalRefOf } from './external-ref.js';

export interface EnqueueInput {
  deliveryId: string;
  eventName: string;
  payload: unknown;
}

/** The only way into the event queue (a BullMQ swap would replace this service and the worker). */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scanner: SecretScanner,
  ) {}

  /**
   * Stores a delivery once. A redelivery of a FAILED row queues that row again (spec 2, IA13);
   * a redelivery of any other row changes nothing. Every string of the payload is redacted first (spec 12 BDW4):
   * no secret value is stored, and a redelivery redacts the same way.
   */
  async enqueue({
    deliveryId,
    eventName,
    payload: received,
  }: EnqueueInput): Promise<{ duplicate: boolean; requeued: boolean }> {
    const { value: payload, findings } = this.scanner.redactJson(received);
    if (findings.length > 0) {
      this.logger.warn(
        `secret-scan payload ${deliveryId}: redacted ${findings.length} (${kindList(findings)})`,
      );
    }
    const action = actionOf(payload);
    // Spec 5, plan P7: "received" is PostgreSQL's clock. Prisma would fill `@default(now())` from Node's, and the
    // router compares it with times PostgreSQL wrote (`stopped_at`); Docker's clock and the Mac's can drift.
    const [{ now }] = await this.prisma.$queryRaw<
      { now: Date }[]
    >`SELECT now() AS now`;
    // INSERT … ON CONFLICT DO NOTHING: a redelivery leaves the first row unchanged.
    const { count } = await this.prisma.webhookEvent.createMany({
      data: [
        {
          deliveryId,
          eventName,
          action,
          payload: payload as Prisma.InputJsonValue,
          externalRef: externalRefOf(payload),
          receivedAt: now,
        },
      ],
      skipDuplicates: true,
    });
    const duplicate = count === 0;
    const requeued = duplicate && (await this.requeueFailed(deliveryId));
    this.logger.log(
      `delivery=${deliveryId} event=${eventName} action=${action ?? '-'} ${requeued ? 'requeued' : duplicate ? 'duplicate' : 'stored'}`,
    );
    return { duplicate, requeued };
  }

  /**
   * Spec 5 (RLW11, plan P8): `/retry` queues a stopped run's event again. Only an event that ended (FAILED,
   * IGNORED or DONE) changes; one PENDING or PROCESSING is left as it is. `lastError` is kept; the ignore
   * reason goes with the old ending. `tx`: the `/retry` transaction, so the restore and this commit together.
   * Spec 13 (plan FP3): the working times are cleared, so the re-run's wait starts at its own first `working()`.
   */
  async requeue(
    eventId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const { count } = await tx.webhookEvent.updateMany({
      where: { id: eventId, status: { in: ['FAILED', 'IGNORED', 'DONE'] } },
      data: {
        status: 'PENDING',
        attempts: 0,
        availableAt: new Date(),
        processedAt: null,
        ignoreReason: null,
        workingStartedAt: null,
        workingEndedAt: null,
      },
    });
    this.logger.log(
      `event=${eventId} ${count === 1 ? 'requeued for /retry' : 'not requeued (still pending or processing)'}`,
    );
  }

  /**
   * Spec 6 (GMW1, GM12): an issue's `issue_comment` events received at or after `since`, in any state, oldest
   * first. The comments are read from what GitHub sent when they were created, never from GitHub now.
   */
  commentEventsSince(
    externalRef: string,
    since: Date,
  ): Promise<WebhookEvent[]> {
    return this.prisma.webhookEvent.findMany({
      where: {
        externalRef,
        eventName: 'issue_comment',
        receivedAt: { gte: since },
      },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Spec 13 (BFW8): the event's first `working()`; kept through the worker's retries (PostgreSQL's clock, as
   * `received_at`).
   */
  async workingStarted(eventId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE webhook_events SET working_started_at = COALESCE(working_started_at, now())
      WHERE id = ${eventId}::uuid`;
  }

  /** Spec 13 (BFW8): the event is finished for good; only an event that started working gets the time. */
  async workingEnded(eventId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE webhook_events SET working_ended_at = now()
      WHERE id = ${eventId}::uuid AND working_started_at IS NOT NULL`;
  }

  /** One update that only matches a FAILED row, so two redeliveries at once queue it once. */
  private async requeueFailed(deliveryId: string): Promise<boolean> {
    const { count } = await this.prisma.webhookEvent.updateMany({
      where: { deliveryId, status: 'FAILED' },
      data: {
        status: 'PENDING',
        attempts: 0,
        availableAt: new Date(),
        processedAt: null,
        // Spec 13 (plan FP3).
        workingStartedAt: null,
        workingEndedAt: null,
      },
    });
    return count === 1;
  }
}

function actionOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { action } = payload as { action?: unknown };
  return typeof action === 'string' ? action : null;
}
