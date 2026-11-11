import { Module } from '@nestjs/common';
import { EventsService } from './events.service.js';
import { EventsWorker } from './events.worker.js';

/** Storing and the worker. Imports no feature module: the processor registers itself (spec 2, AW5). */
@Module({
  providers: [EventsService, EventsWorker],
  exports: [EventsService, EventsWorker],
})
export class EventsModule {}
