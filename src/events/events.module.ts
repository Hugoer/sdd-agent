import { Module } from '@nestjs/common';
import { SecretScanModule } from '../secret-scan/secret-scan.module.js';
import { EventsService } from './events.service.js';
import { EventsWorker } from './events.worker.js';

/**
 * Storing and the worker. Imports no feature module: the processor registers itself (spec 2, AW5).
 * SecretScanModule: payloads are stored redacted (spec 12 BDW4).
 */
@Module({
  imports: [SecretScanModule],
  providers: [EventsService, EventsWorker],
  exports: [EventsService, EventsWorker],
})
export class EventsModule {}
