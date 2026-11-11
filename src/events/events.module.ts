import { Module } from '@nestjs/common';
import { GitHubModule } from '../github/github.module.js';
import { EventProcessor } from './event-processor.js';
import { EventsService } from './events.service.js';
import { EventsWorker } from './events.worker.js';

@Module({
  imports: [GitHubModule],
  providers: [EventsService, EventsWorker, EventProcessor],
  exports: [EventsService],
})
export class EventsModule {}
