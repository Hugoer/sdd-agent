import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { GitHubModule } from '../github/github.module.js';
import { IntakeModule } from '../intake/intake.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { SecretScanModule } from '../secret-scan/secret-scan.module.js';
import { NeedsHumanService } from './needs-human.service.js';
import { RouterService } from './router.service.js';
import { RunStartService } from './run-start.service.js';
import { RunService } from './run.service.js';
import { SessionLeaseService } from './session-lease.service.js';
import { StepHandlerRegistry } from './step-handler.registry.js';
import { TaskService } from './task.service.js';
import { WorkflowEventProcessor } from './workflow-event.processor.js';

/**
 * Spec 5: the router. Processes every stored event (intake, then the router) and owns `tasks` and `runs`. Step
 * modules import it and register their handlers; it never imports them (overview §1 module rules).
 */
@Module({
  // SecretScanModule: the run start redacts the description (spec 12, plan DP11, DP13).
  imports: [
    EventsModule,
    IntakeModule,
    GitHubModule,
    LlmModule,
    SecretScanModule,
  ],
  providers: [
    SessionLeaseService,
    TaskService,
    RunService,
    RunStartService,
    StepHandlerRegistry,
    NeedsHumanService,
    RouterService,
    WorkflowEventProcessor,
  ],
  // Spec 6: SessionLeaseService for `assertHeld` in the step modules' own writes.
  exports: [
    StepHandlerRegistry,
    RunService,
    NeedsHumanService,
    SessionLeaseService,
  ],
})
export class WorkflowModule {}
