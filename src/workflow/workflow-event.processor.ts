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
import { StartupSweepService } from './startup-sweep.service.js';

@Injectable()
export class WorkflowEventProcessor implements EventProcessor, OnModuleInit {
  constructor(
    private readonly intake: IntakeService,
    private readonly router: RouterService,
    private readonly worker: EventsWorker,
    private readonly sweep: StartupSweepService,
  ) {}

  onModuleInit(): void {
    this.worker.registerProcessor(this);
  }

  /** An intake error passes through as it is (no router mark): the worker's rule, then a silent FAILED (IA9). */
  async process(event: WebhookEvent): Promise<ProcessResult> {
    const result = await this.intake.intake(event);
    if (result.outcome === 'accepted')
      return this.router.route(event, result.input);
    // Spec 13 (plan FP7, review): intake runs again on every attempt; one after `working()` may end here.
    await this.router.endOutsideRouter(event);
    return { status: 'IGNORED', reason: result.reason };
  }

  /** Spec 13 (BFW10, plan FP13): the startup sweep, before the worker's first claim. */
  recover(): Promise<void> {
    return this.sweep.sweep();
  }

  /** Row 28: the router stops a running run when the error came after its claim (plan P2, P16). */
  failed(event: WebhookEvent, error: unknown): Promise<void> {
    return this.router.failed(event, error);
  }
}
