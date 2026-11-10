import { execFileSync } from 'node:child_process';
import { testEnv } from './test-env.js';

export function setup(): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testEnv.DATABASE_URL },
    stdio: 'pipe',
  });
}
