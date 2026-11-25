import { Module, type OnModuleInit } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { GitHubModule } from '../github/github.module.js';
import { IntakeModule } from '../intake/intake.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { SecretScanModule } from '../secret-scan/secret-scan.module.js';
import { StepHandlerRegistry } from '../workflow/step-handler.registry.js';
import { WorkflowModule } from '../workflow/workflow.module.js';
import { AnswerReader } from './answer-reader.service.js';
import { GrillEvaluationService } from './grill-evaluation.service.js';
import { GrillHandler } from './grill.handler.js';
import { GrillService } from './grill.service.js';
import { GrillStore } from './grill.store.js';

/**
 * Spec 6: Grill Me. Registers the `grill` handler with spec 5's registry; WorkflowModule never imports it
 * (overview §1 module rules). GitHubModule and EventsModule for the issue port and the stored comments (plan P7).
 * SecretScanModule: the answer reader redacts each body (spec 12 BDW4).
 * Exports GrillService: the transcript the Spec step reads (spec 7).
 */
@Module({
  imports: [
    WorkflowModule,
    LlmModule,
    IntakeModule,
    GitHubModule,
    EventsModule,
    SecretScanModule,
  ],
  providers: [
    GrillStore,
    AnswerReader,
    GrillEvaluationService,
    GrillHandler,
    GrillService,
  ],
  exports: [GrillService],
})
export class GrillModule implements OnModuleInit {
  constructor(
    private readonly registry: StepHandlerRegistry,
    private readonly handler: GrillHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register('grill', this.handler);
  }
}
