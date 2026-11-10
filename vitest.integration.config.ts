import { defineConfig } from 'vitest/config';
import { testEnv } from './test/test-env.js';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    env: testEnv,
    // One shared database: test files run one after another.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
