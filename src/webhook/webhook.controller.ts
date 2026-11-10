import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { EventsService } from '../events/events.service.js';
import { GitHubWebhookGuard } from './github-webhook.guard.js';

/** Stores the delivery and returns. No outbound call happens in the request path. */
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly events: EventsService) {}

  @Post('github')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(GitHubWebhookGuard)
  async receive(
    @Headers('x-github-delivery') deliveryId: string | undefined,
    @Headers('x-github-event') eventName: string | undefined,
    @Body() payload: unknown,
  ): Promise<void> {
    if (!deliveryId || !eventName) {
      throw new BadRequestException(
        'X-GitHub-Delivery and X-GitHub-Event headers are required',
      );
    }
    await this.events.enqueue({ deliveryId, eventName, payload });
  }
}
