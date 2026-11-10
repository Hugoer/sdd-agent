import type { PrismaService } from '../src/prisma/prisma.service.js';
import { TEST_DATABASE_NAME } from './test-env.js';

/** Empties the tables, refusing to run against anything but the test database. */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const [{ db }] = await prisma.$queryRaw<
    { db: string }[]
  >`SELECT current_database() AS db`;
  if (db !== TEST_DATABASE_NAME) {
    throw new Error(`refusing to reset database "${db}"`);
  }
  await prisma.$executeRaw`TRUNCATE webhook_events`;
}
