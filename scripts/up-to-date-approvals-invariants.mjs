// Spec 14 (up-to-date-approvals) verification matrix, "Invariants": the four invariants over the rows stored since
// spec 14 went live (the `finished_at` of its migration) and over the comments of the issues given. Created
// 2026-11-24 for plan Task 8 (UAW11: the checks are pure functions, exported for
// scripts/up-to-date-approvals-invariants.spec.mjs).
//
// A developer check, not part of the bot: read-only SELECTs on the dev database (`DATABASE_URL`) and `gh api` GETs
// with the developer's own `gh` login on `TARGET_REPO`. Exits 1 if any invariant fails.
//
//   node --env-file-if-exists=.env scripts/up-to-date-approvals-invariants.mjs <issue>…
//
//   <issue>…  every issue of the run. Invariants 1 and 4 read every row since spec 14 went live and the comments of
//             these issues only, so a wrong list fails; 2 and 3 read only these issues' rows (plan UP20: the dev bot
//             ran spec 7's approval code between the migration and the question's build).
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DOCUMENT_START = '<!-- sdd-agent:document -->';
/** The default of `APPROVAL_LARGE_CHANGE_FILES` (spec 14, UAW5). */
export const DEFAULT_LARGE_CHANGE = 15;

/** A bot comment's hidden marker (its first line): `{ key, id }`, e.g. `approve-asked:<commentId>`; null without one. */
export function markerOf(body) {
  const match = /^<!-- sdd-agent:([a-z-]+):(\S+?) -->/.exec(body ?? '');
  return match ? { key: match[1], id: match[2].split(':')[0] } : null;
}

const issueOf = (ref) => `#${String(ref).split('#')[1]}`;
const at = (value) => new Date(value).getTime();

/** The bot comments that answer a person's comment, by that comment's id (their marker names it). */
function repliesByComment(comments) {
  const replies = new Map();
  for (const c of comments.filter((c) => c.bot)) {
    const m = markerOf(c.body);
    if (!m) continue;
    replies.set(m.id, [...(replies.get(m.id) ?? []), { ...c, key: m.key }]);
  }
  return replies;
}

/**
 * 1. Every `approve-asked` row answers an `/approve` that approved nothing (no `approve_comment_id` equals its
 * `source_comment_id`) and got no other reply (no other row, no other bot comment naming it), and its reply was
 * posted exactly once.
 */
export function checkQuestions({ actions, documents, comments }) {
  const failures = [];
  const approvedBy = new Set(
    documents.map((d) => d.approve_comment_id).filter(Boolean),
  );
  const replies = repliesByComment(comments);
  for (const q of actions.filter((a) => a.action === 'approve-asked')) {
    const where = `${issueOf(q.external_ref)} question ${q.id} (/approve ${q.source_comment_id})`;
    if (approvedBy.has(q.source_comment_id))
      failures.push(`${where}: that /approve approved a document`);
    const others = actions.filter(
      (a) => a.source_comment_id === q.source_comment_id && a.id !== q.id,
    );
    for (const other of others)
      failures.push(`${where}: also answered by ${other.action} ${other.id}`);
    const posted = replies.get(q.source_comment_id) ?? [];
    const own = posted.filter((c) => c.key === 'approve-asked');
    for (const c of posted.filter((c) => c.key !== 'approve-asked'))
      failures.push(`${where}: another reply, ${c.key} comment ${c.id}`);
    if (q.reply_post_state !== 'POSTED')
      failures.push(`${where}: reply ${q.reply_post_state ?? 'not stored'}`);
    if (own.length !== 1)
      failures.push(`${where}: ${own.length} question comments`);
  }
  return failures;
}

/** Why an approved Spec or Plan needed a question first (spec 14), or null. */
function staleReason(doc, threshold) {
  if (doc.stale_files?.length > 0)
    return `stale_files ${doc.stale_files.join(', ')}`;
  if (doc.changed_files !== null && doc.changed_files > threshold)
    return `${doc.changed_files} changed files`;
  if (doc.changed_complete === false) return 'a cut list';
  if (
    doc.changed_complete === null &&
    doc.approved_from_commit &&
    doc.approved_commit !== doc.approved_from_commit
  )
    return 'not compared';
  return null;
}

/**
 * 2. Every Spec or Plan approved since spec 14 went live with `stale_files` not empty, `changed_files` above the
 * threshold, `changed_complete` false, or not compared (`changed_complete` empty while `approved_commit` differs from
 * `approved_from_commit`) has an `approve-asked` row for its version whose reply was posted no later than the
 * approving `/approve` was written (GitHub's second: the same second counts).
 */
export function checkStaleApprovals({
  documents,
  actions,
  comments,
  threshold,
}) {
  const failures = [];
  const byId = new Map(comments.map((c) => [c.id, c]));
  for (const doc of documents.filter(
    (d) => d.approved_at && (d.kind === 'spec' || d.kind === 'plan'),
  )) {
    const reason = staleReason(doc, threshold);
    if (!reason) continue;
    const where = `${issueOf(doc.external_ref)} ${doc.kind} v${doc.version} (row ${doc.id}, ${reason})`;
    const approve = byId.get(doc.approve_comment_id);
    if (!approve) {
      failures.push(
        `${where}: its /approve ${doc.approve_comment_id} isn't on the issues given`,
      );
      continue;
    }
    const asked = actions.some(
      (a) =>
        a.action === 'approve-asked' &&
        a.document_id === doc.id &&
        a.reply_posted_at &&
        at(a.reply_posted_at) <= at(approve.createdAt),
    );
    if (!asked)
      failures.push(
        `${where}: approved by /approve ${approve.id} with no question posted before it`,
      );
  }
  return failures;
}

/** 3. No `approve-warning` row, and no Plan comment (or stored Plan body) with a ⚠️ line in its header. */
export function checkNoWarnings({ actions, documents, comments }) {
  const failures = [];
  for (const a of actions.filter((a) => a.action === 'approve-warning'))
    failures.push(`${issueOf(a.external_ref)}: approve-warning row ${a.id}`);
  const header = (body) => body.split(DOCUMENT_START)[0];
  for (const c of comments.filter(
    (c) => c.bot && markerOf(c.body)?.key === 'plan',
  ))
    if (header(c.body).includes('⚠️'))
      failures.push(`#${c.number}: Plan comment ${c.id} has a ⚠️ line`);
  for (const d of documents.filter((d) => d.kind === 'plan'))
    if (header(d.body).includes('⚠️'))
      failures.push(
        `${issueOf(d.external_ref)} plan v${d.version} (row ${d.id}): a ⚠️ line in its body`,
      );
  return failures;
}

/**
 * 4. Every `before-question` reply answers an `/approve` written before a question of its version that was posted
 * before that reply.
 */
export function checkBeforeQuestion({ actions, comments }) {
  const failures = [];
  const byId = new Map(comments.map((c) => [c.id, c]));
  for (const r of actions.filter(
    (a) => a.action === 'approve-refused' && a.result === 'before-question',
  )) {
    const where = `${issueOf(r.external_ref)} before-question ${r.id} (/approve ${r.source_comment_id})`;
    const approve = byId.get(r.source_comment_id);
    if (!approve) {
      failures.push(`${where}: the /approve isn't on the issues given`);
      continue;
    }
    const replied = at(r.reply_posted_at ?? r.created_at);
    const question = actions.some(
      (q) =>
        q.action === 'approve-asked' &&
        q.document_id === r.document_id &&
        q.reply_posted_at &&
        at(approve.createdAt) < at(q.reply_posted_at) &&
        at(q.reply_posted_at) <= replied,
    );
    if (!question)
      failures.push(
        `${where}: no question of its version posted after the /approve and before the reply`,
      );
  }
  return failures;
}

export const INVARIANTS = [
  [
    '1 every question answers an /approve that approved nothing, with no other reply, posted once',
    (data) =>
      checkQuestions({
        ...data,
        actions: data.allActions,
        documents: data.allDocuments,
      }),
  ],
  [
    '2 every stale approval had a question posted before its /approve',
    checkStaleApprovals,
  ],
  ['3 no approve-warning row, no ⚠️ line in a Plan header', checkNoWarnings],
  [
    '4 every before-question reply answers an /approve written before a question',
    (data) => checkBeforeQuestion({ ...data, actions: data.allActions }),
  ],
];

/**
 * Every check over the data: `[{ name, failures }]`. `allActions` and `allDocuments`: every row since spec 14 went
 * live; `actions` and `documents`: the given issues' rows only (UP20); `comments`: the given issues' comments.
 */
export function runChecks(data) {
  return INVARIANTS.map(([name, check]) => ({ name, failures: check(data) }));
}

async function main() {
  const issues = process.argv
    .slice(2)
    .filter((a) => /^\d+$/.test(a))
    .map(Number);
  const REPO = process.env.TARGET_REPO;
  if (!REPO || !process.env.DATABASE_URL || issues.length === 0) {
    console.error(
      'Usage: node --env-file-if-exists=.env scripts/up-to-date-approvals-invariants.mjs <issue>…',
    );
    console.error(
      'TARGET_REPO and DATABASE_URL must be set (run from the bot repo; .env is loaded).',
    );
    process.exit(1);
  }
  const threshold = Number(
    process.env.APPROVAL_LARGE_CHANGE_FILES || DEFAULT_LARGE_CHANGE,
  );
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const [migration] = await q(
    `SELECT finished_at AS live FROM _prisma_migrations
     WHERE migration_name LIKE '%\\_up\\_to\\_date\\_approvals' AND finished_at IS NOT NULL`,
  );
  if (!migration) {
    console.error(
      'Spec 14 is not live: its migration is not applied (npm run db:migrate).',
    );
    process.exit(1);
  }
  const { live } = migration;
  const inRepo = `${REPO}#%`;
  const allDocuments = await q(
    `SELECT d.*, t.external_ref FROM task_documents d JOIN tasks t ON t.id = d.task_id
     WHERE (d.created_at >= $1 OR d.approved_at >= $1) AND t.external_ref LIKE $2 ORDER BY d.created_at`,
    [live, inRepo],
  );
  const allActions = await q(
    `SELECT a.*, t.external_ref FROM document_actions a JOIN tasks t ON t.id = a.task_id
     WHERE a.created_at >= $1 AND t.external_ref LIKE $2 ORDER BY a.created_at`,
    [live, inRepo],
  );
  await db.end();

  const given = new Set(issues.map((n) => `${REPO}#${n}`));
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
        createdAt: c.created_at,
        bot: c.user?.type === 'Bot',
      });
  }
  const data = {
    allDocuments,
    allActions,
    documents: allDocuments.filter(
      (d) => given.has(d.external_ref) && d.approved_at >= live,
    ),
    actions: allActions.filter((a) => given.has(a.external_ref)),
    comments,
    threshold,
  };
  console.log(
    `since ${live.toISOString()}: ${allDocuments.length} versions, ${allActions.length} actions ` +
      `(${data.actions.length} on the issues given); ${comments.length} comments on ${issues.length} issues; ` +
      `APPROVAL_LARGE_CHANGE_FILES ${threshold}`,
  );
  const results = runChecks(data);
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
