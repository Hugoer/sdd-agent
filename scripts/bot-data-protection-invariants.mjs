// Spec 12 (bot-data-protection) verification matrix, "Invariants": three invariants over the rows stored since
// spec 12 went live (the `finished_at` of its migration) and over the comments of the issues given; the fourth is
// the fixture in scripts/bot-data-protection-invariants.spec.mjs. Created 2026-11-26 for plan Task 11 (BDW15; plan
// DP23: the checks are pure functions, exported for that test).
//
// A developer check, not part of the bot: read-only SELECTs on the dev database (`DATABASE_URL`) and `gh api` GETs
// with the developer's own `gh` login on `TARGET_REPO`. Never prints a matched value. Exits 1 if any invariant fails.
//
//   node --env-file-if-exists=.env scripts/bot-data-protection-invariants.mjs <issue>…
//
//   <issue>…  the issues whose 🔑 notices invariant 2 reads. Invariants 1 and 3 read every row since the migration.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Spec 4's five secret patterns, copied from src/secret-scan/secret-patterns.ts (plain `node` can't import the
 * `.ts` file); the `.spec.mjs` checks they are equal. `own-secret` (the bot's own values) is not a pattern.
 */
export const SECRET_PATTERNS = [
  {
    kind: 'private-key',
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  {
    kind: 'github-token',
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/g,
  },
  { kind: 'google-api-key', pattern: /AIza[A-Za-z0-9_-]{35}/g },
  { kind: 'aws-access-key', pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/g },
  { kind: 'slack-token', pattern: /xox[bpars]-[A-Za-z0-9-]{10,}/g },
];

/**
 * A copy of `isHiddenPath()` (src/llm/context-tools.ts; spec 7 SPW1, spec 12 BDW7), for the same reason; the
 * `.spec.mjs` compares the two over a table of paths.
 */
export function isHiddenPath(path) {
  const segments = path.toLowerCase().split('/');
  const name = segments.at(-1) ?? '';
  const folders = segments.slice(0, -1);
  return (
    ['claude.md', 'gemini.md', '.cursorrules', '.windsurfrules'].includes(
      name,
    ) ||
    name === '.env' ||
    (name.startsWith('.env.') && name !== '.env.example') ||
    segments.join('/') === '.github/copilot-instructions.md' ||
    folders[0] === '.github-agent' ||
    folders.includes('.cursor')
  );
}

/** The kinds of secret the text holds, each once; never the value. */
export function secretKindsIn(text) {
  return SECRET_PATTERNS.filter(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  }).map(({ kind }) => kind);
}

/**
 * 1. No text stored since the migration matches a secret pattern: `{ where, text }` per stored text (a payload, a
 * prompt, an answer, a Grill answer, a document's texts). Each failure names where and the kinds, never the value.
 */
export function checkNoStoredSecrets({ texts }) {
  const failures = [];
  for (const { where, text } of texts) {
    const kinds = secretKindsIn(text ?? '');
    if (kinds.length > 0) failures.push(`${where}: holds ${kinds.join(', ')}`);
  }
  return failures;
}

const NOTICE = /^<!-- sdd-agent:secret-removed:(\S+) -->/;

/** 2. On the given issues, at most one 🔑 comment per source key, each by the App (a Bot account). */
export function checkNotices({ comments }) {
  const failures = [];
  const seen = new Map();
  for (const c of comments) {
    const key = NOTICE.exec(c.body ?? '')?.[1];
    if (!key) continue;
    const where = `#${c.number} ${key}`;
    if (!c.bot)
      failures.push(`${where}: comment ${c.id} is not by the App (${c.login})`);
    const id = `${c.number} ${key}`;
    if (seen.has(id))
      failures.push(
        `${where}: a second notice, comment ${c.id} (first ${seen.get(id)})`,
      );
    else seen.set(id, c.id);
  }
  return failures;
}

/**
 * 3. No `context_loads` row since the migration where a read tool (`read_file`, `list_files`) gave a hidden path.
 * The hidden list is the read tools' (spec 7 SPW1): the step skill under `.github-agent/` is given at start and
 * through `load_file` by design.
 */
export function checkHiddenLoads({ loads }) {
  return loads
    .filter(
      (l) =>
        (l.tool === 'read_file' || l.tool === 'list_files') &&
        l.outcome === 'loaded' &&
        l.path &&
        isHiddenPath(l.path),
    )
    .map(
      (l) =>
        `#${String(l.external_ref).split('#')[1]} context_loads row ${l.id}: ${l.tool ?? l.trigger} ${l.path} loaded`,
    );
}

export const INVARIANTS = [
  [
    '1 no payload, prompt, answer, Grill answer or document stored since the migration holds a secret',
    checkNoStoredSecrets,
  ],
  [
    '2 at most one 🔑 notice per source key on the issues given, each by the App',
    checkNotices,
  ],
  ['3 no read_file or list_files row gave a hidden path', checkHiddenLoads],
];

/** Every check over the data: `[{ name, failures }]`. */
export function runChecks(data) {
  return INVARIANTS.map(([name, check]) => ({ name, failures: check(data) }));
}

/** `{ where, text }` per stored text of the rows read (jsonb as its JSON text). */
export function storedTexts({ events, logs, answers, documents }) {
  const json = (value) => (value == null ? '' : JSON.stringify(value));
  const ref = (r) => (r.external_ref ? ` ${r.external_ref}` : '');
  return [
    ...events.map((e) => ({
      where: `webhook_events ${e.delivery_id}${ref(e)}`,
      text: json(e.payload),
    })),
    ...logs.flatMap((l) => [
      { where: `execution_logs ${l.id}${ref(l)} prompt`, text: json(l.prompt) },
      { where: `execution_logs ${l.id}${ref(l)} answer`, text: json(l.answer) },
    ]),
    ...answers.map((a) => ({
      where: `grill_answers comment ${a.comment_id}${ref(a)}`,
      text: a.body,
    })),
    ...documents.flatMap((d) =>
      ['text', 'body', 'deleted_text', 'approved_text'].map((column) => ({
        where: `task_documents ${d.id}${ref(d)} ${column}`,
        text: d[column] ?? '',
      })),
    ),
  ];
}

async function main() {
  const issues = process.argv
    .slice(2)
    .filter((a) => /^\d+$/.test(a))
    .map(Number);
  const REPO = process.env.TARGET_REPO;
  if (!REPO || !process.env.DATABASE_URL || issues.length === 0) {
    console.error(
      'Usage: node --env-file-if-exists=.env scripts/bot-data-protection-invariants.mjs <issue>…',
    );
    console.error(
      'TARGET_REPO and DATABASE_URL must be set (run from the bot repo; .env is loaded).',
    );
    process.exit(1);
  }
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const [migration] = await q(
    `SELECT finished_at AS live FROM _prisma_migrations
     WHERE migration_name LIKE '%\\_bot\\_data\\_protection' AND finished_at IS NOT NULL`,
  );
  if (!migration) {
    console.error(
      'Spec 12 is not live: its migration is not applied (npm run db:migrate).',
    );
    process.exit(1);
  }
  const { live } = migration;
  const events = await q(
    `SELECT delivery_id, external_ref, payload FROM webhook_events WHERE received_at >= $1`,
    [live],
  );
  const logs = await q(
    `SELECT id, external_ref, prompt, answer FROM execution_logs WHERE created_at >= $1`,
    [live],
  );
  const answers = await q(
    `SELECT a.comment_id, a.body, t.external_ref FROM grill_answers a
     JOIN grill_sessions s ON s.id = a.session_id JOIN tasks t ON t.id = s.task_id
     WHERE a.read_at >= $1`,
    [live],
  );
  const documents = await q(
    `SELECT d.id, d.text, d.body, d.deleted_text, d.approved_text, t.external_ref
     FROM task_documents d JOIN tasks t ON t.id = d.task_id
     WHERE d.created_at >= $1 OR d.approved_at >= $1`,
    [live],
  );
  const loads = await q(
    `SELECT id, external_ref, trigger, tool, path, outcome FROM context_loads WHERE created_at >= $1`,
    [live],
  );
  await db.end();

  const comments = [];
  for (const number of issues) {
    const pages = JSON.parse(
      execFileSync(
        'gh',
        [
          'api',
          '--paginate',
          '--slurp',
          `repos/${REPO}/issues/${number}/comments?per_page=100`,
        ],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      ),
    ).flat();
    for (const c of pages)
      comments.push({
        number,
        id: String(c.id),
        body: c.body ?? '',
        login: c.user?.login ?? '',
        bot: c.user?.type === 'Bot',
      });
  }
  const texts = storedTexts({ events, logs, answers, documents });
  console.log(
    `since ${live.toISOString()}: ${events.length} payloads, ${logs.length} model requests, ${answers.length} ` +
      `Grill answers, ${documents.length} document versions, ${loads.length} context loads; ` +
      `${comments.length} comments on ${issues.length} issues`,
  );
  const results = runChecks({ texts, comments, loads });
  for (const { name, failures } of results) {
    console.log(`${failures.length === 0 ? 'PASS' : 'FAIL'} ${name}`);
    for (const failure of failures.slice(0, 10)) console.log(`     ${failure}`);
    if (failures.length > 10)
      console.log(`     … ${failures.length - 10} more`);
  }
  const failed = results.filter((r) => r.failures.length > 0).length;
  console.log(
    failed === 0 ? 'Invariants: all passed.' : `Invariants: ${failed} failed.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
