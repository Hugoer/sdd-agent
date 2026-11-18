import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.schema.js';
import { GrillModule } from './grill/grill.module.js';
import { IntakeModule } from './intake/intake.module.js';
import { LlmModule } from './llm/llm.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { WebhookModule } from './webhook/webhook.module.js';
import { WorkflowModule } from './workflow/workflow.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    WebhookModule,
    IntakeModule,
    LlmModule,
    WorkflowModule,
    GrillModule,
  ],
})
export class AppModule {}
