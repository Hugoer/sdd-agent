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
        laneConflictLanes: [],
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

  describe('context_loads and the new execution_logs columns (spec 11)', () => {
    it('an execution_logs row written without them: empty call_id, turn 1, three sizes 0', async () => {
      const row = await prisma.executionLog.create({
        data: {
          platform: 'GITHUB',
          taskId: '1',
          externalRef: 'test-owner/test-repo#1',
          step: 'grill',
          provider: 'google',
          model: 'm',
          modelLevel: 'standard',
          skillCommit: 'c',
          attempt: 2,
          status: 'SUCCESS',
          durationMs: 1,
          frameChars: 1,
          skillChars: 1,
          untrustedChars: 1,
          otherChars: 1,
          injectionKinds: [],
          cutSources: [],
          prompt: [],
        },
      });

      expect(row).toMatchObject({
        callId: null,
        turn: 1,
        agentsChars: 0,
        listsChars: 0,
        loadedChars: 0,
      });
    });

    it('a context_loads row gets its id and time; the optional columns stay empty', async () => {
      const row = await prisma.contextLoad.create({
        data: {
          platform: 'GITHUB',
          taskId: '1',
          externalRef: 'test-owner/test-repo#1',
          step: 'grill',
          callId: '00000000-0000-4000-8000-000000000001',
          turn: 0,
          trigger: 'start',
          commit: 'c',
          model: 'm',
          outcome: 'loaded',
          injectionKinds: [],
        },
      });

      expect(row).toMatchObject({
        id: expect.any(String) as string,
        createdAt: expect.any(Date) as Date,
        runId: null,
        tool: null,
        requested: null,
        reason: null,
        kind: null,
        skill: null,
        path: null,
        bytes: null,
        chars: null,
        tokens: null,
        estimatedTokens: null,
        injectionKinds: [],
      });
    });

    it('the three context_loads indexes and the (call_id, turn) index exist', async () => {
      const indexes = await prisma.$queryRaw<{ name: string }[]>`
        SELECT indexname AS name FROM pg_indexes
        WHERE tablename IN ('context_loads', 'execution_logs') ORDER BY indexname`;

      expect(indexes.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          'context_loads_call_id_idx',
          'context_loads_platform_task_id_created_at_idx',
          'context_loads_path_commit_model_idx',
          'execution_logs_call_id_turn_idx',
        ]),
      );
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
