import { Module, type OnModuleInit } from '@nestjs/common';
import { GitHubModule } from '../github/github.module.js';
import { GrillModule } from '../grill/grill.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { SecretScanModule } from '../secret-scan/secret-scan.module.js';
import { StepHandlerRegistry } from '../workflow/step-handler.registry.js';
import { WorkflowModule } from '../workflow/workflow.module.js';
import { DocumentsGate } from './approval-check.js';
import { DocumentApprovals } from './document-approval.js';
import { DocumentPosts } from './document-posts.js';
import { DocumentRefreshes } from './document-refresh.js';
import { DocumentsHandler } from './documents.handler.js';
import { DocumentsStore } from './documents.store.js';
import { GoSignalHandler } from './go-signal.handler.js';
import { PlanHandler } from './plan.handler.js';
import { SpecHandler } from './spec.handler.js';

/**
 * Spec 7: the Spec, the Plan, the go-signal and the replies to `/approve`, `/refresh` and `/restore`. Registers its
 * handlers with spec 5's registry; WorkflowModule never imports it (overview §1 module rules). GrillModule for the
 * transcript the Spec reads; SecretScanModule for `redact()` before a text is stored (L17). AppModule imports it
 * after GrillModule, so Grill Me's cancel hook comes first in the run-ended comment (plan P3).
 */
@Module({
  imports: [
    WorkflowModule,
    LlmModule,
    GrillModule,
    GitHubModule,
    SecretScanModule,
  ],
  providers: [
    DocumentsStore,
    DocumentPosts,
    DocumentApprovals,
    DocumentRefreshes,
    SpecHandler,
    PlanHandler,
    GoSignalHandler,
    DocumentsHandler,
    DocumentsGate,
  ],
})
export class DocumentsModule implements OnModuleInit {
  constructor(
    private readonly registry: StepHandlerRegistry,
    private readonly spec: SpecHandler,
    private readonly plan: PlanHandler,
    private readonly goSignal: GoSignalHandler,
    private readonly documents: DocumentsHandler,
    private readonly gate: DocumentsGate,
  ) {}

  onModuleInit(): void {
    this.registry.register('spec', this.spec);
    this.registry.register('plan', this.plan);
    this.registry.register('go-signal', this.goSignal);
    this.registry.register('documents', this.documents);
    this.registry.registerGate(this.gate);
  }
}
