// Spec 5: the app's event processor (replaces spec 2's placeholder). Intake first (spec 2), then the router.
import { Injectable, OnModuleInit } from '@nestjs/common';
import type {
  EventProcessor,
  ProcessResult,
} from '../events/event-processor.js';
import { EventsWorker } from '../events/events.worker.js';
import type { WebhookEvent } from '../generated/prisma/client.js';
import { IntakeService } from '../intake/intake.service.js';
import { RouterService } from './router.service.js';

@Injectable()
export class WorkflowEventProcessor implements EventProcessor, OnModuleInit {
  constructor(
    private readonly intake: IntakeService,
    private readonly router: RouterService,
    private readonly worker: EventsWorker,
  ) {}

  onModuleInit(): void {
    this.worker.registerProcessor(this);
  }

  /** An intake error passes through as it is (no router mark): the worker's rule, then a silent FAILED (IA9). */
  async process(event: WebhookEvent): Promise<ProcessResult> {
    const result = await this.intake.intake(event);
    return result.outcome === 'accepted'
      ? this.router.route(event, result.input)
      : { status: 'IGNORED', reason: result.reason };
  }

  /** Row 28: the router stops a running run when the error came after its claim (plan P2, P16). */
  failed(event: WebhookEvent, error: unknown): Promise<void> {
    return this.router.failed(event, error);
  }
}
