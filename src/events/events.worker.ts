import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { LlmError, StepConfigError } from '../contracts/llm-error.js';
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
  /** Spec 13 (plan FP13): the processor's recovery hook has run (the first tick runs it). */
  private recovered = false;

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
    this.logProcessor();
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

  /** Spec 5 matrix "Startup": the log names the registered processor (after requireProcessor's check). */
  protected logProcessor(): void {
    this.logger.log(
      `event processor: ${this.requireProcessor().constructor.name}`,
    );
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

  /**
   * Spec 13 (BFW10, plan FP13): the processor's recovery hook, once, before the first claim; a processor without
   * one starts as before. An error it throws is logged: a recovery never blocks events.
   */
  protected async recover(): Promise<void> {
    this.recovered = true;
    try {
      await this.requireProcessor().recover?.();
    } catch (error) {
      this.logger.error(
        `recovery hook failed, the worker starts anyway: ${messageOf(error)}`,
      );
    }
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
      if (!this.recovered) await this.recover();
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
      if (result.status === 'WAIT') {
        await this.wait(event, result.delayMs, label);
        return;
      }
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

  /**
   * Spec 3 worker rule, extended by spec 4: a permanent ProviderError or LlmError and every StepConfigError fail
   * at once; anything else retries, never sooner than the provider's retryAfterSeconds (A2).
   */
  private async fail(
    event: WebhookEvent,
    error: unknown,
    label: string,
  ): Promise<void> {
    const lastError = messageOf(error).slice(0, MAX_ERROR_LENGTH);
    const permanent =
      error instanceof StepConfigError ||
      (isProviderOrLlmError(error) && error.kind === 'permanent');
    if (permanent || event.attempts >= MAX_ATTEMPTS) {
      const failed = await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { status: 'FAILED', lastError, processedAt: new Date() },
      });
      this.logger.error(
        `${label} FAILED after ${event.attempts} attempt(s)${permanent ? ' (permanent error)' : ''}: ${lastError}`,
      );
      await this.notifyFailed(failed, error, label);
      return;
    }
    const retryAfterMs = isProviderOrLlmError(error)
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

  /**
   * Spec 5 (RLW11): back to PENDING after the delay, the attempt taken back (claimNext counted it). No
   * lastError: waiting is not a failure. The processor logs why it waits.
   */
  private async wait(
    event: WebhookEvent,
    delayMs: number,
    label: string,
  ): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: 'PENDING',
        attempts: { decrement: 1 },
        availableAt: new Date(Date.now() + delayMs),
      },
    });
    this.logger.debug(`${label} WAIT ${delayMs / 1000} s`);
  }

  /**
   * Spec 5 (RLW11): the processor's failure hook, once per FAILED row, awaited here so its writes (a stop)
   * are saved before the next event is claimed (RL7). Its own error only goes to the log.
   */
  private async notifyFailed(
    event: WebhookEvent,
    error: unknown,
    label: string,
  ): Promise<void> {
    try {
      await this.requireProcessor().failed(event, error);
    } catch (hookError) {
      this.logger.error(
        `${label} failure hook failed, the row stays FAILED: ${messageOf(hookError)}`,
      );
    }
  }
}

/** The two errors that carry a kind and a retry delay. */
function isProviderOrLlmError(
  error: unknown,
): error is ProviderError | LlmError {
  return error instanceof ProviderError || error instanceof LlmError;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
