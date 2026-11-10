import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabase } from './db.js';
import { testEnv } from './test-env.js';

describe('database wiring', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = await moduleRef.createNestApplication().init();
    prisma = app.get(PrismaService);
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  it('writes and reads a webhook event with the defaults from the schema', async () => {
    await prisma.webhookEvent.create({
      data: { deliveryId: 'smoke-1', eventName: 'ping', payload: { zen: 'x' } },
    });

    const row = await prisma.webhookEvent.findUniqueOrThrow({
      where: { deliveryId: 'smoke-1' },
    });
    expect(row).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      payload: { zen: 'x' },
    });
  });

  it('resetDatabase refuses any database but the test one', async () => {
    const other = new PrismaService(
      new ConfigService({
        DATABASE_URL: testEnv.DATABASE_URL.replace(/\/[^/]+$/, '/postgres'),
      }),
    );
    try {
      await expect(resetDatabase(other)).rejects.toThrow(
        'refusing to reset database "postgres"',
      );
    } finally {
      await other.$disconnect();
    }
  });
});
