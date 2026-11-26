// Spec 13 (bot-feedback) verification matrix, "Invariants": the four invariants over the issues given. Created
// 2026-11-27 for plan Task 12 (BFW14, FP22, FP24: the checks are pure functions, exported for
// scripts/bot-feedback-invariants.spec.mjs).
//
// A developer check, not part of the bot: read-only SELECTs on the dev database (`DATABASE_URL`) and `gh api` GETs
// with the developer's own `gh` login on `TARGET_REPO` (labels, comments, each human comment's reactions). Run it with
// the app idle. Exits 1 if any invariant fails.
//
//   node --env-file-if-exists=.env scripts/bot-feedback-invariants.mjs <issue>…
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const WORKING_LABEL = 'bot: working';
const at = (value) => new Date(value).getTime();
const issueOf = (ref) => `#${String(ref).split('#')[1]}`;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** 1. No issue given carries `bot: working`, and no task of them has a mark. */
export function checkNoWorkingSign({ issues, tasks }) {
  const failures = [];
  for (const issue of issues)
    if (issue.labels.some((label) => same(label, WORKING_LABEL)))
      failures.push(`#${issue.number}: still labelled \`${WORKING_LABEL}\``);
  for (const task of tasks)
    if (task.working_event_id)
      failures.push(
        `${issueOf(task.external_ref)}: tasks.working_event_id = ${task.working_event_id}`,
      );
  return failures;
}

const botReactions = (comment, content) =>
  (comment.reactions ?? []).filter((r) => r.bot && r.content === content);

/** 2. No comment carries both 🚀 and 👀 by the bot (spec 13 BF8: the 👀 replaces the bot's 🚀). */
export function checkRocketOrEyes({ comments }) {
  const failures = [];
  for (const comment of comments)
    if (
      botReactions(comment, 'rocket').length > 0 &&
      botReactions(comment, 'eyes').length > 0
    )
      failures.push(
        `#${comment.number}: comment ${comment.id} has the bot's 🚀 and 👀`,
      );
  return failures;
}

/** A `/retry` comment (spec 5: the first line, any letter case). */
const isRetry = (body) =>
  /^\/retry\s*$/i.test((body ?? '').split('\n')[0].trim());

/**
 * 3. Every 🚀 by the bot is on a comment whose event (`webhook_events`, by the comment id in its payload) has
 * `execution_logs` rows of the same issue within its own `working_started_at` … `working_ended_at` (plan FP24), or
 * is an accepted `/retry` (BF10: a `/retry` whose event isn't `IGNORED` `retry-refused`).
 */
export function checkRockets({ comments, events, logs }) {
  const failures = [];
  for (const comment of comments.filter(
    (c) => botReactions(c, 'rocket').length > 0,
  )) {
    const where = `#${comment.number}: 🚀 on comment ${comment.id}`;
    const own = events.filter((e) => e.comment_id === comment.id);
    if (own.length === 0) {
      failures.push(`${where}: no stored event for it`);
      continue;
    }
    if (isRetry(comment.body)) {
      if (
        own.some(
          (e) =>
            !(e.status === 'IGNORED' && e.ignore_reason === 'retry-refused'),
        )
      )
        continue;
      failures.push(`${where}: a refused /retry`);
      continue;
    }
    const worked = own.some(
      (e) =>
        e.working_started_at &&
        e.working_ended_at &&
        logs.some(
          (l) =>
            l.external_ref === e.external_ref &&
            at(l.created_at) >= at(e.working_started_at) &&
            at(l.created_at) <= at(e.working_ended_at),
        ),
    );
    if (!worked)
      failures.push(
        `${where}: its event has no execution_logs row in its own working window`,
      );
  }
  return failures;
}

/** 4. No `full-sdd` issue shows `status: ready-for-dev` while its current Plan isn't approved (D33). */
export function checkReadyMeansApproved({ issues, tasks }) {
  const failures = [];
  for (const issue of issues) {
    if (!issue.labels.some((label) => same(label, 'status: ready-for-dev')))
      continue;
    const task = tasks.find(
      (t) => issueOf(t.external_ref) === `#${issue.number}`,
    );
    if (task?.lane === 'full-sdd' && task.plan_approved === false)
      failures.push(
        `#${issue.number}: \`status: ready-for-dev\` while its current Plan waits for /approve`,
      );
  }
  return failures;
}

export const INVARIANTS = [
  ['1 no issue carries bot: working, no task has a mark', checkNoWorkingSign],
  ["2 no comment carries both the bot's 🚀 and 👀", checkRocketOrEyes],
  [
    '3 every bot 🚀 is on an event that called the model in its own working window, or an accepted /retry',
    checkRockets,
  ],
  [
    '4 no full-sdd issue shows ready-for-dev while its current Plan is not approved',
    checkReadyMeansApproved,
  ],
];

/** Every check over the data: `[{ name, failures }]`. */
export function runChecks(data) {
  return INVARIANTS.map(([name, check]) => ({ name, failures: check(data) }));
}

function gh(path) {
  return JSON.parse(
    execFileSync('gh', ['api', '--paginate', '--slurp', path], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  ).flat();
}

async function main() {
  const numbers = process.argv
    .slice(2)
    .filter((a) => /^\d+$/.test(a))
    .map(Number);
  const REPO = process.env.TARGET_REPO;
  if (!REPO || !process.env.DATABASE_URL || numbers.length === 0) {
    console.error(
      'Usage: node --env-file-if-exists=.env scripts/bot-feedback-invariants.mjs <issue>…',
    );
    console.error(
      'TARGET_REPO and DATABASE_URL must be set (run from the bot repo; .env is loaded).',
    );
    process.exit(1);
  }
  const refs = numbers.map((n) => `${REPO}#${n}`);

  const issues = [];
  const comments = [];
  for (const number of numbers) {
    const [issue] = gh(`repos/${REPO}/issues/${number}`);
    issues.push({ number, labels: issue.labels.map((l) => l.name) });
    for (const c of gh(
      `repos/${REPO}/issues/${number}/comments?per_page=100`,
    )) {
      const bot = c.user?.type === 'Bot';
      const reactions = bot
        ? []
        : gh(
            `repos/${REPO}/issues/comments/${c.id}/reactions?per_page=100`,
          ).map((r) => ({ content: r.content, bot: r.user?.type === 'Bot' }));
      comments.push({
        number,
        id: String(c.id),
        body: c.body ?? '',
        bot,
        reactions,
      });
    }
  }

  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const tasks = await q(
    `SELECT t.external_ref, t.working_event_id, t.status, r.lane,
       (SELECT d.approved_at IS NOT NULL FROM task_documents d
        WHERE d.run_id = r.id AND d.kind = 'plan' AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC LIMIT 1) AS plan_approved
     FROM tasks t LEFT JOIN runs r ON r.id = t.current_run_id
     WHERE t.external_ref = ANY($1)`,
    [refs],
  );
  const events = await q(
    `SELECT id, external_ref, payload->'comment'->>'id' AS comment_id, status, ignore_reason,
       working_started_at, working_ended_at
     FROM webhook_events
     WHERE external_ref = ANY($1) AND event_name = 'issue_comment' AND action = 'created'`,
    [refs],
  );
  const logs = await q(
    `SELECT external_ref, created_at FROM execution_logs WHERE external_ref = ANY($1)`,
    [refs],
  );
  await db.end();

  const data = { issues, tasks, comments, events, logs };
  console.log(
    `${issues.length} issues, ${comments.length} comments, ${events.length} comment events, ${logs.length} model rows`,
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
