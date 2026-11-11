import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
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

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores a delivery once. A redelivery of a FAILED row queues that row again (spec 2, IA13);
   * a redelivery of any other row changes nothing.
   */
  async enqueue({
    deliveryId,
    eventName,
    payload,
  }: EnqueueInput): Promise<{ duplicate: boolean; requeued: boolean }> {
    const action = actionOf(payload);
    // INSERT … ON CONFLICT DO NOTHING: a redelivery leaves the first row unchanged.
    const { count } = await this.prisma.webhookEvent.createMany({
      data: [
        {
          deliveryId,
          eventName,
          action,
          payload: payload as Prisma.InputJsonValue,
          externalRef: externalRefOf(payload),
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

  /** One update that only matches a FAILED row, so two redeliveries at once queue it once. */
  private async requeueFailed(deliveryId: string): Promise<boolean> {
    const { count } = await this.prisma.webhookEvent.updateMany({
      where: { deliveryId, status: 'FAILED' },
      data: {
        status: 'PENDING',
        attempts: 0,
        availableAt: new Date(),
        processedAt: null,
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
