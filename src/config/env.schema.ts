import { readFileSync } from 'node:fs';
import { z } from 'zod';

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
// GitHub's characters: owner = letters, digits, hyphens; repo = letters, digits, `.`, `_`, `-` (not `.` or `..`).
const OWNER_SLASH_NAME =
  /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/(?!\.\.?$)[a-z0-9._-]{1,100}$/i;
// A subset of git's ref rules: no leading or trailing `/`, no `..`, no `//`, no `.lock` ending.
const BRANCH_NAME =
  /^(?!\/)(?!.*\/$)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[a-z0-9._/-]{1,255}$/i;

// LW8: `@langchain/core` ships LangSmith; any of these switches would send every prompt to a third party.
const tracingOff = z
  .string()
  .refine(
    (value) => value.trim().toLowerCase() !== 'true',
    'must be unset or false: LangChain tracing must be off (it would send every prompt to LangSmith)',
  )
  .optional();

/** An integer setting with its range in every message (a non-number, a fraction or out of range). */
function integerFromTo(min: number, max: number) {
  const message = `must be an integer from ${min} to ${max}`;
  return z.coerce
    .number({ error: message })
    .int(message)
    .min(min, message)
    .max(max, message);
}

function containsPrivateKey(path: string): boolean {
  try {
    return PRIVATE_KEY_BLOCK.test(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

export const envSchema = z.object({
  PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535, 'must be an integer from 1 to 65535')
    .default(3000),
  DATABASE_URL: z
    .string()
    .regex(/^postgresql:\/\/\S+$/, 'must be a postgresql:// URL'),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_APP_ID: z
    .string()
    .regex(/^[1-9]\d*$/, 'must be a positive integer')
    .transform(Number),
  GITHUB_APP_PRIVATE_KEY_PATH: z
    .string()
    .min(1)
    .refine(
      containsPrivateKey,
      'must point to a readable file containing a PEM private key',
    ),
  TARGET_REPO: z
    .string()
    .regex(OWNER_SLASH_NAME, 'must be owner/name (e.g. you/sdd-agent-sandbox)'),
  NGROK_DOMAIN: z
    .string()
    .refine(
      (value) => value === '' || HOSTNAME.test(value),
      'must be a bare hostname (no scheme, no path)',
    )
    .default(''),
  GOOGLE_API_KEY: z.string().min(1),
  TARGET_BASE_BRANCH: z
    .string()
    .regex(
      BRANCH_NAME,
      'must be a branch name: letters, digits, ".", "_", "-", "/"; no leading or trailing "/", no "..", no "//", no ".lock" ending',
    )
    .default('main'),
  // Spec 5: how long an issue's session lease lasts without a heartbeat (one every third of it).
  SESSION_LEASE_SECONDS: z.coerce
    .number()
    .int('must be an integer of at least 30')
    .min(30, 'must be an integer of at least 30')
    .default(120),
  // Spec 6 (GM2, GM3): question comments per run, questions per comment, and the confidence that ends Grill Me.
  GRILL_MAX_ROUNDS: integerFromTo(1, 10).default(5),
  GRILL_MAX_QUESTIONS_PER_ROUND: integerFromTo(1, 10).default(3),
  GRILL_CONFIDENCE_THRESHOLD: integerFromTo(1, 100).default(95),
  LANGSMITH_TRACING: tracingOff,
  LANGSMITH_TRACING_V2: tracingOff,
  LANGCHAIN_TRACING: tracingOff,
  LANGCHAIN_TRACING_V2: tracingOff,
});

export type Env = z.infer<typeof envSchema>;

/**
 * `ConfigModule` validator. The error names each failing variable and why,
 * never its value: values may be secrets.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => {
    const name = String(issue.path[0]);
    const value = config[name];
    const reason =
      value === undefined || value === '' ? 'is required' : issue.message;
    return `  - ${name}: ${reason}`;
  });
  throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
}
