# Implementation Plan — Spec #5: Router & Session Lease

> **Created:** 2026-11-16 · **Status:** approved 2026-11-16, not built (fresh-context review 2026-11-16, its 12
> findings applied the same day: see "Review"; Q1 answered yes and P1–P16 confirmed the same day)
>
> **Why this file exists:** turns the approved spec `docs/specs/spec-github-agent-router-session-lease.md` into
> ordered, verifiable tasks (skill `agent-skills:planning-and-task-breakdown`). The spec stays normative: this plan
> adds order, slicing and build-time decisions only. The task checklist lives here (repo placement rules override
> the skill's `tasks/todo.md`). It is the one plan for everything the spec changes, including the code that specs
> 1, 2 and 3 built (`src/events`, `src/intake`, `src/github`, the fakes).
>
> **Also read:** `docs/specs/spec-github-agent-architecture-overview.md` D1–D7, D13, D16, D18, D24–D26; §3
> (states, inputs, per-event pipeline, R1–R6, the transition table); §4; §6; §7 rules 5–7 and 17.

## Overview

Build `WorkflowModule` (`src/workflow`): the part between intake (spec 2's first step for a stored event: what is
it, and may this sender send it?) and the steps. It owns the `tasks` and `runs` tables, locks an issue with the
session lease, decides every transition with a pure `decide()`, starts, stops, cancels and restarts runs, answers
every action aimed at the bot, and lets later specs plug in their step handlers. Built in 23 tasks across 7
phases, after a Task 0 that writes this plan's decisions into the spec and the overview:

1. **Changes to what specs 1–3 built, and the two tables:** `SESSION_LEASE_SECONDS`, `UnifiedTask.open`,
   `/retry` at intake, the worker's `WAIT` / `failed()` / `requeue`, the migration.
2. **The pure core:** comment texts and markers, `decide()` for every row of overview §3.
3. **Services:** the session lease, the `tasks` / `runs` writers, the step-handler registry.
4. **The router on real events:** the processor replaces spec 2's placeholder; run start; failure →
   `needs-human`.
5. **`/retry`, cancel, restart, lane conflicts.**
6. **Closed issues, stale events, `npm run db:runs`.**
7. **Docs and the verification matrix.**

No step handler exists yet (specs 6–10), so every real run stops at its first step with `step-not-built` (RL1).
Real GitHub is reached at Checkpoints 3, 4 and 5 and in T23. You review the work and commit at each checkpoint (I
never commit). Every task ends with `npm run typecheck && npm run lint && npm test && npm run test:integration`
green.

## Build-time decisions (not in the spec; to confirm with this plan)

| # | Decision | Why |
|---|---|---|
| P1 | `StepNotBuiltError extends StepConfigError` (defined in `src/workflow`). The cause mapping checks it first (`step-not-built`), then `StepConfigError` (`step-config`). | The worker already fails a `StepConfigError` at once (RL4: `step-not-built` is permanent) and `src/events` must not import `src/workflow`. No contract change. |
| P2 | "The error happened after the lease was claimed" travels on the error itself: the router marks every error thrown after its claim with the task id, the step (P3), whether the event is a `/retry` and whether it is stale (a symbol property on the same object, so the worker's `instanceof` rules don't change). Staleness is computed from the database right after the claim; the pending side effects still run before the event ends `stale`. `failed()` acts only on a marked error; an error from intake has no mark and stays a silent `FAILED` (IA9). | `failed(event, error)` gets nothing else, and running intake again would call GitHub again. The mark lives for one call chain: no workflow state in memory. Without the stale flag, a stale event failing in the pending side effects would stop the run as its `stopEventId`; `/retry` would re-queue it, it would end `stale`, and the run would be left "running" with nothing to continue it. |
| P3 | The step a stop names: the handler's name while a handler runs; `run-start` from the run's creation until its first handler; otherwise (pending side effects, reading the issue, a reply, on a running run) the step the status waits on: `grilling` → `grill`, `spec-review` → `spec`, `ready-for-dev` → `plan` (`full-sdd`) or `go-signal` (`code-only`), `executing` → `code`, `in-review` → `qualityGate`, `draft` with a run → `run-start`. | The spec names only the handler and run-start cases. With spec 5 alone only `run-start` and first-step stops happen; the map matters from spec 6 on. |
| P4 | A step handler returns an outcome of overview §3 or nothing. The action from `decide()` names the handler calls (one or more, e.g. row 10: `grill` skip, then `spec`) and the status that follows when they return nothing (rows 10, 11, 13, 17). An outcome goes back into `decide()`. A work-result outcome (`LIMIT`, `WS_DIRTY`, `RED`, `INTERRUPTED` without a PR) carries the step's comment body; `decide()` turns it into a stop (not retryable, except `WS_DIRTY` if spec 8 decides it is, as the spec's "Agreed for later specs" leaves open; T0, 2026-11-16) and the router calls `NeedsHumanService.stop`. Steps never call `stop` themselves (recorded for specs 6, 8 and 9 in the spec's "Agreed for later specs"). | §3 "Inputs" has no outcome for "a document or the go-signal was posted", and a new input needs your OK. Steps still never call each other (D3). One stop path: if a step called `stop` and also returned `LIMIT`, the run would stop twice. |
| P5 | The closed-issue rules (RL9, RL19) are rows of `decide()`, checked first (`state.open`). The router still reads `open` from the one `getTaskDetails`. | Boundaries: "decide transitions only in `decide()`"; a cancel on a closed issue is a transition. One table of tests covers it. |
| P6 | Row 1 is "`ISSUE_OPENED` in `draft`, no status label shown yet (`shownStatus` null), no run so far" instead of "no `Task` row existed". A pending label is `shownStatus ≠ status`, except `draft` with `shownStatus` null (no label wanted: RLW5). | With "no row existed", a retried `opened` event (GitHub failing on `setStatusLabel`) finds the row and never sets the label. Only differs from the spec when a lane-conflict event came first: the `opened` then adds `status: draft` (harmless). |
| P7 | Every time the router compares comes from PostgreSQL's clock: `receivedAt` (`EventsService.enqueue` stores PostgreSQL's `now()`: found in T10 that Prisma fills `@default(now())` from Node's clock, not the database's), `startEventReceivedAt` (a copy), `stoppedAt` and the lease (`now()` in SQL). The lease claim and heartbeat are raw SQL updates. | Docker's VM clock and the Mac's can drift apart (after sleep); a `/retry` written right after a stop must never be judged "before the stop" because two clocks were compared. |
| P8 | The `/retry` restore and the re-queue commit in one transaction: `EventsService.requeue(eventId, tx?)` takes the router's transaction client. It re-queues the event if it ended `FAILED`, `IGNORED` or `DONE` (not while `PENDING` or `PROCESSING`), keeping `last_error`. | A crash between the two would leave a running run whose event is never processed (stuck), and the next `/retry` would say "isn't stopped". A redelivery of the stopped event (RL5's recovery path) ends it `IGNORED` `no-transition`; "`FAILED` only" would then make `/retry` re-queue nothing. Changes the spec's `requeue` line. |
| P9 | An accepted `/retry` whose job fails after its write (the label, the lane-conflict check, any later GitHub call) ends `FAILED` at once: the error is rethrown as a permanent `ProviderError` with the same message. The re-queued event completes the label first (pending side effect). | RL13 says it ends `FAILED`, silent. A worker retry would find the run no longer stopped and answer the person's accepted `/retry` with "isn't stopped" (or "written before the stop" after a new stop). |
| P10 | The failure hook finds the lease taken (only possible with two instances on one database): an error line in the log; the event stays `FAILED` only. | The hook can't wait. A redelivery of the event (IA13) runs it again. |
| P11 | Spec 2's intake suite keeps testing intake alone: `test/app.ts` gets an intake-only test processor (what the placeholder did) and `test/intake.integration.spec.ts` uses it; `startApp`'s `processor` option now replaces `WorkflowEventProcessor`. The router's suites boot the real processor. | Spec 2's 24 tests assert exact provider calls and `DONE`; they stay unchanged, and the router gets its own suites. |
| P12 | From T12 to T19 an accepted event whose action isn't built yet ends `IGNORED` `no-transition` with a log line `not built yet: <action>`. T19 makes the action switch exhaustive and removes the fallback. | Each task leaves a working app while the router's actions arrive one task at a time. |
| P13 | `npm run db:runs` is a `psql` query in `package.json`, like `db:events` and `db:usage`, not `scripts/db-runs.ts`. | No code to maintain. The spec's "Project structure" line changes. |
| P14 | The migration is created against the test database. Your dev database changes only when you run `npm run db:migrate`. | As in specs 1–4: I don't touch your dev data. It only creates two tables and their indexes. |
| P15 | `decide()` keys the rows on whether the issue has a current run, not on the status: with a current run, the pre-checks and rows 6–8 apply even in `draft`; rows 2–5 only without one. `RunService.create` refuses when `currentRunId` is set, except inside the restart transaction. On a closed issue, the current run's start event processed again ends `issue-closed`, silent (no "did nothing with `workflow: …`" reply). | A `draft` task with a current run is real: before the first step sets a status, after a crash, after `/retry` of a first-step stop, and for 5–35 s while `checkRun` or the warning retries a GitHub error (the lease is free between attempts). Keyed on the status, a lane event in that window would start run N+1 beside run N: two active runs. |
| P16 | Row 28 goes through `decide()` too: `failed()` builds the router state and acts on `decide(state, FAILED(cause, step, retry, stale))`, which stops only a running run, never for a `/retry` or a stale event. | Boundaries: "decide transitions only in `decide()`"; otherwise row 28's unit test covers code that never runs. |

## Dependency graph

```text
T0 spec + overview lines (on approval)
T1 SESSION_LEASE_SECONDS ─────────┐
T2 UnifiedTask.open ──────────────┤
T3 /retry at intake ──────────────┤
T4 worker: WAIT, failed(), requeue┤
T5 tasks + runs tables ───────────┴·········································· Checkpoint 1
T6 texts, markers, workflow errors ──────────────┐
T7 decide(): lanes, runs, closed ── T8 decide(): steps, failures, /retry
T9 session lease (T1, T5, T6) ── T10 Task/Run services (T4, T9)
T11 step-handler registry (T6) ··············································· Checkpoint 2
T12 processor replaces placeholder (T3, T4, T9, T10)
  └─ T13 read, decide, status label (T2, T7)
       └─ T14 run start + dispatch loop (T8, T11)
            └─ T15 failure → needs-human (T6) ······························· Checkpoint 3
T16 /retry ── T17 cancel + restart ── T18 lane-conflict reminder ············ Checkpoint 4
T19 closed issues ── T20 stale events ── T21 db:runs ························ Checkpoint 5
T22 docs ── T23 verification matrix ········································· Checkpoint 6
```

One session builds them in number order. T1–T5 are independent of each other, and so are T7 and T9; from T12 on
every task changes `router.service.ts`, so nothing else could run in parallel.

**Your part (the build stops for these):**

1. **After T5:** run `npm run db:migrate` (two new tables, `tasks` and `runs`; nothing existing changes).
   **Before Checkpoint 4** (Q2, Q3): run it once more (T17 adds `runs.end_event_id`; T18 replaces
   `tasks.lane_conflict_open` with `tasks.lane_conflict_lanes`).
2. **Checkpoints 3, 4, 5 and T23:** stop `npm run dev` (the tunnel stays). I run my instance on port 3000 with the
   dev database and its log in the scratchpad, as in spec 4's build. Then your GitHub UI steps on the sandbox
   (new issues `#A`–`#E`, labels, comments, close and reopen), one step per message.
3. **Before Checkpoint 3:** the sandbox branch `smoke/spec-4-missing-skill` (its `workflow.json` maps `plan` to a
   missing folder). I can't see it in your clone's remote branches; if it's gone on GitHub, you recreate it (one
   edit of `workflow.json`, as in spec 4).
4. **Every checkpoint:** you review and commit.

---

## Phase 1 — Changes to what specs 1–3 built, and the two tables

### Task 0: This plan's decisions in the spec and the overview (on approval, before any code)

**Description:** Boundaries: "change overview §3, §4 and §6 first when a row, a contract or a table changes". The
spec and overview lines that P4, P5, P6, P8, P13, P15, P16 and Q1 change, each with the date and the plan's
number, as spec 4's plan did for its P2 and P3.

**Acceptance criteria:**
- [x] Overview: §3 row 1 (P6) and the note on rows 2–8 (P15); §6 `Run` gains `endCommentId` (Q1); §1 row 5 "Depends on" gains
  4 (`checkRun`, the injection warning)
- [x] Spec: "Closed issues" (the check is `decide()`'s first rule, P5); "Task creation" (P6); "State and
  `decide()`" (P15, P16); the registry's "returns one outcome" (P4); `EventsService.requeue` (P8); "Owned tables"
  (Q1); "Project structure" (P13); "Agreed for later specs" (P4: specs 6, 8, 9 return the outcome with its body
  and never call `stop`; Q1: cancel hooks safe to call twice); the matrix row `#D` also accepts `IGNORED`
  `no-transition` (when `labeled` is received first, `opened` is neither stale nor row 1)

**Verification:**
- [ ] Manual: you read the diff of both documents

**Dependencies:** your approval of this plan
**Files:** `docs/specs/spec-github-agent-architecture-overview.md`,
`docs/specs/spec-github-agent-router-session-lease.md`
**Scope:** S

### Task 1: `SESSION_LEASE_SECONDS` in the env schema

**Description:** The variable joins `envSchema` (spec "Configuration"): integer ≥ 30, default 120. `.env.example`
gets it with a one-line comment.

**Acceptance criteria:**
- [x] `10`, `abc` and `30.5` → the startup error names `SESSION_LEASE_SECONDS`; unset → 120; `30` → accepted
  (unit)
- [x] `.env.example` lists it with its default

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass

**Dependencies:** None
**Files:** `src/config/env.schema.ts` (+ `.spec.ts`), `.env.example`
**Scope:** XS

### Task 2: `UnifiedTask.open` (spec 3's adapter and fake)

**Description:** `open: boolean` in `UnifiedTask` (overview §4 already has it). The GitHub adapter sets it from
`state === 'open'`; the in-memory fake gets `setOpen(task, open)`, default open. The fake's existing `calls` list
already records every `setStatusLabel` call (spec "Fakes").

**Acceptance criteria:**
- [x] The adapter maps `state: 'open'` → `true` and `state: 'closed'` → `false` (unit, fake fetch)
- [x] The fake answers `open: true` by default and `false` after `setOpen(task, false)` (unit)
- [x] `src/contracts/issue-provider.ts` matches overview §4's `UnifiedTask` line by line

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass

**Dependencies:** None
**Files:** `src/contracts/issue-provider.ts`, `src/github/github-issue.provider.ts` (+ `.spec.ts`),
`test/fakes/in-memory-issue-provider.ts` (+ `.spec.ts`)
**Scope:** S

### Task 3: `/retry` at intake

**Description:** `isRetryCommand(text)` beside `isApproveCommand` (whole comment, trimmed, lower case). Intake's
classify gets the row "`issue_comment` · `created`, the text is `/retry` → `RETRY`, level Participant", before
"any other text". `WorkflowInput` gets `RETRY` (overview §4). Until T12 the placeholder ends it `DONE`.

**Acceptance criteria:**
- [x] `/retry`, `  /RETRY ` and `/Retry\n` → true; `please /retry`, `/retry now`, `/retry2` → false (unit)
- [x] A Participant's `/retry` → `RETRY` with the comment; a sender with no access → `IGNORED` `unauthorized`, no
  reply, no label change (D21) (unit + integration)
- [x] `src/contracts/workflow-input.ts` matches overview §4; spec 2's other classify rows are unchanged (their
  tests pass untouched)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** None
**Files:** `src/contracts/workflow-input.ts`, `src/intake/retry-command.ts` (+ `.spec.ts`),
`src/intake/github-payload.ts` (+ `.spec.ts`), `test/intake.integration.spec.ts`
**Scope:** S

### Task 4: The worker's seam: `WAIT`, `failed()`, `requeue`

**Description:** RLW11 in spec 1's code. `ProcessResult` gets `WAIT` (back to `PENDING`, `availableAt` = now +
`delayMs`, the attempt taken back: `attempts - 1`). `EventProcessor.failed(event, error)` is called once, after
the worker marked the event `FAILED` (a permanent error or the last attempt); an error thrown by `failed()` is
logged and the row stays `FAILED`. `EventsService.requeue(eventId, tx?)` as in P8. At startup the worker logs the
registered processor's class name (matrix "Startup"). The placeholder gets a no-op `failed()`; the test
`ScriptedProcessor` records its `failed()` calls.

**Acceptance criteria:**
- [x] `WAIT` → `PENDING`, `availableAt` ≈ now + delay, `attempts` unchanged across the wait, no `last_error`
  written (integration)
- [x] `failed()` is called exactly once per `FAILED` row, with the error, for a permanent error and after the 3rd
  temporary one; never for a retried attempt; a throwing `failed()` leaves the row `FAILED` and the worker running
  (integration)
- [x] `failed()` is awaited inside the worker's handling of the event, before the next event is claimed (RL7:
  the stop is saved before a later `/retry` is judged) (integration)
- [x] `requeue`: `FAILED`, `IGNORED` and `DONE` → `PENDING`, now, `attempts` 0, `last_error` kept; `PENDING` and
  `PROCESSING` unchanged; inside a rolled-back transaction nothing changes (integration)
- [x] The startup log names the registered processor (unit, `Logger` spy)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** None
**Files:** `src/events/event-processor.ts`, `src/events/events.worker.ts` (+ `.spec.ts`),
`src/events/events.service.ts`, `src/intake/intake-event.processor.ts`, `test/app.ts`,
`test/worker.integration.spec.ts`
**Scope:** M

### Task 5: The `tasks` and `runs` tables

**Description:** `Task` and `Run` in `prisma/schema.prisma` exactly as the spec's "Owned tables" (snake_case
mapping, `runs (task_id, number)` unique, `runs (task_id, started_at)`), migration `<ts>_tasks_runs` created
against the test database (P14). `resetDatabase` empties the two new tables. `Run` also gets the nullable
`endCommentId` (text, Q1): null on an ended run means its run-ended comment is still to post.

**Acceptance criteria:**
- [x] The migration applies to an empty test database; `prisma migrate diff` from the migrations to the schema is
  empty
- [x] Inserting two runs with the same `(task_id, number)` fails (integration)
- [x] `execution_logs.run_id` is unchanged (text, no foreign key)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** None
**Files:** `prisma/schema.prisma`, `prisma/migrations/<ts>_tasks_runs/migration.sql`, `test/db.ts`
**Scope:** S

### Checkpoint 1 — Seams and tables
- [x] `typecheck`, `lint`, `test`, `test:integration` green
- [x] `SESSION_LEASE_SECONDS=10 node dist/main.js` → the app refuses to start, naming the variable
- [x] You run `npm run db:migrate`; `\d tasks` and `\d runs` show the spec's columns
- [x] You review and commit

---

## Phase 2 — The pure core

### Task 6: Comment texts, markers, the stop cause and the router's errors

**Description:** `workflow-errors.ts`: `StepNotBuiltError` (P1; message "this version of the bot has no `<step>`
step yet") and `LeaseLostError` (temporary), used by T9 and T11. `workflow-comments.ts`: every marker and text of
RLW12: the stop comment (failure: "at step" /
"before its first step", the `/retry` line, the restart line naming the run's lane label; result of the work: the
step's body and only the restart line), the run-ended comment (cancel, replaced; the hooks' blocks appended), the
lane-conflict reminder (`draft` and run wordings, the labels listed), the closed-issue replies (lane label,
`/retry`, `/approve`) and the four `/retry` replies. `stop-cause.ts`: error → `stopCause` and message, per the
spec's table (P1 order).

**Acceptance criteria:**
- [x] Each text equals the spec's example for the same input, marker first; the login is in backticks without `@`
  (unit)
- [x] Cause table: `StepNotBuiltError` → `step-not-built`; `StepConfigError` → `step-config` + its message;
  `LlmError` → its code + message; `ProviderError` → `provider-error`, "after 3 attempts" only when transient;
  anything else → `internal-error` with the delivery ID and never the error's own message (unit)
- [x] No text includes issue text, a stack trace or `Error:` (unit over every text)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass

**Dependencies:** None
**Files:** `src/workflow/workflow-errors.ts`, `src/workflow/workflow-comments.ts` (+ `.spec.ts`),
`src/workflow/stop-cause.ts` (+ `.spec.ts`)
**Scope:** S

### Task 7: `decide()`, part 1: lanes, runs and closed issues

**Description:** The types (`RouterState` as in the spec plus `open`, `shownStatus` and the run count for P5 and
P6; the input = a `WorkflowInput`, a step outcome or `FAILED(cause, step, retry, stale)` (P16); the action
union) and the checks that come first: closed (P5, RL19), "this event started the current run" (RL14), the run's
own lane (RL12, RL15). Then rows 1–8, keyed on whether a run is current (P15). `lane-conflict.ts`: the pure conflict check (two or more lanes and not open → post; open → nothing; at most
one → close; a cancel or restart closes it first, RL15). `decide()` takes no clock, no Prisma, no port.

**Acceptance criteria:**
- [x] One test per row 1–8, and per pre-check: RL14 running → continue, stopped → `no-transition`; RL12 own lane
  added → `no-transition`; RL15 own lane removed with two left → cancel (unit)
- [x] A swap in both orders with both events seeing the final labels → exactly one start (unit)
- [x] P15: `draft` with a current run (running or stopped) → a lane label added or removed follows rows 6–8, never
  rows 2–4; the start event of the current run on a closed issue → `issue-closed`, no reply (unit)
- [x] Every row of RL19's table (own lane removed → cancel without a start, even with one lane left; lane added,
  `/retry`, `/approve` → reply; the rest → `issue-closed` silent) (unit)
- [x] Lane conflict: open / already open / closed by at most one lane / closed by a cancel then reopened (unit)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass

**Dependencies:** None (T6 for the reply kinds' names only)
**Files:** `src/workflow/decide.ts` (+ `.spec.ts`), `src/workflow/lane-conflict.ts` (+ `.spec.ts`)
**Scope:** M

### Task 8: `decide()`, part 2: steps, failures and `/retry`

**Description:** Rows 9–31: the first step per lane and skip (9–11), the step outcomes and their handler calls
(12–26, 29; P4), the ignored rows (16, 20, 27), row 28 (`FAILED(cause)` → stop, retryable, only with a running
run; never for a `/retry` event, RL13, or a stale one, P2), the work-result stops (14, 22, 25, 26: not
retryable, the body the outcome carries, P4),
row 30 (accept), row 31 and RL20's replies (no run, not stopped, before the stop). `isStale()` (RL10: before the
latest run's start event; equal times not stale).

**Acceptance criteria:**
- [x] One test per row 9–31 (with rows 1–8 from T7: every row of overview §3 has its test, RLW7)
- [x] Every case of the spec's `/retry` table, each with its reply kind; `/retry` received at the same instant as
  the stop counts as "before" (unit)
- [x] `isStale`: before → stale, equal → not, after → not; no run ever → not (unit)
- [x] Unregistered steps aren't `decide()`'s concern: it names the handler; T14 resolves it

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass

**Dependencies:** T7
**Files:** `src/workflow/decide.ts` (+ `.spec.ts`)
**Scope:** M

---

## Phase 3 — Services

### Task 9: The session lease

**Description:** `SessionLeaseService` (spec "Session lease", P7): `claim(taskId, eventId)` is one SQL update
(owner = the event, expiry = `now()` + `SESSION_LEASE_SECONDS`, only where empty, expired or already this
event's); the heartbeat renews it every third of the lease with the owner in the condition and logs an error when
it finds another owner; `release` in `finally`, owner only. `withLease(taskId, eventId, job)` runs a job under it
and answers "taken". Guarded writes throw T6's `LeaseLostError` (temporary: the worker retries it).

**Acceptance criteria:**
- [x] Two claims at once for two events → exactly one wins; an expired lease is taken by another event; the same
  event takes its own lease back at once; release by a non-owner changes nothing (integration)
- [x] The heartbeat fires every third of the lease while the job runs and stops when it ends, also when it throws
  (unit, fake timers); a renew that finds another owner logs an error (integration)
- [x] Expiry is compared with PostgreSQL's `now()`, never Node's clock (code review + a test that sets
  `lease_expires_at` from SQL)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T1, T5, T6
**Files:** `src/workflow/session-lease.service.ts` (+ `.spec.ts`), `test/session-lease.integration.spec.ts`
**Scope:** S

### Task 10: `TaskService` and `RunService`

**Description:** The only writers of `tasks` and `runs`. `TaskService`: find or create by platform + id (one
upsert, before the lease; `externalRef` refreshed under the lease), status and `shownStatus`, the lane-conflict
fields. `RunService`: `current(task)`, `latest(task)`, create (`number` = `runCount + 1`, `currentRunId`, the
start event and its `receivedAt`), stop (the `stop*` fields, `stops + 1`, `needs-human`, `statusBeforeStop`,
`stoppedAt` from the DB clock), accept a `/retry` (restore, `retries + 1`, `stoppedAt = null`, `requeue` in the
same transaction: P8), end (`cancelled` / `restarted`), end + create in one transaction (restart), record comment
IDs. Every write is a transaction that first checks the lease owner (an update of `tasks` with
`lease_owner = <event>` in the condition); no row → `LeaseLostError`, nothing written.

**Acceptance criteria:**
- [x] Run numbers go 1, 2, 3 per issue; a restart leaves exactly one run with `ended_at` null; `create` with a
  current run outside the restart transaction throws and writes nothing (P15) (integration)
- [x] Ending a stopped run keeps its `stop_*` fields and `stopped_at` (RLW1: "wasted by cause" is one query)
  (integration)
- [x] A write with the wrong owner throws `LeaseLostError` and changes nothing, `runs` included (integration)
- [x] Accepting a `/retry` restores the status, clears the stop and re-queues the stop's event in one
  transaction; a failure inside rolls all three back (integration)
- [x] `stoppedAt` and `startEventReceivedAt` come from PostgreSQL (integration)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T4, T5, T9
**Files:** `src/workflow/task.service.ts`, `src/workflow/run.service.ts`, `test/workflow-tables.integration.spec.ts`
**Scope:** M

### Task 11: The step-handler registry

**Description:** `StepHandlerRegistry.register(name, handler)` / `resolve(name)` (spec "Step-handler registry"):
one handler per name, a second registration is a startup error; `resolve` of an unregistered name throws T6's
`StepNotBuiltError(name)` (P1). The handler interface (`src/workflow`): it gets the task, the run (id, number,
lane, skip), the input and the heartbeat, and returns an outcome (a work-result one with its comment body) or
nothing (P4); an optional cancel hook returns a block of text or null and must be safe to call twice. `test/fakes/scripted-step-handler.ts` answers from a script.

**Acceptance criteria:**
- [x] Register + resolve; a duplicate → error naming the handler; unregistered → `StepNotBuiltError` whose message
  is "this version of the bot has no `<step>` step yet" (unit)
- [x] A test module outside `src/workflow` registers the scripted handler in its `onModuleInit` (spec success
  criterion: later specs plug in without changing `src/workflow`) (unit)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass

**Dependencies:** T6
**Files:** `src/workflow/step-handler.registry.ts` (+ `.spec.ts`), `test/fakes/scripted-step-handler.ts`
**Scope:** S

### Checkpoint 2 — The core
- [x] `typecheck`, `lint`, `test`, `test:integration` green
- [x] `decide.spec.ts` has one named test per row 1–31 (list printed)
- [ ] You review and commit

---

## Phase 4 — The router on real events

### Task 12: The processor replaces spec 2's placeholder

**Description:** `WorkflowModule` (imports `EventsModule`, `IntakeModule`, `GitHubModule`, `LlmModule`; exports
the registry, `RunService` and, from T15, `NeedsHumanService`) and `WorkflowEventProcessor`, registered with the
worker. The flow up to the lease: intake → `IGNORED` with its reason, or `PR_UPDATED` → `IGNORED` `no-task`
(RLW6), or find or create the `Task` → claim the lease → taken: `WAIT` 5 s, log `#12 lease taken, waiting 5 s`.
The lease is released in `finally`. Accepted issue events end `IGNORED` `no-transition` for now (P12).
`src/intake/intake-event.processor.ts` and its spec are deleted; `AppModule` imports `WorkflowModule`; the
harness changes of P11.

**Acceptance criteria:**
- [x] The app's processor is `WorkflowEventProcessor`; nothing registers the placeholder (integration, `Logger`
  spy on the startup line, since the harness boots with `logger: false`)
- [x] `PR_UPDATED` → `no-task`, no `Task` row; an accepted issue event creates its `Task` in `draft` (no label)
  (integration)
- [x] Lease held by another event → `PENDING` again in 5 s, `attempts` unchanged; the same event retakes its own
  lease (crash case) (integration)
- [x] Spec 2's intake suite passes unchanged on the intake-only processor (P11)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T3, T4, T9, T10
**Files:** `src/workflow/workflow.module.ts`, `src/workflow/workflow-event.processor.ts`,
`src/workflow/router.service.ts`, `src/intake/intake.module.ts` (placeholder deleted), `src/app.module.ts`,
`test/app.ts`, `test/router.integration.spec.ts`
**Scope:** M (mostly wiring; the router's logic arrives in T13–T20)

### Task 13: Read the issue, decide, and the status label

**Description:** After the lease: complete a pending status label (P6), refresh `externalRef`, one
`getTaskDetails` (lanes, skip, `open` via `readControls`), build the state, `decide()`, act. Here: row 1 (set
`status: draft`, record `shownStatus`), every status change sets its label, the ignore rows end `no-transition`
with a log line naming the status. Every error after the claim gets P2's mark. Actions built later use P12.

**Acceptance criteria:**
- [x] `issues.opened` → `status: draft` label, `shownStatus = draft`, `DONE`; a comment on an issue with no
  `Task` → row in `draft`, no label, `IGNORED` `no-transition` (integration)
- [x] A pending label (status ≠ shown) is set before anything else, also on an event that then does nothing; a
  `setStatusLabel` failure on `opened` → retried → the label set once (integration)
- [x] Exactly one `getTaskDetails` per routed issue event (integration, `calls`)
- [x] An error after the claim carries the mark with the task, the step and the `/retry` flag; one from intake
  doesn't (unit)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T2, T7, T12
**Files:** `src/workflow/router.service.ts`, `src/workflow/task.service.ts`, `test/router.integration.spec.ts`
**Scope:** S

### Task 14: Run start and the dispatch loop

**Description:** `RunStartService` (RL3): create the run (T10), `StepConfigService.checkRun(lane, grillSkip)`,
`InjectionWarningService.check` on the description, then the first step (row 9 → `grill`, row 10 → `grill` skip
then `spec`, row 11 → `go-signal`). The start event processed again with the run running (RL14, RLW9) continues
from `checkRun` with the stored lane and skip, never a second run. The dispatch loop: action → handler calls →
outcome → `decide()` → … until the job ends; status writes set their label. An unregistered handler throws
`StepNotBuiltError`. Log `#12 run 2 started (full-sdd)`.

**Acceptance criteria:**
- [x] Lane label added in `draft` → run 1 (lane, skip read from the API now, start event, `receivedAt`); the event
  ends `FAILED` with `step-not-built` (the stop comes in T15) (integration)
- [x] `checkRun` fails → `FAILED`, no injection warning; it passes → the warning (if due) is posted before the
  first step fails (integration)
- [x] Crash after the `Run` row (its start event re-queued, run running) → continues, no run 2 (integration)
- [x] With scripted handlers: `go-signal` returning nothing → `ready-for-dev` + label (P4); `grill` returning an
  outcome → `decide()` is called with it (integration)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T8, T11, T13
**Files:** `src/workflow/run-start.service.ts`, `src/workflow/router.service.ts`, `src/workflow/run.service.ts`,
`test/run-start.integration.spec.ts`
**Scope:** M

### Task 15: Failure → `needs-human`, and the pending stop comment

**Description:** `WorkflowEventProcessor.failed()` (spec "Failure → `needs-human`"): only for a marked error (P2);
claims the lease (P10), builds the router state and acts on `decide(state, FAILED(…))` (P16: a running run, not a
`/retry`, not stale). `NeedsHumanService.stop` saves the stop in one transaction, then sets the label and posts
the stop comment with its marker, recording `shownStatus` and `stopCommentId`; a GitHub failure after the
transaction is logged and stays pending (RL5). Every event completes a pending stop comment first (marker search,
then post), right after the pending label. `NeedsHumanService.stop` also serves work-result stops, called by the
router on a work-result outcome (retryable false, the outcome's body; rows 14, 22, 25, 26; P4). RL14 stopped →
pending first, then `no-transition`. Log `#12 run 2 stopped at spec: access-denied`.

**Acceptance criteria:**
- [x] Lane label added → run 1 stopped at `go-signal`, `step-not-built`, stops 1, `status: needs-human`, exactly
  one stop comment with both lines (integration)
- [x] Temporary `ProviderError` on 3 attempts → one stop, "after 3 attempts"; an unexpected error →
  `internal-error`, the comment names the delivery ID and not the message (integration)
- [x] Silent cases (RLW2, RL13, RL16): no current run; run already stopped; a `/retry` event; an intake failure →
  `FAILED`, no comment, the run unchanged (integration)
- [x] GitHub down at the stop comment → the event `FAILED`, run stopped, comment pending → the next event posts it
  once; posted but not recorded → found by its marker, never twice; a redelivery of the stopped start event →
  pending completed, `no-transition`, no run 2 (integration)
- [x] A scripted handler returning `LIMIT` with a body → a non-retryable stop: its body + only the restart line
  (integration)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T6, T14
**Files:** `src/workflow/workflow-event.processor.ts`, `src/workflow/needs-human.service.ts`,
`src/workflow/router.service.ts`, `test/needs-human.integration.spec.ts`
**Scope:** M

### Checkpoint 3 — The router on real GitHub
My instance on port 3000, dev database; your clicks on the sandbox.
- [x] `typecheck`, `lint`, `test`, `test:integration` green
- [x] Matrix "Startup": both rows
- [x] Matrix "Run start, stop and `/retry`": the first two rows (`#A` opened → `status: draft`; `code-only` →
  run 1 stopped at `go-signal`, one comment, no injection warning) (2026-11-17, `#A` = #16)
- [x] Matrix "Run-start check": `#B` (warning, then the stop) and `#C`'s first row (`step-config`, one comment, no
  warning; my instance on `TARGET_BASE_BRANCH=smoke/spec-4-missing-skill`, restored afterwards) (2026-11-17: `#B`
  = #17, `#C` = #18; the sandbox branch recreated, `plan` → `.github-agent/skills/plan-missing`)
- [x] Matrix "Pending side effects": all three rows (2026-11-17, on #16)
- [x] Lease taken, with a `hello` comment instead of `/retry` (built in T16): `PENDING`, the log line, processed
  after the expiry, `attempts` 1 (2026-11-17, on #16)
- [x] Matrix "Refused and other inputs": the comment on an old issue with no `Task` (2026-11-17: #9 reopened for
  the comment, closed again; a closed issue would test the closed path instead)
- [ ] You review and commit

---

## Phase 5 — `/retry`, cancel, restart, lane conflicts

### Task 16: `/retry`

**Description:** Row 30: accept (T10's transaction, P8), then the label; P9 for any failure after the write. RL20's
replies, marker `retry-refused:<commentId>`, `IGNORED` `retry-refused`: row 31, no run, not stopped, before the
stop. A failing `/retry` never stops the run (RL13, P2's flag). The re-queued event then runs the normal flow (not
stale, RL14 or the restored status). Log `#12 /retry accepted: run 2 back to spec-review`.

**Acceptance criteria:**
- [ ] Stopped run 1 → `/retry` → `DONE`; label back to the status before, then `needs-human` again; a second stop
  comment (marker `…:2`); stops 2, retries 1, no run 2 (integration)
- [ ] Each reply case posts exactly one reply, also when its job is retried (integration)
- [ ] Two `/retry` while the lease is held → the first accepted, the second "written before run N stopped"
  (integration)
- [ ] The label call failing after the write → the `/retry` event `FAILED` at once, no reply; the re-queued event
  sets the label first; the stop's event ended `IGNORED` by a redelivery → still re-queued (integration)

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T15
**Files:** `src/workflow/router.service.ts`, `src/workflow/run.service.ts`, `test/retry.integration.spec.ts`
**Scope:** M

### Task 17: Cancel, restart and the run-ended comment

**Description:** Cancel (row 6; RL15): the registered cancel hooks (their blocks), the run ends `cancelled`,
`currentRunId = null`, `draft` + label, one run-ended comment (RL18, marker `run-ended:<runId>`), the lane
conflict closed. Restart (row 6 with one lane left, row 7 with a different lane, RL12): end `restarted` and create
run N+1 in one transaction, the "replaced" comment, then T14's run start. Q1: a run-ended comment not yet posted
(the issue's last ended run has `endCommentId` null) is a pending side effect: the next event on the issue posts
it first (marker check, the cancel hooks asked for their block again), then records `endCommentId`. Logs `#12 run 2 cancelled`, `#12 run 2 restarted → run 3 (spec-code)`.
Q2 (decided at Checkpoint 2): the end also saves `Run.endEventId` (a new nullable column, one migration in this
task); the comment's login is that event's sender, also when a later event posts it.

**Acceptance criteria:**
- [ ] Cancel of a running and of a stopped run → one comment with the sender in backticks, no `@`; `status: draft`;
  the stopped run keeps its `stop_*` fields (RLW1) (integration)
- [ ] Restart → the "replaced" comment, then the new run's stop comment; a swap in either order, both changes made
  before the bot handles them → exactly one new run, one "replaced" comment, the other event `no-transition`
  (integration)
- [ ] A scripted cancel hook's block is appended to the same comment (integration)
- [ ] GitHub down at the run-ended comment → `endCommentId` stays null; the next event on the issue posts it
  once and records its id; a retry after the post but before the record finds the marker and posts nothing
  (integration)
- [ ] That late comment, posted by another sender's event, names the sender of the event that ended the run
  (`endEventId`, Q2) (integration)

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T16
**Files:** `src/workflow/router.service.ts`, `src/workflow/run.service.ts`, `src/workflow/step-handler.registry.ts`,
`test/cancel-restart.integration.spec.ts`, `prisma/schema.prisma` + one migration (`endEventId`, Q2)
**Scope:** M

### Task 18: The lane-conflict reminder

**Description:** After the action of every routed event on an open issue: T7's check. Post first (marker
`lane-conflict:<laneConflicts + 1>`, searched before posting), then record the listed labels and the count, so a
retried job never posts twice. Wording by whether a run is current after the action. Rows 3 and 8 end `IGNORED`
`lane-conflict`. Log `#12 lane conflict (reminder posted)`. Q3 (decided at Checkpoint 2): one reminder per set of
labels: `Task.laneConflictLanes` (text[]) replaces `laneConflictOpen` (one migration in this task); T7's check
compares the set read with it; the text gives the count and the list ("has N" / "still has N", T6's text changes).

**Acceptance criteria:**
- [ ] Two lane labels added in one go (two events) → one reminder, both `lane-conflict`, no run; remove one → run
  starts; add it again → a new reminder `…:2` (integration)
- [ ] Q3: three lanes, one removed → a fresh "still has 2 …" reminder; a third added while two are listed → a
  fresh reminder listing three; an event that reads the listed set → nothing (integration)
- [ ] Three lanes with a run, the run's lane removed → cancel comment, no run, a fresh reminder in the `draft`
  wording (RL15) (integration)
- [ ] The reminder post failing → retried → posted once; failing in the job of an accepted `/retry` → that event
  `FAILED` at once (P9) (integration)

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T17
**Files:** `src/workflow/router.service.ts`, `src/workflow/lane-conflict.ts`, `src/workflow/task.service.ts`,
`test/lane-conflict.integration.spec.ts`; Q3: `src/workflow/decide.ts` (state), `src/workflow/workflow-comments.ts`,
`prisma/schema.prisma` + one migration
**Scope:** S

### Checkpoint 4 — `/retry`, restarts and conflicts on real GitHub
- [ ] `typecheck`, `lint`, `test`, `test:integration` green
- [ ] Matrix "Run start, stop and `/retry`": the remaining rows (`/retry`, `please /retry`, `  /RETRY `, cancel,
  `/retry` with no run, `full-sdd` run 2)
- [ ] Matrix "Restart and lane conflicts": every row except `#D` (it needs the stale rule, T20: Checkpoint 5)
- [ ] Matrix "Run-start check": `#C`'s swap row (my instance on the smoke branch again, restored afterwards)
- [ ] You review and commit

---

## Phase 6 — Closed issues, stale events, `npm run db:runs`

### Task 19: Closed issues

**Description:** RL9 and RL19 wired: T7's closed rows act (the own-lane cancel with no start, using T17's cancel),
the replies with marker `issue-closed:<deliveryId>`, the silent rest; no reminder on a closed issue. The action
switch becomes exhaustive and P12's fallback goes.

**Acceptance criteria:**
- [ ] Every row of the spec's closed-issue table (integration)
- [ ] The frozen run is unchanged by everything but the own-lane removal; reopened, a lane label starts a run as
  usual (integration)
- [ ] No `not built yet` log line remains (`grep`)

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T18
**Files:** `src/workflow/router.service.ts`, `test/closed-issue.integration.spec.ts`
**Scope:** S

### Task 20: Stale events

**Description:** After the pending side effects and before `getTaskDetails`: `isStale` against the latest run
(current or ended) → `IGNORED` `stale`, no API call. Log `#12 ignored stale`.

**Acceptance criteria:**
- [ ] `opened` handled after its `labeled` twin started a run → `stale`; a comment re-queued after a swap started
  a new run → `stale`, nothing posted, no `getTaskDetails` (integration)
- [ ] The run's own start event and the event `/retry` re-queues are never stale (integration)
- [ ] Pending side effects are completed even for a stale event; a stale event that fails there 3 times ends
  `FAILED` and never stops the run (P2) (integration)

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T19
**Files:** `src/workflow/router.service.ts`, `test/stale.integration.spec.ts`
**Scope:** S

### Task 21: `npm run db:runs`

**Description:** P13: the last 20 runs: issue, number, lane, skip, started, ended and why, the stop (step: cause),
stops, retries.

**Acceptance criteria:**
- [ ] On the dev database (the `db:*` scripts use the dev container), the columns show as the spec lists them;
  checked at Checkpoint 5

**Verification:**
- [ ] `npm run lint` passes

**Dependencies:** T5
**Files:** `package.json`
**Scope:** XS

### Checkpoint 5 — Closed, stale, lease and refused inputs on real GitHub
- [ ] `typecheck`, `lint`, `test`, `test:integration` green
- [ ] Matrix "Closed issues", "Stale events" and "Lease": every row
- [ ] Matrix "Restart and lane conflicts": the `#D` row (labels set in the creation form)
- [ ] Matrix "Refused and other inputs": the two signed requests
- [ ] `npm run db:runs` shows every run of the checkpoints so far
- [ ] You review and commit

---

## Phase 7 — Docs and full verification

### Task 22: Setup guide, `AGENTS.md`, `README.md` and the spec

**Description:** The spec's "Setup & configuration": `SESSION_LEASE_SECONDS`, `npm run db:runs`, a short "When an
issue is in `needs-human`" section (`/retry` or restart), the router's ignore reasons next to intake's.
`AGENTS.md`: State and Commands. `README.md` where it names what changed. The spec's status line (its decision
lines changed in T0), and any line the build itself had to change.

**Acceptance criteria:**
- [ ] Every command in the guide exists in `package.json`; the guide's ignore reasons equal intake's list plus the
  router's six (RLW8)
- [ ] `AGENTS.md` says spec 5 is built and names the next spec (6, `grill-me`, per overview §1)

**Verification:**
- [ ] Manual: you read the changed guide sections once

**Dependencies:** T21
**Files:** `docs/guides/setup-github-agent-local.md`, `AGENTS.md`, `README.md`,
`docs/specs/spec-github-agent-router-session-lease.md`
**Scope:** S

### Task 23: Run the verification matrix and the success criteria

**Description:** Every row of the spec's matrix, as for specs 1–4: I run what I can (signed requests, SQL, `gh api`
reads, log greps) with my instance and its log in the scratchpad; you do the GitHub UI steps, one per message.
Rows already passed at Checkpoints 3–5 are run again only where a later task touched their path. Results are
ticked in the spec; the spec's and the plan's status lines are set.

**Acceptance criteria:**
- [ ] Every matrix row is ticked or reported as failing with its output (no silent skips); the "Invariants" are
  scoped to rows stored since the new code went live
- [ ] The spec's success criteria are checked: one passing `decide()` test per row 1–31; `src/contracts` against
  overview §4; a later spec can register handlers and use `NeedsHumanService`, `RunService` and the run id
  without changing `src/workflow` (T11's test)

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` green

**Dependencies:** T22
**Files:** `docs/specs/spec-github-agent-router-session-lease.md` and this plan (checkboxes and status only), plus
fixes if a row fails
**Scope:** S (more if a row fails)

### Checkpoint 6 — Complete
- [ ] The spec's "Success criteria" are all checked
- [ ] You review and commit; spec 6 is next in the build order

---

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| A bot comment posted twice, or never, when GitHub fails or the app crashes between a database write and a post | High | A marker on every comment; database first with pending recovery for the label, the stop comment and (Q1) the run-ended comment; post-then-record for the reminder; integration tests make the fake fail at each post (`failNext`) and assert exactly one comment |
| Two active runs, or a stale event that acts | High | End + create in one transaction under the lease; RL14 checked before rows 6–8; stale checked before the API call; the "one active run" query in the tests and the matrix |
| A failure stops the wrong thing: an intake failure posts a comment, a `/retry` or a stale event stops the run | High | P2's mark only after the claim, with the `/retry` and stale flags; P16 sends it through `decide()`; one test per silent case (T15, T16, T20) |
| A `draft` task with a current run starts a second run | High | P15: rows keyed on the current run; `create` refuses beside a current run; unit tests in T7, integration in T10 |
| A bug's message or a stack trace in a comment | High | `stop-cause.ts` never passes an unknown error's message (T6); matrix grep |
| The lease: a write without it, an issue stuck after a crash, a heartbeat timer left running | High | One SQL update with the DB clock; every write checks the owner in its transaction; heartbeat cleared in `finally` (fake-timer test); race, expiry and retake tests (T9) |
| Two clocks (Docker's VM and the Mac) misjudge stale or "`/retry` before the stop" | Med | P7: every compared time comes from PostgreSQL |
| `decide()` grows into a tangle as specs 6–10 add handlers | Med | Pure, one test per row and per pre-check; steps only through the registry (P4) |
| The router breaks spec 2's behavior or tests | Med | P11 keeps the intake suite unchanged; T12 deletes the placeholder in the same task that registers the new processor |
| P12's provisional `no-transition` hides a missing action | Low | Logged as `not built yet`; T19 makes the switch exhaustive and greps the line away |
| The migration harms the dev database | Low | Two new tables only (P14); you run it |
| Your steps block a checkpoint | Low | Listed under "Your part"; each is a few clicks |

## Open questions

- **Q1 (answered 2026-11-16: yes, `Run.endCommentId`; was "Ask first" for a new column):** the run-ended comment has no pending
  state. If GitHub fails after a cancel's database write, the retried event finds the run already ended and the
  comment ("cancelled" or "replaced") is never posted. **Recommended:** a nullable `Run.endCommentId` (null on an
  ended run = pending), completed first by the next event like the stop comment; the cancel hooks are asked for
  their block again (they must be safe to call twice: noted for spec 6). Alternative: post the comment before the
  database write (its marker prevents a duplicate; no column), which breaks "the database moves first" (D13) for
  this one comment.
- **Q2 (answered at Checkpoint 2, 2026-11-16: yes, `Run.endEventId`; was "Ask first" for a new column):** a
  run-ended comment posted later by another event (Q1) didn't know who changed the label. The end now saves the
  event that ended the run; the comment names its sender. Alternative declined: leave the login out in that case.
- **Q3 (answered at Checkpoint 2, 2026-11-16: one reminder per set of labels; was "Ask first" for a column):** the
  reminder listed the labels once, then stayed silent while two or more remained, so removing one of three (or
  adding a third) left the person waiting with a wrong list. Now a different set of two or more posts a fresh
  reminder with the count and the list. Declined: a reminder after every change (three for labels ticked at once),
  editing the reminder (no notification; the GitHub adapter can't edit comments).
- **P1–P16** confirmed 2026-11-16. P4 also sets a rule for specs 6, 8 and 9 (return the work-result
  outcome with its body; never call `stop`). T0 writes the spec and overview lines they change before any code.

## Review

A general-purpose subagent with no context from this session read the spec, this plan, overview §3–§4 and the code
it changes (2026-11-16). Verdict: "ready after fixes; items 1–4 needed before approval". All 12 findings were
checked against the spec and the code and applied the same day:

| # | Finding | Kind | Applied |
|---|---|---|---|
| 1 | A `draft` task with a current run matched rows 2–5, so a lane event could start a second active run; the closed-issue reply misfired for a re-processed start event | gap | P15; T7, T10 criteria |
| 2 | Spec and overview changes were recorded late (T22) and incompletely, against "change the overview first" | bug | T0 before any code |
| 3 | T6 mapped `StepNotBuiltError`, which T11 created | bug | the errors move to T6 (`workflow-errors.ts`) |
| 4 | Unclear who stops the run on a work-result outcome: a step calling `stop` and returning `LIMIT` would stop twice | bug | P4: one path, the router; recorded for specs 6, 8, 9 |
| 5 | Row 28 bypassed `decide()` | bug | P16; T15 |
| 6 | A stale event failing in the pending side effects could stop the run and leave it stuck after `/retry` | gap | P2's stale flag; T20 criterion |
| 7 | P9 covered only the label call | nit | P9 covers any failure after the write; T18 criterion |
| 8 | `failed()` must finish before the next event is claimed | nit | T4 criterion |
| 9 | Matrix row `#D` came before the stale rule; the spec row misses `no-transition` | nit | moved to Checkpoint 5; spec row fixed in T0 |
| 10 | RLW1 "an ended stopped run keeps its stop" had no criterion | gap | T10, T17 criteria |
| 11 | T21's check ran `db:runs` on the test database, which the script can't reach | nit | checked on the dev database at Checkpoint 5 |
| 12 | T12's startup-log check can't see logs (`logger: false`) | nit | `Logger` spy in T4 and T12 |

It confirmed that every matrix row has a checkpoint, that P8 and P9 are needed, and that Q1 is a real spec gap
with `endCommentId` as the right option.
