import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { WebhookController } from './webhook.controller.js';

@Module({
  imports: [EventsModule],
  controllers: [WebhookController],
})
export class WebhookModule {}
