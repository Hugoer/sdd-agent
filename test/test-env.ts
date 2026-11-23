// Environment for integration tests. Test values win over a developer's .env:
// ConfigModule and prisma.config.ts never override variables already set.
export const TEST_DATABASE_NAME = 'sdd_agent_test';

export const testEnv = {
  DATABASE_URL: `postgresql://sdd_agent:sdd_agent@localhost:5434/${TEST_DATABASE_NAME}`,
  GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY_PATH: 'test/fixtures/fake-app-key.txt',
  TARGET_REPO: 'test-owner/test-repo',
  NGROK_DOMAIN: '',
  // Made up and not key-shaped: no test may reach Google.
  GOOGLE_API_KEY: 'test-google-api-key',
  TARGET_BASE_BRANCH: 'main',
  // Spec 6: the defaults, so a developer's .env can't change what the suites expect.
  GRILL_MAX_ROUNDS: '5',
  GRILL_MAX_QUESTIONS_PER_ROUND: '3',
  GRILL_CONFIDENCE_THRESHOLD: '95',
  // Spec 11: the defaults (a limit suite sets its own before boot).
  SKILL_DISCOVERY_MAX_LOADS: '10',
  SKILL_DISCOVERY_MAX_BYTES: '204800',
  // Spec 14: the default.
  APPROVAL_LARGE_CHANGE_FILES: '15',
};
