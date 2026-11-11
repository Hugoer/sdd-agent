import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ProviderError } from '../contracts/provider-error.js';
import type { WebhookEvent } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { EventProcessor } from './event-processor.js';

const POLL_INTERVAL_MS = 1_000;
const MAX_ATTEMPTS = 3;
/** Delay before the next try, indexed by attempts already made (1st failure → 5 s, 2nd → 30 s). */
const BACKOFF_MS = [0, 5_000, 30_000];
const MAX_ERROR_LENGTH = 2_000;

/**
 * Processes stored events one at a time, oldest first (spec 1, W3):
 * PENDING → PROCESSING → DONE | IGNORED | FAILED.
 */
@Injectable()
export class EventsWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EventsWorker.name);
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private currentTick: Promise<void> = Promise.resolve();
  private processor: EventProcessor | undefined;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Spec 2, AW5 / plan P1: the module that owns processing registers itself (in its onModuleInit), so
   * `src/events` imports no feature module. Exactly one: a second registration is a wiring mistake.
   */
  registerProcessor(processor: EventProcessor): void {
    if (this.processor) {
      throw new Error(
        'EventsWorker: an event processor is already registered; exactly one module may register one',
      );
    }
    this.processor = processor;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.requireProcessor();
    await this.resetInterrupted();
    this.schedule(0);
  }

  /** The app does not start without a processor: events would be claimed and never decided. */
  protected requireProcessor(): EventProcessor {
    if (!this.processor) {
      throw new Error(
        'EventsWorker: no event processor registered; the module that processes events must call ' +
          'EventsWorker.registerProcessor() in its onModuleInit',
      );
    }
    return this.processor;
  }

  /** Stop claiming, let the current event finish (runs before Prisma disconnects). */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.currentTick;
  }

  /** PROCESSING rows at startup come from a crash: make them claimable again. */
  async resetInterrupted(): Promise<number> {
    const { count } = await this.prisma.webhookEvent.updateMany({
      where: { status: 'PROCESSING' },
      data: { status: 'PENDING' },
    });
    if (count > 0) this.logger.warn(`reset ${count} interrupted event(s)`);
    return count;
  }

  /** Claims and processes due events back to back until none is left; returns how many. */
  async drainOnce(): Promise<number> {
    let processed = 0;
    let event: WebhookEvent | null;
    while (!this.stopping && (event = await this.claimNext())) {
      await this.handle(event);
      processed++;
    }
    return processed;
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    // setTimeout chain: the next tick is scheduled only after this one ends.
    this.timer = setTimeout(() => {
      this.currentTick = this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    try {
      await this.drainOnce();
    } catch (error) {
      this.logger.error(`tick failed, retrying next tick: ${messageOf(error)}`);
    } finally {
      this.schedule(POLL_INTERVAL_MS);
    }
  }

  /** Oldest due PENDING row → PROCESSING, with an update that only wins if it is still PENDING. */
  private async claimNext(): Promise<WebhookEvent | null> {
    for (;;) {
      const candidate = await this.prisma.webhookEvent.findFirst({
        where: { status: 'PENDING', availableAt: { lte: new Date() } },
        orderBy: { receivedAt: 'asc' },
        select: { id: true },
      });
      if (!candidate) return null;

      const { count } = await this.prisma.webhookEvent.updateMany({
        where: { id: candidate.id, status: 'PENDING' },
        data: { status: 'PROCESSING', attempts: { increment: 1 } },
      });
      if (count === 1) {
        return this.prisma.webhookEvent.findUniqueOrThrow({
          where: { id: candidate.id },
        });
      }
      // Another claimer won this row: look for the next one.
    }
  }

  private async handle(event: WebhookEvent): Promise<void> {
    const label = `delivery=${event.deliveryId} event=${event.eventName} action=${event.action ?? '-'}`;
    try {
      const result = await this.requireProcessor().process(event);
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: result.status,
          ignoreReason: result.status === 'IGNORED' ? result.reason : null,
          processedAt: new Date(),
        },
      });
      this.logger.log(
        `${label} ${result.status}${result.status === 'IGNORED' ? ` (${result.reason})` : ''}`,
      );
    } catch (error) {
      await this.fail(event, error, label);
    }
  }

  /** Spec 3 worker rule: a permanent ProviderError fails at once; anything else retries (A2: rate-limit wait). */
  private async fail(
    event: WebhookEvent,
    error: unknown,
    label: string,
  ): Promise<void> {
    const lastError = messageOf(error).slice(0, MAX_ERROR_LENGTH);
    const permanent =
      error instanceof ProviderError && error.kind === 'permanent';
    if (permanent || event.attempts >= MAX_ATTEMPTS) {
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { status: 'FAILED', lastError, processedAt: new Date() },
      });
      this.logger.error(
        `${label} FAILED after ${event.attempts} attempt(s)${permanent ? ' (permanent error)' : ''}: ${lastError}`,
      );
      return;
    }
    const retryAfterMs =
      error instanceof ProviderError
        ? (error.detail.retryAfterSeconds ?? 0) * 1000
        : 0;
    const delayMs = Math.max(BACKOFF_MS[event.attempts], retryAfterMs);
    await this.prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: 'PENDING',
        lastError,
        availableAt: new Date(Date.now() + delayMs),
      },
    });
    this.logger.warn(
      `${label} attempt ${event.attempts}/${MAX_ATTEMPTS} failed, retry in ${delayMs / 1000} s: ${lastError}`,
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
