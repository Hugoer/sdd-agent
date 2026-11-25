import { Module } from '@nestjs/common';
import { GitHubModule } from '../github/github.module.js';
import { SecretScanModule } from '../secret-scan/secret-scan.module.js';
import { CHAT_MODEL_FACTORY } from './chat-model.factory.js';
import { ContextLoadService } from './context-load.service.js';
import { ContextLoaderService } from './context-loader.service.js';
import { ExecutionLogService } from './execution-log.service.js';
import { GoogleChatModelFactory } from './google/google-chat-model.factory.js';
import { InjectionWarningService } from './injection-warning.service.js';
import { LlmService } from './llm.service.js';
import { RepoCatalogService } from './repo-catalog.service.js';
import { SecretNoticeService } from './secret-notice.service.js';
import { StepConfigService } from './step-config.service.js';

/**
 * Spec 4: what every step uses to call a model. The provider seam is bound to Google here (L2); tests bind the
 * scripted fake (plan P8). Nothing here calls a model at startup.
 */
@Module({
  // Spec 7 (plan P29): the scanner redacts the repo files the read tools give the model (SPW2).
  imports: [GitHubModule, SecretScanModule],
  providers: [
    { provide: CHAT_MODEL_FACTORY, useClass: GoogleChatModelFactory },
    RepoCatalogService,
    StepConfigService,
    InjectionWarningService,
    SecretNoticeService,
    ExecutionLogService,
    ContextLoadService,
    ContextLoaderService,
    LlmService,
  ],
  exports: [
    LlmService,
    CHAT_MODEL_FACTORY,
    StepConfigService,
    InjectionWarningService,
    // Spec 12 (BDW3): the run start posts the 🔑 notice for the description.
    SecretNoticeService,
    ExecutionLogService,
    // Spec 11 (SDW10): the two tools for specs 9 and 10's agent loops.
    ContextLoaderService,
    // Spec 7 (plan P20): the files a document's calls read, for its approval's commit check.
    ContextLoadService,
  ],
})
export class LlmModule {}
