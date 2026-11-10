import {
  CanActivate,
  ExecutionContext,
  Injectable,
  RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { Env } from '../config/env.schema.js';

/** Decides authenticity (HMAC-SHA256 of the raw body) before anything is parsed or stored. */
@Injectable()
export class GitHubWebhookGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RawBodyRequest<Request>>();
    const received = Buffer.from(req.header('x-hub-signature-256') ?? '');
    const expected = Buffer.from(
      'sha256=' +
        createHmac(
          'sha256',
          this.config.get('GITHUB_WEBHOOK_SECRET', { infer: true }),
        )
          .update(req.rawBody ?? Buffer.alloc(0))
          .digest('hex'),
    );
    // Byte lengths must match before timingSafeEqual, which throws otherwise.
    const ok =
      received.length === expected.length &&
      timingSafeEqual(received, expected);
    if (!ok) throw new UnauthorizedException();
    return true;
  }
}
