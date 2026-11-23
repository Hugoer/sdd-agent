import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.spec.ts',
      'test/fakes/**/*.spec.ts',
      'scripts/**/*.spec.mjs', // spec 7 plan P11: the invariant script's checks
    ],
  },
});
