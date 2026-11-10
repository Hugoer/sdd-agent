import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

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

  async enqueue({
    deliveryId,
    eventName,
    payload,
  }: EnqueueInput): Promise<{ duplicate: boolean }> {
    const action = actionOf(payload);
    // INSERT … ON CONFLICT DO NOTHING: a redelivery leaves the first row unchanged.
    const { count } = await this.prisma.webhookEvent.createMany({
      data: [
        {
          deliveryId,
          eventName,
          action,
          payload: payload as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    const duplicate = count === 0;
    this.logger.log(
      `delivery=${deliveryId} event=${eventName} action=${action ?? '-'} ${duplicate ? 'duplicate' : 'stored'}`,
    );
    return { duplicate };
  }
}

function actionOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { action } = payload as { action?: unknown };
  return typeof action === 'string' ? action : null;
}
