// Spec 7 (spec-plan-approvals) verification matrix, "Invariants": the eight invariants over every row stored since
// spec 7 went live (the first `task_documents` row) and over the comments of the issues given. Created 2026-11-23
// for plan Task 24 (P11: the checks are pure functions, exported for scripts/spec-plan-approvals-invariants.spec.mjs).
//
// A developer check, not part of the bot: read-only SELECTs on the dev database (`DATABASE_URL`) and `gh api` GETs
// with the developer's own `gh` login on `TARGET_REPO`. Exits 1 if any invariant fails.
//
//   node --env-file-if-exists=.env scripts/spec-plan-approvals-invariants.mjs <issue>… [--canary <text>]
//
//   <issue>…  every issue of the run: rows come from all issues since spec 7 went live, comments only from these, so
//             a wrong list fails (a stored version with no comment)
//   --canary  the sandbox CLAUDE.md's canary text (default PINEAPPLE)
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const COMMENT_MAX_CHARS = 65_536;
export const DOCUMENT_MAX_CHARS = 50_000;
const DOCUMENT_START = '<!-- sdd-agent:document -->';
const DOCUMENT_END = '<!-- sdd-agent:document-end -->';
const COMMANDS = new Set(['/approve', '/refresh', '/restore']);
/** The replies that answer a command comment, by their marker key (`<key>:<commentId>`). */
const ANSWER_KEYS = new Set([
  'approve-refused',
  'refresh',
  'refresh-refused',
  'restore',
  'restore-refused',
]);

/** A bot comment's hidden marker (its first line): `{ key, id }`, e.g. `spec:<versionId>`; null without one. */
export function markerOf(body) {
  const match = /^<!-- sdd-agent:([a-z-]+):(\S+?) -->/.exec(body ?? '');
  return match ? { key: match[1], id: match[2].split(':')[0] } : null;
}

/** SPW5: the text between the document markers (the whole comment without them), without hidden markers. */
export function documentTextOf(body) {
  const start = body.indexOf(DOCUMENT_START);
  const end = body.lastIndexOf(DOCUMENT_END);
  const inner =
    start >= 0 && end > start
      ? body.slice(start + DOCUMENT_START.length, end)
      : body;
  return inner
    .replace(/\r\n/g, '\n')
    .replace(/<!-- sdd-agent:[^>]*-->/g, '')
    .trim();
}

const issueOf = (ref) => `#${String(ref).split('#')[1]}`;
const versionMarker = (doc) =>
  doc.kind === 'go-signal'
    ? `go-signal:${doc.run_id}`
    : `${doc.kind}:${doc.id}`;
const at = (value) => new Date(value).getTime();

/**
 * 1. Every `POSTED` version has exactly one comment with its marker, whose text is its `body` (a comment people
 * edited is matched by its marker only); one deleted, or one whose comment went after it stopped counting
 * (approved or superseded), may have none. No version comment without its row.
 */
export function checkVersionComments({ documents, comments }) {
  const failures = [];
  const byMarker = new Map();
  for (const c of comments.filter((c) => c.bot)) {
    const m = markerOf(c.body);
    if (!m || !['spec', 'plan', 'go-signal'].includes(m.key)) continue;
    const key = `${m.key}:${m.id}`;
    byMarker.set(key, [...(byMarker.get(key) ?? []), c]);
  }
  const known = new Set();
  for (const doc of documents.filter((d) => d.post_state === 'POSTED')) {
    const key = versionMarker(doc);
    known.add(key);
    const found = byMarker.get(key) ?? [];
    const mayBeGone = doc.deleted_at || doc.approved_at || doc.superseded_at;
    const where = `${issueOf(doc.external_ref)} ${doc.kind} v${doc.version} (row ${doc.id})`;
    if (found.length > 1) failures.push(`${where}: ${found.length} comments`);
    else if (found.length === 0 && !mayBeGone)
      failures.push(`${where}: no comment`);
    else if (
      found.length === 1 &&
      found[0].updatedAt === found[0].createdAt &&
      found[0].body !== doc.body
    )
      failures.push(`${where}: comment ${found[0].id} isn't its stored body`);
  }
  for (const [key, found] of byMarker)
    if (!known.has(key))
      failures.push(
        `comment ${found[0].id} on #${found[0].number}: ${key} has no POSTED row`,
      );
  return failures;
}

/**
 * 2. Every approved version's `/approve` comment was created after its version's comment (GitHub's second: the same
 * second counts); no version is approved twice; no run has two approved Specs or two approved Plans still current.
 */
export function checkApprovals({ documents, comments }) {
  const failures = [];
  const byId = new Map(comments.map((c) => [c.id, c]));
  const approved = documents.filter((d) => d.approved_at);
  for (const doc of approved) {
    const where = `${issueOf(doc.external_ref)} ${doc.kind} v${doc.version} (row ${doc.id})`;
    const approve = byId.get(doc.approve_comment_id);
    if (!approve)
      failures.push(
        `${where}: its /approve comment ${doc.approve_comment_id} isn't on the issue`,
      );
    else if (at(approve.createdAt) < at(doc.posted_at))
      failures.push(
        `${where}: /approve ${approve.id} was written before the version`,
      );
  }
  const count = (key) => {
    const seen = new Map();
    for (const doc of approved) {
      const k = key(doc);
      if (k !== null) seen.set(k, [...(seen.get(k) ?? []), doc]);
    }
    return [...seen.values()].filter((docs) => docs.length > 1);
  };
  for (const docs of count((d) => `${d.run_id}:${d.kind}:${d.version}`))
    failures.push(
      `${issueOf(docs[0].external_ref)} ${docs[0].kind} v${docs[0].version}: approved twice`,
    );
  for (const docs of count((d) =>
    d.superseded_at ? null : `${d.run_id}:${d.kind}`,
  ))
    failures.push(
      `${issueOf(docs[0].external_ref)}: ${docs.length} approved ${docs[0].kind}s still current (rows ${docs.map((d) => d.id).join(', ')})`,
    );
  return failures;
}

/**
 * 3. Every `/approve`, `/refresh`, `/restore` comment and every deleted waiting document got at most one answer: a
 * reply naming it, a warning reply to its approval, or a version it made.
 */
export function checkOneAnswer({ documents, comments }) {
  const failures = [];
  const answers = new Map();
  const add = (id, what) => answers.set(id, [...(answers.get(id) ?? []), what]);
  const deletions = new Map();
  for (const c of comments.filter((c) => c.bot)) {
    const m = markerOf(c.body);
    if (!m) continue;
    if (ANSWER_KEYS.has(m.key)) add(m.id, `${m.key} reply ${c.id}`);
    if (m.key === 'approve-warning') {
      const doc = documents.find((d) => d.id === m.id);
      if (doc?.approve_comment_id)
        add(doc.approve_comment_id, `warning reply ${c.id}`);
    }
    if (m.key === 'doc-deleted')
      deletions.set(m.id, [...(deletions.get(m.id) ?? []), c]);
  }
  for (const doc of documents)
    if (doc.trigger_comment_id)
      add(
        doc.trigger_comment_id,
        `${doc.kind} v${doc.version} (row ${doc.id})`,
      );
  for (const c of comments.filter(
    (c) => !c.bot && COMMANDS.has(c.body.trim().toLowerCase()),
  )) {
    const got = answers.get(c.id) ?? [];
    if (got.length > 1)
      failures.push(
        `#${c.number} ${c.body.trim()} ${c.id}: ${got.length} answers (${got.join('; ')})`,
      );
  }
  for (const [id, found] of deletions)
    if (found.length > 1)
      failures.push(
        `#${found[0].number} deleted comment ${id}: ${found.length} explanations`,
      );
  return failures;
}

/**
 * 4. Every `approve-warning` answers an approved `/approve` of the last document before code (`spec-code`'s Spec,
 * `full-sdd`'s Plan) whose `stale_files` isn't empty, or whose comparison failed; every warning comment has its row.
 */
export function checkWarnings({ documents, actions, runs, comments }) {
  const failures = [];
  const warnings = actions.filter((a) => a.action === 'approve-warning');
  for (const a of warnings) {
    const doc = documents.find((d) => d.id === a.document_id);
    const run = runs.find((r) => r.id === doc?.run_id);
    const where = `${issueOf(a.external_ref)} warning ${a.id}`;
    if (!doc || !doc.approved_at) {
      failures.push(`${where}: its document isn't approved`);
      continue;
    }
    if (doc.approve_comment_id !== a.source_comment_id)
      failures.push(
        `${where}: answers ${a.source_comment_id}, the approval was ${doc.approve_comment_id}`,
      );
    const last =
      doc.kind === 'plan' || (doc.kind === 'spec' && run?.lane === 'spec-code');
    if (!last)
      failures.push(
        `${where}: ${doc.kind} v${doc.version} isn't the last document before code`,
      );
    if (a.result === 'stale' && (doc.stale_files ?? []).length === 0)
      failures.push(`${where}: stale, but no stale files`);
    if (a.result === 'not-compared' && doc.changed_complete !== null)
      failures.push(`${where}: not compared, but the approval compared`);
  }
  for (const c of comments.filter((c) => c.bot)) {
    const m = markerOf(c.body);
    if (
      m?.key === 'approve-warning' &&
      !warnings.some((a) => a.document_id === m.id)
    )
      failures.push(
        `comment ${c.id} on #${c.number}: a warning with no approve-warning row`,
      );
  }
  return failures;
}

/** 5. No comment and no `execution_logs` prompt contains the sandbox `CLAUDE.md`'s canary text. */
export function checkCanary({ comments, logs, canary }) {
  const failures = [];
  for (const c of comments)
    if (c.body.includes(canary))
      failures.push(`comment ${c.id} on #${c.number}`);
  for (const log of logs)
    if (String(log.prompt ?? '').includes(canary))
      failures.push(
        `execution_logs ${log.id} (${issueOf(log.external_ref)}, ${log.step})`,
      );
  return failures;
}

/** 6. Every Spec and Plan comment has at most 65,536 characters and its document at most 50,000. */
export function checkSizes({ comments }) {
  const failures = [];
  for (const c of comments.filter((c) => c.bot)) {
    const m = markerOf(c.body);
    if (!m || (m.key !== 'spec' && m.key !== 'plan')) continue;
    if (c.body.length > COMMENT_MAX_CHARS)
      failures.push(
        `#${c.number} ${m.key} comment ${c.id}: ${c.body.length} characters`,
      );
    const doc = documentTextOf(c.body).length;
    if (doc > DOCUMENT_MAX_CHARS)
      failures.push(
        `#${c.number} ${m.key} comment ${c.id}: its document has ${doc} characters`,
      );
  }
  return failures;
}

/**
 * 7. Every successful `spec` and `plan` call (by `call_id`, its last row `SUCCESS`; failed calls are left out)
 * belongs to a version (`log_id`) or to a `/refresh` row (`log_ids`).
 */
export function checkCalls({ documents, actions, logs }) {
  const failures = [];
  const owned = new Set([
    ...documents.map((d) => d.log_id).filter(Boolean),
    ...actions
      .filter((a) => a.action === 'refresh')
      .flatMap((a) => a.log_ids ?? []),
  ]);
  const calls = new Map();
  for (const log of logs.filter(
    (l) => l.step === 'spec' || l.step === 'plan',
  )) {
    if (String(log.run_id ?? '').startsWith('smoke-')) continue;
    const last = calls.get(log.call_id);
    if (!last || log.turn > last.turn) calls.set(log.call_id, log);
  }
  for (const [callId, last] of calls)
    if (last.status === 'SUCCESS' && !owned.has(last.id))
      failures.push(
        `${issueOf(last.external_ref)} ${last.step} call ${callId} (row ${last.id}): no version or /refresh row`,
      );
  return failures;
}

/** 8. No `workspace` step ran without the run's last document before code approved. */
export function checkWorkspace({ documents, runs }) {
  const failures = [];
  const lastKind = {
    'full-sdd': 'plan',
    'spec-code': 'spec',
    'code-only': 'go-signal',
  };
  for (const run of runs.filter((r) => r.stop_step === 'workspace')) {
    const kind = lastKind[run.lane];
    if (
      !documents.some(
        (d) => d.run_id === run.id && d.kind === kind && d.approved_at,
      )
    )
      failures.push(
        `${issueOf(run.external_ref)} run ${run.number} (${run.lane}): the workspace step ran with no approved ${kind}`,
      );
  }
  return failures;
}

export const INVARIANTS = [
  [
    '1 every POSTED version has exactly one comment with its marker, whose text is its body',
    checkVersionComments,
  ],
  [
    '2 every /approve came after its version; none approved twice; one approved Spec and Plan per run',
    checkApprovals,
  ],
  [
    '3 every /approve, /refresh, /restore and deleted document got at most one answer',
    checkOneAnswer,
  ],
  [
    '4 every warning reply answers an approved /approve of the last document, stale or not compared',
    checkWarnings,
  ],
  ['5 no comment and no prompt holds the CLAUDE.md canary', checkCanary],
  [
    '6 every Spec and Plan comment fits (65,536) and its document too (50,000)',
    checkSizes,
  ],
  [
    '7 every successful spec and plan call belongs to a version or a /refresh row',
    checkCalls,
  ],
  ['8 no workspace step without the last document approved', checkWorkspace],
];

/** Every check over the data: `[{ name, failures }]`. */
export function runChecks(data) {
  return INVARIANTS.map(([name, check]) => ({ name, failures: check(data) }));
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--canary');
  const canary = at >= 0 ? args[at + 1] : 'PINEAPPLE';
  const issues = args
    .filter((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--canary')
    .map(Number);
  const REPO = process.env.TARGET_REPO;
  if (!REPO || !process.env.DATABASE_URL || issues.length === 0) {
    console.error(
      'Usage: node --env-file-if-exists=.env scripts/spec-plan-approvals-invariants.mjs <issue>… [--canary <text>]',
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
  const [{ live }] = await q(
    'SELECT min(created_at) AS live FROM task_documents',
  );
  if (live === null) {
    console.error('No task_documents rows: nothing to check yet.');
    process.exit(1);
  }
  const inRepo = `${REPO}#%`;
  const documents = await q(
    `SELECT d.*, t.external_ref FROM task_documents d JOIN tasks t ON t.id = d.task_id
     WHERE d.created_at >= $1 AND t.external_ref LIKE $2 ORDER BY d.created_at`,
    [live, inRepo],
  );
  const actions = await q(
    `SELECT a.*, t.external_ref FROM document_actions a JOIN tasks t ON t.id = a.task_id
     WHERE a.created_at >= $1 AND t.external_ref LIKE $2 ORDER BY a.created_at`,
    [live, inRepo],
  );
  const runs = await q(
    `SELECT r.*, t.external_ref FROM runs r JOIN tasks t ON t.id = r.task_id
     WHERE r.started_at >= $1 AND t.external_ref LIKE $2`,
    [live, inRepo],
  );
  const logs = await q(
    `SELECT id, call_id, turn, status, step, run_id, external_ref, prompt::text AS prompt FROM execution_logs
     WHERE created_at >= $1 AND external_ref LIKE $2`,
    [live, inRepo],
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
        {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        },
      ),
    ).flat();
    for (const c of pages)
      comments.push({
        number,
        id: String(c.id),
        body: c.body ?? '',
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        bot: c.user?.type === 'Bot',
      });
  }
  console.log(
    `since ${live.toISOString()}: ${documents.length} versions, ${actions.length} actions, ${runs.length} runs, ` +
      `${logs.length} execution_logs rows; ${comments.length} comments on ${issues.length} issues`,
  );
  const results = runChecks({
    documents,
    actions,
    runs,
    logs,
    comments,
    canary,
  });
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
