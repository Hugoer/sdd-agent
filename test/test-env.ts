// Environment for integration tests. Test values win over a developer's .env:
// ConfigModule and prisma.config.ts never override variables already set.
export const TEST_DATABASE_NAME = 'sdd_agent_test';

export const testEnv = {
  DATABASE_URL: `postgresql://sdd_agent:sdd_agent@localhost:5434/${TEST_DATABASE_NAME}`,
  GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY_PATH: 'test/fixtures/fake-app-key.txt',
  NGROK_DOMAIN: '',
};
