import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { offlineProviders } from './app.js';
import { resetDatabase } from './db.js';
import { testEnv } from './test-env.js';

describe('database wiring', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await offlineProviders(
      Test.createTestingModule({ imports: [AppModule] }),
    ).compile();
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

  describe('tasks and runs (spec 5)', () => {
    async function seedTask(number: number) {
      return prisma.task.create({
        data: {
          platform: 'GITHUB',
          platformId: String(1000 + number),
          externalRef: `test-owner/test-repo#${number}`,
        },
      });
    }
    const runData = (taskId: string, number: number) => ({
      taskId,
      number,
      lane: 'full-sdd',
      grillSkip: false,
      startEventId: '00000000-0000-4000-8000-000000000001',
      startEventReceivedAt: new Date(),
    });

    it('a new task has the schema defaults: draft, no label shown, no run, no lease', async () => {
      const task = await seedTask(1);

      expect(task).toMatchObject({
        status: 'draft',
        shownStatus: null,
        currentRunId: null,
        runCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        laneConflictOpen: false,
        laneConflicts: 0,
      });
    });

    it('a second run with the same (task, number) is refused; another number is fine', async () => {
      const task = await seedTask(2);
      await prisma.run.create({ data: runData(task.id, 1) });

      await expect(
        prisma.run.create({ data: runData(task.id, 1) }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        prisma.run.create({ data: runData(task.id, 2) }),
      ).resolves.toMatchObject({ number: 2, stops: 0, retries: 0 });
    });

    it('one task per (platform, platformId)', async () => {
      await seedTask(3);

      await expect(seedTask(3)).rejects.toMatchObject({ code: 'P2002' });
    });

    it('execution_logs.run_id is still text with no foreign key', async () => {
      const [column] = await prisma.$queryRaw<{ data_type: string }[]>`
        SELECT data_type FROM information_schema.columns
        WHERE table_name = 'execution_logs' AND column_name = 'run_id'`;
      const foreignKeys = await prisma.$queryRaw<{ name: string }[]>`
        SELECT conname AS name FROM pg_constraint
        WHERE conrelid = 'execution_logs'::regclass AND contype = 'f'`;

      expect(column.data_type).toBe('text');
      expect(foreignKeys).toEqual([]);
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
