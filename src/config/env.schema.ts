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
