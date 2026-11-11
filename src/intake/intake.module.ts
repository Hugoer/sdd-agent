import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { GitHubModule } from '../github/github.module.js';
import { IntakeEventProcessor } from './intake-event.processor.js';
import { IntakeService } from './intake.service.js';

/** Spec 2: every stored event → a WorkflowInput from an allowed sender, or an ignore reason. */
@Module({
  imports: [EventsModule, GitHubModule],
  providers: [IntakeService, IntakeEventProcessor],
  exports: [IntakeService],
})
export class IntakeModule {}
