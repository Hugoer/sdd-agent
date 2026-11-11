import { Module } from '@nestjs/common';
import { GitHubModule } from '../github/github.module.js';
import { EventProcessor } from './event-processor.js';
import { EventsService } from './events.service.js';
import { EventsWorker } from './events.worker.js';
import { HelloCommentService } from './hello/hello-comment.service.js';

@Module({
  imports: [GitHubModule],
  providers: [EventsService, EventsWorker, EventProcessor, HelloCommentService],
  exports: [EventsService],
})
export class EventsModule {}
