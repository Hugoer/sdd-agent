import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Node does not override variables that are already set, so a DATABASE_URL
// passed in (e.g. by the integration test setup) wins over .env.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env['DATABASE_URL'] },
});
