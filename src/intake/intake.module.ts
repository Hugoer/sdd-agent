import { Module } from '@nestjs/common';
import { GitHubModule } from '../github/github.module.js';
import { IntakeService } from './intake.service.js';

/** Spec 2: every stored event → a WorkflowInput from an allowed sender, or an ignore reason. */
@Module({
  imports: [GitHubModule],
  providers: [IntakeService],
  exports: [IntakeService],
})
export class IntakeModule {}
