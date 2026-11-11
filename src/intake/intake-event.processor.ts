import { Injectable, OnModuleInit } from '@nestjs/common';
import type {
  EventProcessor,
  ProcessResult,
} from '../events/event-processor.js';
import { EventsWorker } from '../events/events.worker.js';
import type { WebhookEvent } from '../generated/prisma/client.js';
import { IntakeService } from './intake.service.js';

/**
 * Placeholder until spec 5 (IA1): an accepted input ends DONE and goes nowhere else (IntakeService logs it);
 * an ignored one ends IGNORED with its reason. Spec 5 registers its own processor instead of this one.
 */
@Injectable()
export class IntakeEventProcessor implements EventProcessor, OnModuleInit {
  constructor(
    private readonly intake: IntakeService,
    private readonly worker: EventsWorker,
  ) {}

  onModuleInit(): void {
    this.worker.registerProcessor(this);
  }

  async process(event: WebhookEvent): Promise<ProcessResult> {
    const result = await this.intake.intake(event);
    return result.outcome === 'accepted'
      ? { status: 'DONE' }
      : { status: 'IGNORED', reason: result.reason };
  }
}
