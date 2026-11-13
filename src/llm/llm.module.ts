import { Module } from '@nestjs/common';
import { GitHubModule } from '../github/github.module.js';
import { CHAT_MODEL_FACTORY } from './chat-model.factory.js';
import { GoogleChatModelFactory } from './google/google-chat-model.factory.js';
import { StepConfigService } from './step-config.service.js';

/**
 * Spec 4: what every step uses to call a model. The provider seam is bound to Google here (L2); tests bind the
 * scripted fake (plan P8). Nothing here calls a model at startup.
 */
@Module({
  imports: [GitHubModule],
  providers: [
    { provide: CHAT_MODEL_FACTORY, useClass: GoogleChatModelFactory },
    StepConfigService,
  ],
  exports: [CHAT_MODEL_FACTORY, StepConfigService],
})
export class LlmModule {}
