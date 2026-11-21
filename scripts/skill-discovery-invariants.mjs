// Spec 11 (skill-discovery) verification matrix, "Invariants": checks the seven invariants over everything stored
// since the build went live (the first `context_loads` row) and over the bot's comments on the target repo's issues.
// Created 2026-11-21 for plan Task 24 (moved here from a scratch file the same day).
//
// A developer check, not part of the bot: read-only SELECTs on the dev database (`DATABASE_URL`) and `gh api` GETs
// with the developer's own `gh` login on `TARGET_REPO`. Exits 1 if any invariant fails.
//
//   node --env-file-if-exists=.env scripts/skill-discovery-invariants.mjs \
//     [--broken <sha,…>] [--max1 <issue,…>] [--from <issue>]
//
//   --broken  full commit SHAs where a skill broke the header rule (SD12): no model call may run at them
//             (the head of smoke/spec-11-bad-skills, a merged description removal)
//   --max1    issues whose first evaluation ran with SKILL_DISCOVERY_MAX_LOADS=1 (later calls: the .env limit)
//   --from    the first issue number to check (default: the lowest issue with a run or a model call since the build
//             went live)
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const args = process.argv.slice(2);
const arg = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const list = (name) => (arg(name) ?? '').split(',').filter(Boolean);
const REPO = process.env.TARGET_REPO;
if (!REPO || !process.env.DATABASE_URL) {
  console.error(
    'TARGET_REPO and DATABASE_URL must be set (run from the bot repo; .env is loaded).',
  );
  process.exit(1);
}
const BROKEN = new Set(list('broken'));
const MAX1 = new Set(list('max1').map(Number));
const LIMIT = Number(process.env.SKILL_DISCOVERY_MAX_LOADS ?? 10);

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
/** Every item of a paginated `gh api` list. */
const gh = (path) =>
  JSON.parse(
    execFileSync('gh', ['api', '--paginate', '--slurp', path], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  ).flat();
const issueNumber = (ref) => Number(ref.split('#')[1]);

const results = [];
const check = (name, failures, detail) => {
  results.push({ name, ok: failures.length === 0 });
  console.log(
    `${failures.length === 0 ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`,
  );
  for (const failure of failures.slice(0, 10)) console.log(`     ${failure}`);
  if (failures.length > 10) console.log(`     … ${failures.length - 10} more`);
};

const [{ live }] = await q('SELECT min(created_at) AS live FROM context_loads');
if (live === null) {
  console.error('No context_loads rows: nothing to check yet.');
  process.exit(1);
}
const loads = await q(
  'SELECT * FROM context_loads WHERE created_at >= $1 ORDER BY created_at, turn',
  [live],
);
const logs = await q(
  'SELECT * FROM execution_logs WHERE created_at >= $1 ORDER BY created_at, turn',
  [live],
);
const touched = await q(
  `SELECT t.external_ref FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.started_at >= $1
   UNION SELECT external_ref FROM execution_logs WHERE created_at >= $1`,
  [live],
);
const FROM = Number(
  arg('from') ??
    Math.min(
      ...touched
        .filter((row) => row.external_ref.startsWith(`${REPO}#`))
        .map((row) => issueNumber(row.external_ref)),
    ),
);
const evaluations = await q(
  `SELECT e.*, t.external_ref, l.call_id FROM grill_evaluations e JOIN grill_sessions s ON s.id = e.session_id
   JOIN tasks t ON t.id = s.task_id JOIN execution_logs l ON l.id = e.log_id WHERE e.created_at >= $1
   ORDER BY e.created_at`,
  [live],
);
const rounds = await q('SELECT * FROM grill_rounds WHERE created_at >= $1', [
  live,
]);
const runs = await q(
  `SELECT r.*, t.external_ref FROM runs r JOIN tasks t ON t.id = r.task_id
   WHERE split_part(t.external_ref, '#', 2)::int >= $1 ORDER BY r.started_at`,
  [FROM],
);

// The bot's comments on every issue of the target repo from #FROM on.
const issues = gh(`repos/${REPO}/issues?state=all&per_page=100`)
  .map((issue) => issue.number)
  .filter((number) => number >= FROM);
const comments = [];
for (const number of issues)
  for (const c of gh(`repos/${REPO}/issues/${number}/comments?per_page=100`))
    if (c.user.type === 'Bot')
      comments.push({ number, id: String(c.id), body: c.body ?? '' });
console.log(
  `since ${live.toISOString()}: ${loads.length} context_loads rows, ${logs.length} execution_logs rows, ` +
    `${evaluations.length} Grill evaluations, ${runs.length} runs; ${comments.length} bot comments on ` +
    `${issues.length} issues (#${Math.min(...issues)}–#${Math.max(...issues)})`,
);

// 1. PINEAPPLE (the sandbox's CLAUDE.md canary) and CLAUDE.md
{
  const failures = [];
  for (const log of logs) {
    if (JSON.stringify(log.prompt).includes('PINEAPPLE'))
      failures.push(`prompt of row ${log.id}`);
    if (JSON.stringify(log.answer ?? '').includes('PINEAPPLE'))
      failures.push(`answer of row ${log.id}`);
  }
  for (const c of comments)
    if (c.body.includes('PINEAPPLE'))
      failures.push(`comment ${c.id} on #${c.number}`);
  for (const row of loads) {
    if (JSON.stringify(row).includes('PINEAPPLE'))
      failures.push(`context_loads ${row.id}`);
    if (row.path?.endsWith('CLAUDE.md'))
      failures.push(`context_loads ${row.id} path ${row.path}`);
  }
  const asked = loads
    .filter((row) => row.requested?.endsWith('CLAUDE.md'))
    .map((row) => row.outcome);
  check(
    '1 no PINEAPPLE anywhere; no context_loads path ends in CLAUDE.md',
    failures,
    `CLAUDE.md requested ${asked.length}× (${asked.join(', ') || 'never'})`,
  );
}

// 2. Every "Read:" line lists exactly the call's loaded tool rows
const byCall = new Map();
for (const row of loads) {
  if (!byCall.has(row.call_id)) byCall.set(row.call_id, []);
  byCall.get(row.call_id).push(row);
}
/** The call's loaded tool rows as `skill:<name>:<rel>`, `step:<step>:<rel>` or `file:<path>`. */
function expectedFiles(callId) {
  const rows = byCall.get(callId) ?? [];
  const stepFile =
    rows.find((row) => row.trigger === 'start' && row.kind === 'step-skill')
      ?.path ?? '';
  const stepDir = stepFile.replace(/SKILL\.md$/, '');
  return rows
    .filter((row) => row.trigger === 'tool' && row.outcome === 'loaded')
    .map((row) => {
      if (row.kind === 'repo-skill') {
        const at = row.path.indexOf(`/${row.skill}/`);
        return `skill:${row.skill}:${row.path.slice(at + row.skill.length + 2)}`;
      }
      if (row.kind === 'step-skill')
        return `step:${row.skill}:${row.path.slice(stepDir.length)}`;
      return `file:${row.path}`;
    })
    .sort();
}
/** A "Read:" line's files in the same form; none for no line. */
function readFiles(line) {
  if (!line) return [];
  const text = line.replace(/^Read: /, '');
  const groups = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    if (depth === 0 && text.startsWith(', ', i)) {
      groups.push(text.slice(start, i));
      start = i + 2;
    }
  }
  groups.push(text.slice(start));
  const files = [];
  const inner = (names) => [...names.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  for (const group of groups) {
    let m;
    if ((m = /^skill `([^`]+)` \((.*)\)$/.exec(group)))
      files.push(...inner(m[2]).map((rel) => `skill:${m[1]}:${rel}`));
    else if ((m = /^the `([^`]+)` step skill \((.*)\)$/.exec(group)))
      files.push(...inner(m[2]).map((rel) => `step:${m[1]}:${rel}`));
    else if ((m = /^`([^`]+)`$/.exec(group))) files.push(`file:${m[1]}`);
    else files.push(`UNPARSED:${group}`);
  }
  return files.sort();
}
{
  const failures = [];
  let withRead = 0;
  for (const e of evaluations) {
    const line = e.notes.find((note) => note.startsWith('Read: '));
    if (line) withRead++;
    const got = readFiles(line).join(' ');
    const want = expectedFiles(e.call_id).join(' ');
    if (got !== want)
      failures.push(
        `evaluation ${e.id} (${e.external_ref}, ${e.result}): notes [${got}] vs rows [${want}]`,
      );
  }
  // Each posted comment's notes are its evaluation's notes.
  let commentsWithRead = 0;
  for (const c of comments) {
    const subs = [...c.body.matchAll(/^<sub>(.*)<\/sub>$/gm)].map((m) => m[1]);
    const read = subs.find((sub) => sub.startsWith('Read: '));
    if (!read && !subs.some((sub) => sub.startsWith('Model: '))) continue;
    if (read) commentsWithRead++;
    const round = rounds.find((r) => r.comment_id === c.id);
    const candidates = round
      ? evaluations.filter((e) => e.id === round.evaluation_id)
      : evaluations.filter(
          (e) =>
            `${REPO}#${c.number}` === e.external_ref &&
            e.notes.every((note) => subs.includes(note)) &&
            e.notes.length === subs.length,
        );
    if (candidates.length === 0) {
      // A smoke comment (check 7): never a "Read:" line (check 6 offers no tools).
      if (read)
        failures.push(
          `comment ${c.id} on #${c.number}: a "Read:" line with no evaluation`,
        );
      continue;
    }
    const eRead = candidates[0].notes.find((note) => note.startsWith('Read: '));
    if ((read ?? null) !== (eRead ?? null))
      failures.push(
        `comment ${c.id} on #${c.number}: "${read}" vs evaluation "${eRead}"`,
      );
  }
  check(
    '2 every "Read:" line lists exactly the call\'s loaded tool rows',
    failures,
    `${evaluations.length} evaluations, ${withRead} with a Read line; ${commentsWithRead} comments with one`,
  );
}

// 3. Loads per call within the limit; after a limit-reached, no later answer calls a tool
{
  const failures = [];
  let most = 0;
  let limitCalls = 0;
  const firstCallOf = new Map();
  for (const e of evaluations)
    if (!firstCallOf.has(e.external_ref))
      firstCallOf.set(e.external_ref, e.call_id);
  for (const [callId, rows] of byCall) {
    const counted = rows.filter(
      (row) => row.trigger === 'tool' && row.outcome !== 'limit-reached',
    ).length;
    most = Math.max(most, counted);
    const ref = rows[0].external_ref;
    const limit =
      MAX1.has(issueNumber(ref)) && firstCallOf.get(ref) === callId ? 1 : LIMIT;
    if (counted > limit)
      failures.push(
        `call ${callId} (${ref}): ${counted} counted loads, limit ${limit}`,
      );
    const limited = rows.filter((row) => row.outcome === 'limit-reached');
    if (limited.length === 0) continue;
    limitCalls++;
    const turn = Math.min(...limited.map((row) => row.turn));
    for (const log of logs.filter((l) => l.call_id === callId && l.turn > turn))
      if (/"tool_calls":\[[^\]]/.test(JSON.stringify(log.answer ?? {})))
        failures.push(
          `call ${callId} turn ${log.turn}: a tool call after the limit (turn ${turn})`,
        );
  }
  check(
    '3 no call over its load limit; no tool call after a limit-reached',
    failures,
    `${byCall.size} calls, at most ${most} counted loads in one; ${limitCalls} calls reached a limit`,
  );
}

// 4. Every context_loads.commit equals its call's execution_logs.skill_commit
{
  const failures = [];
  const commitOf = new Map();
  for (const log of logs)
    if (log.call_id) commitOf.set(log.call_id, log.skill_commit);
  for (const row of loads) {
    const commit = commitOf.get(row.call_id);
    if (commit === undefined) continue; // a call with no request row: counted below
    if (row.commit !== commit)
      failures.push(
        `context_loads ${row.id}: ${row.commit.slice(0, 7)} vs ${commit.slice(0, 7)}`,
      );
  }
  const orphan = [...byCall.keys()].filter((id) => !commitOf.has(id));
  check(
    "4 every context_loads.commit is its call's skill_commit",
    failures,
    `${orphan.length} calls with loads and no request row`,
  );
}

// 5. Every execution_logs row has a call_id; turn 1 holds a system message, no later turn does
{
  const failures = [];
  for (const log of logs) {
    if (!log.call_id) failures.push(`row ${log.id}: no call_id`);
    const types = (Array.isArray(log.prompt) ? log.prompt : []).map(
      (m) => m.type,
    );
    const system = types.includes('system');
    if (log.turn === 1 && !system)
      failures.push(`row ${log.id} turn 1: no system message`);
    if (log.turn > 1 && system)
      failures.push(`row ${log.id} turn ${log.turn}: a system message`);
  }
  const turns = logs.reduce(
    (acc, log) => ({ ...acc, [log.turn]: (acc[log.turn] ?? 0) + 1 }),
    {},
  );
  check(
    '5 every row has a call_id; only turn 1 holds a system message',
    failures,
    `rows by turn ${JSON.stringify(turns)}`,
  );
}

// 6. No step stopped because of a limit, an unknown skill or a token count
{
  const failures = [];
  const causes = {};
  for (const run of runs.filter((r) => r.stop_cause)) {
    const key = `${run.stop_cause}${run.stop_step ? ` at ${run.stop_step}` : ''}`;
    causes[key] = (causes[key] ?? 0) + 1;
    // A setup stop (`repoSkills folder not found`, `invalid skills`) is intended; these are the forbidden causes.
    const message = run.stop_message ?? '';
    if (
      /limit-reached|limit of|no skill named|looked for|countTokens|token count/i.test(
        message,
      ) &&
      !/round/i.test(message)
    )
      failures.push(`run ${run.number} of ${run.external_ref}: ${message}`);
  }
  const events = await q(
    `SELECT external_ref, status, last_error FROM webhook_events
     WHERE split_part(external_ref, '#', 2) ~ '^[0-9]+$' AND split_part(external_ref, '#', 2)::int >= $1
     AND last_error IS NOT NULL`,
    [FROM],
  );
  for (const e of events)
    if (/limit-reached|not-found|countTokens|token count/i.test(e.last_error))
      failures.push(`event ${e.external_ref}: ${e.last_error}`);
  check(
    '6 no stop from a limit, an unknown skill or a token count',
    failures,
    `stops: ${JSON.stringify(causes)}`,
  );
}

// 7. No Grill comment from a commit where a skill broke the header rule
{
  const failures = [];
  for (const log of logs)
    if (BROKEN.has(log.skill_commit))
      failures.push(
        `row ${log.id} (${log.step}, ${log.external_ref}) at ${log.skill_commit.slice(0, 7)}`,
      );
  for (const row of loads)
    if (BROKEN.has(row.commit))
      failures.push(`context_loads ${row.id} at ${row.commit.slice(0, 7)}`);
  check(
    '7 no model call (so no Grill comment) at a commit with a broken skill',
    failures,
    BROKEN.size === 0
      ? 'no --broken commits given'
      : `commits ${[...BROKEN].map((sha) => sha.slice(0, 7)).join(', ')}`,
  );
}

await db.end();
const failed = results.filter((r) => !r.ok).length;
console.log(
  failed === 0 ? 'Invariants: all passed.' : `Invariants: ${failed} failed.`,
);
process.exit(failed === 0 ? 0 : 1);
