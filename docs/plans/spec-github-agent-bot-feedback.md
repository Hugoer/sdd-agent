# Implementation Plan — Spec #13: Bot Feedback

> **Created:** 2026-11-26 · **Status:** draft 2026-11-26; fresh-context review 2026-11-26, its fixes with no choice
> applied (see "Review"); FP1, FP2, FP23 (GitHub-visible) and FP3, FP24 (write-time) confirmed one at a time the same
> day, all as recommended; approved 2026-11-26 (`f5a2bc4`); build started 2026-11-26
>
> **Why this file exists:** turns the approved spec `docs/specs/spec-github-agent-bot-feedback.md` (spec 13,
> `bot-feedback`, approved 2026-11-26 in `cb27de3`) into ordered, verifiable tasks (skill
> `agent-skills:planning-and-task-breakdown`). The spec stays normative: this plan adds order, slicing and build-time
> decisions only. The task checklist lives here (repo placement rules override the skill's `tasks/todo.md`). It is the
> one plan for everything the spec changes: code that specs 1 (`walking-skeleton`, `src/events`), 3
> (`github-providers`, `src/github`), 5 (`router-session-lease`, `src/workflow`), 6 (`grill-me`, `src/grill`) and 7
> (`spec-plan-approvals`, `src/documents`) built, and the secret-scanning wrapper of spec 4 (`src/secret-scan`).
>
> **Also read:** overview D33, §1 row 13, §3 (states, rows 17–20, 30, 32–35, the diagram; already updated for spec
> 13 on 2026-11-26), §4 (`TaskStatus`, `IssueProvider`), §6 (`Task`, `WebhookEvent`).
>
> **Build effort:** high (overview §1, row 13; spec BF9).

## Overview

Two things change on GitHub. **The working sign:** when a human action makes the bot call the model, the bot puts 🚀
on the comment that triggered it (when there is one) and `bot: working` on the issue; the label comes off in code
when the event is finished for good, also after a crash (a mark on the task, a startup sweep). **The statuses:** a
`full-sdd` Plan waits under the new `status: plan-review`; `status: ready-for-dev` means "every approval is in"
(`code-only`'s go-signal still waits under it). Plain code: no model call is added, none is removed.

Built in 15 tasks (T0–T14), 5 checkpoints:

0. **Before any code** (T0): this plan's fixes in the spec, and sandbox issue `#I` set up with today's code (the
   migration row needs a Plan waiting under the old `ready-for-dev`).
1. **Labels and the port** (T1–T2): 18 labels, descriptions updated at startup, `reactWorking`, `setWorkingLabel`,
   `acknowledgeComment` removing the bot's 🚀. Nothing calls the new methods yet.
2. **The statuses and the migration** (T3–T6): the `APPROVED` outcome, `plan-review`, `ready-for-dev`'s new meaning,
   the migration (three columns and the data rule). **`npm run dev` is stopped from T5's start until you run `npm run
   db:migrate` at T6's end.**
3. **After a restart** (T7–T8): the worker's recovery hook and the startup sweep (leftover labels, status repair).
4. **The working sign** (T9–T11): the sign's service, the router's hooks and 🚀 on an accepted `/retry`, the handlers
   calling `working()`.
5. **The invariant script, the docs, the matrix** (T12–T14).

You review and commit at each checkpoint (I never commit). Every code task ends with `npm run typecheck && npm run
lint && npm test && npm run test:integration` green.

### When `npm run dev` must be stopped

| From | Until | Why |
|---|---|---|
| T0's sandbox step | the end of Checkpoint 1's rows | `#I` is set up on my instance with today's code; the startup-log row must be the first start of T1's code (a `watch` reload of your `npm run dev` would create the labels first and the row would read `0 created`) |
| T5's start | your `npm run db:migrate` at T6's end | T5's code with the old data misreads every Plan waiting under the old `ready-for-dev` (an `/approve` would get "already approved"); T6's schema adds columns every `tasks` and `webhook_events` query selects, so the app fails until the dev database has them |
| T8's start | the end of Checkpoint 3's rows | from T8 on, every start runs the sweep: a `watch` reload would repair `#I`'s label before Checkpoint 3's first row can see it (review) |
| Checkpoint 5's matrix | the end of the matrix | I run my instance on port 3000 with your tunnel and the dev database |

Between those windows you may run `npm run dev` and try the sandbox yourself; don't touch `#I` until Checkpoint 3.

## Build-time decisions (not in the spec; to confirm with this plan)

Each told as what happens on GitHub. FP1, FP2 and FP23 change something you can see and had a real choice
(Questions 1–3 of 3); FP3 and FP24 change nothing on GitHub but had a real choice (Write-time decisions 1–2 of 2).
All five confirmed 2026-11-26 as recommended.
FP4–FP22 follow from the rule named in their row.

| # | On GitHub | My guess (and the alternative) | Spec lines it changes |
|---|---|---|---|
| FP1 | In `full-sdd` after the Plan's `/approve` (or `spec-code` after the Spec's), the run waits under `ready-for-dev`. Bob comments `/refresh`, Alice `/restore`. | **Confirmed 2026-11-26 (Question 1).** (Asked "shouldn't it be coding?": `executing` already exists for that, set when the workspace is claimed, overview row 23; `ready-for-dev` lasts only from the approval to the claim, longer only while spec 8's workspace is busy, which the spec's "Agreed for later specs" → spec 8 already records.) One reply each, worded like spec 7's `executing` replies: `/refresh` → "Your `/refresh` comes too late: every approval of run 1 is in, and the bot codes from the approved texts."; `/restore` → "Your `/restore` has nothing to restore: every approval of run 1 is in, and the bot keeps the approved texts." *Alternative:* reuse spec 7's `executing` texts as they are ("run 1 is already writing the code …"), which says something that isn't true yet. | BFW6 (the texts), row 35 |
| FP2 | Bob's `/approve` is being worked on (🚀, `bot: working`); Alice removes `bot: working` by hand; the Plan's call then gets a 503 and the worker tries the event again 5 s later. | **Confirmed 2026-11-26 (Question 2;** asked first: removing the label stops nothing, the bot never reads it, its mark in the database is what counts). The retried attempt adds `bot: working` again (each attempt's `working()` adds the label when this event holds the mark: that is what repairs a crash between the mark and the label, BFW2); BFW13 gets a dated note "except when the event is tried again". *Alternative:* never add it again once this event added it (a stored "label added" flag on the task); a crash between the mark and the label then leaves the work without a label until it ends. | BFW13 (a note) |
| FP3 | No difference (the usage columns). | **Confirmed 2026-11-26 (Write-time decision 1).** A re-queue (an accepted `/retry`, or spec 2's redelivery of a `FAILED` row) clears `working_started_at` and `working_ended_at`, so the re-run's wait starts at its own first `working()`. *Alternative:* keep `working_started_at` (`COALESCE`), so the re-run's `wait_s` counts from the failed attempt, hours before the `/retry` included. | BFW8 (one line) |
| FP4 | No difference. | **One new step outcome, `APPROVED`:** every `approve` op (`spec`, `plan`, `go-signal`) returns it once the approval is saved (also when this event saved it on an earlier attempt), and `decide()` says what follows: `spec-review` + `full-sdd` → the Plan, then `plan-review` (row 17); `spec-review` + `spec-code` and `plan-review` → `ready-for-dev` first, then the workspace claim (rows 18, 19, BFW6); `ready-for-dev` (`code-only`) → the claim. Row 17's list becomes one call (the outcome brings the Plan). Rule: D3 (steps never call each other; an outcome goes back through `decide()`), BFW6 ("the approval call's own outcome … goes back into `decide()`"). | overview §3 "Step outcomes" (T0) |
| FP5 | Bob's `/retry` is accepted: 🚀 on it, then the status label. | **🚀 before the `/retry`'s write** (`acceptRetry`): a GitHub failure on the reaction retries the `/retry` like any write before it; after the write, spec 5's P9 would end it `FAILED` silent with no 🚀 ever. A retried `/retry` adds 🚀 again (`200`, already there). | — |
| FP6 | No difference. | **`working()`'s order:** `working_started_at` (`COALESCE`), the mark (set when empty or already this event), 🚀 on the event's comment, the label when this event holds the mark. A second call in the same job does nothing (a flag on the job); each worker attempt is a new job. | — |
| FP7 | No difference. | **The end:** one `end` step after `handle()` returns, inside the lease, before the worker writes `DONE`/`IGNORED`; in `failed()` the same step after the stop (also when no stop is made). It reads the task's mark, so a mark from an earlier attempt of the same event comes off too. `working_ended_at` is written for every event with `working_started_at` (`route()`'s end; at the top of `failed()`, outside the lease, so a hook that can't take the lease still records it). Review: intake runs again on every attempt, so an attempt after `working()` can end in intake (`IGNORED`, or a `FAILED` with no router mark, where `failed()` returns early today): `WorkflowEventProcessor` runs the same end for an intake `IGNORED`, and `failed()` runs it before the router-mark check, finding the task by `working_event_id = event.id` (`TaskService.byWorkingEvent`). | — |
| FP8 | No difference. | **The pending removal** (BFW3) runs first among spec 5's pending side effects (before the pending status label): a mark naming another event that is `DONE`, `IGNORED`, `FAILED` or gone → label off, mark cleared. A GitHub failure throws (the event is retried), as the pending status label does (RL5). | — |
| FP9 | No difference. | **The sweep's lease:** a fresh id per task, claimed when the lease is empty, expired, or owned by an event that isn't `PROCESSING` (spec 5's claim plus one condition; BFW10). The mark is cleared only if it still names the event the sweep read. | BFW10 (one line: "as a new id" for both cases) |
| FP10 | No difference (log lines). | **Log lines:** `#90 working on (event <delivery>)`, `#90 working off`, `#90 working off failed: <message>` (the mark stays), `#90 working label left for event <delivery> (pending)` (sweep), and the summary `startup sweep: 2 working labels removed, 1 left for its event, 1 status label repaired, 0 skipped (lease held), 0 failed`. | "Logging" (the summary's two new counts) |
| FP11 | An old sandbox issue whose Plan waits under `ready-for-dev` shows `status: plan-review` after the first start. | **The migration's rule:** the run is the task's current run, `full-sdd`, and its current Plan (the latest `plan` row not superseded) exists with `approved_at` null → `plan-review`; the same for a stopped run's `status_before_stop`. A `full-sdd` run with no Plan row (never seen) keeps its status. The two `UPDATE`s sit after a marker comment in `migration.sql`; the test runs them on seeded rows. | — |
| FP12 | Alice comments `/approve` after Bob's approval of the Plan (`ready-for-dev`, nothing waits): spec 7's "already approved" reply, linking the Plan. | **`DocumentsStore.lastApproved(runId)`**: the run's latest approved document (by `approved_at`); the reply names it (BFW6: "its reply naming that document"). The gate answers `done` only when that document's `approve_event_id` is this event (BFW6: "this event made it"; review: any approval of the run by this event would also send a re-run of the Spec's `/approve` to the claim). | — |
| FP13 | No difference. | **The recovery hook:** `EventProcessor.recover?(): Promise<void>` (optional, so every scripted processor still compiles); the worker's bootstrap runs `resetInterrupted()` and schedules the first tick as today, and that first tick awaits the hook before its first claim (FP23: the port opens at once); an error it throws is one log line and the worker starts anyway (as its failure hook: a sweep never blocks events). The test app's `ManualEventsWorker` awaits it too. `WorkflowEventProcessor.recover()` calls `StartupSweepService.sweep()` (`src/workflow`). | — |
| FP14 | `npm run github:smoke` prints three more `PASS` lines. | **The smoke script covers both new methods** (spec 3: "every GitHub method once"): `reactWorking` (🚀 on the smoke comment), `acknowledgeComment` (now also checks the bot's 🚀 is gone: one `GET …/reactions` through the client), `setWorkingLabel true, false, false` (the label on, off, off again). | — |
| FP15 | No difference. | **The fake `IssueProvider`** records the bot's reactions per comment (`reactionsOf(task, commentId)`: `rocket`, `eyes`) and `bot: working` as a label; `acknowledgeComment` adds `eyes` and removes `rocket`; `acknowledged()` stays. `bot: working` and `status: plan-review` join its label list. | — |
| FP16 | No difference. | **Removing the 🚀** (BFW5): after the 👀 `POST` (a `404` ends it), `GET …/comments/{id}/reactions?content=rocket` (paginated), the one whose `user.login` is the bot (`isSelf`), then `DELETE …/reactions/{reaction_id}`; a `404` at either step is "already gone". | — |
| FP17 | No difference. | **`ensureLabels`' update:** after creating the missing labels, a `PATCH` with `{ description }` only for a `status: *` label or `bot: working` whose description differs from `BOT_LABELS` (`isBotManagedLabel(name)` in `labels.ts`). Log line `Labels on <repo>: 2 created, 1 updated, 15 already present` (the three counts add up to 18). | — |
| FP18 | No difference. | **Label order in `BOT_LABELS`:** `status: plan-review` right after `status: spec-review`, `bot: working` after the seven statuses; BFW9's colours and descriptions. | — |
| FP19 | No difference. | **The `ready-for-dev` reply key:** a new `NothingWaits` value `approved` (FP1's texts, for `/refresh` and `/restore` only; an `/approve` there always gets the gate's verdict, so the `/approve` table has no `approved` entry and `nothingWaitsReply` throws if asked for one, as today for a missing situation); `NOTHING_WAITS` becomes a function of status and lane (`code-only` → `code-only`, otherwise `approved`). | — |
| FP20 | No difference. | **Three new suites:** `test/bot-feedback.integration.spec.ts` (the sign through the router and the real handlers, the statuses' flows), `test/bot-feedback-recovery.integration.spec.ts` (the migration rule, the hook, the sweep) and `test/working-sign.integration.spec.ts` (the sign's service alone, T9). Existing suites change only where listed below. | — |
| FP21 | No difference. | **No index on `tasks.working_event_id`** (the sweep reads a handful of rows once per start; the router reads the task by id). | — |
| FP22 | No difference. | **The invariant script** reads the given issues' labels, comments and each human comment's reactions with `gh` (the bot is `user.type === 'Bot'`, as spec 14's script), and `tasks`, `runs`, `task_documents`, `webhook_events` (by `external_ref`) and `execution_logs` (by `external_ref` and time) from the dev database. An accepted `/retry` is a `/retry` comment whose event isn't `IGNORED` `retry-refused`. | Invariants 3 (the exact join) |
| FP23 | You restart the bot; for the first seconds GitHub's deliveries get "connection refused" (GitHub doesn't send them again by itself; a label added then is missed until you redeliver it). | **Confirmed 2026-11-26 (Question 3, from the review).** The sweep runs at the start of the worker's first tick: the port opens at once and the sweep still runs before the first event is claimed. *As planned:* the worker's bootstrap awaits the sweep, so the port opens only after it (about three GitHub calls per task to repair, 30 s each at worst). | BFW10 (where it runs) |
| FP24 | No difference. | **Confirmed 2026-11-26 (Write-time decision 2, from the review).** Invariant 3 judges a 🚀 by its own event's `working_started_at` … `working_ended_at`: valid when that window is set and holds an `execution_logs` row of the issue. *Alternative:* keep the spec's `received_at` … `processed_at` window, minus the rows inside another event's working window of the same issue. The spec's "one event at a time makes the window exact" is wrong either way: an event's window includes the time it waited behind an earlier event of the same issue, so a 🚀 wrongly put on the second comment of a burst would pass; a fixture with that overlap must fail. | Invariants 3 |

**Fixes to the spec with no choice (applied in T0, each marked "2026-11-26, plan"):**
- BF10's example and matrix `#G`: a stop during the Plan's call happens before `plan-review` is set (row 17 sets it
  after the Plan is posted), so `/retry` goes back to `spec-review`, then `bot: working`, the Plan, `plan-review`.
- Matrix `#F` (Wi-Fi): the worker retries 5 s, then 30 s after a failure, so with Wi-Fi back within ~20 s the Plan
  comes at attempt 2 or 3; the row checks `attempts` ≥ 2, and names the waiting script's steps (Checkpoint 5).
- Matrix `#A` `/refresh`: with `main` unmoved since the Plan, `/refresh` answers "nothing changed" with no model call
  and no sign; the row first commits a file no document read (`docs/bot-feedback-matrix.md`).
- Matrix "The statuses": `npm run db:runs` has no status column; "before stop" is read with the task query (it gains
  `runs.status_before_stop`, see the matrix's "Setup"). "Commands": `db:runs` shows no status; the task query does.
- Matrix "Setup": "within seconds" is measured from `webhook_events.received_at` to the `created_at` of the issue's
  `labeled bot: working` event (`gh api …/issues/<n>/events`) and of the bot's 🚀 (`…/reactions`).
- "Testing strategy": "a second event taking over the mark" → "a second event leaving the mark" (BFW2 after the
  review).
- "Logging": the sweep summary as FP10.
- Invariant 3: judged by the event's own `working_started_at` … `working_ended_at` (FP24), not by `received_at` …
  `processed_at` ("one event at a time makes the window exact" is struck: an event's window includes its wait behind
  another event of the issue).
- BFW10: the sweep runs at the worker's first tick, before its first claim (FP23); BFW13: a person's removal holds
  within one attempt, a retried attempt shows the label again (FP2); FP1's two reply texts in BFW6.
- Overview §3 "Step outcomes": `APPROVED` (FP4).

## Existing tests and code this plan changes (grep, 2026-11-26)

Every construction, signature, fixture and asserted text the plan changes, grepped across `src/**/*.spec.ts`,
`test/**` and `scripts/**` (`ready-for-dev`, `toHaveLength(16)`, `already present`, `acknowledgeComment`,
`ensureLabels`, `new WorkflowEventProcessor(`, `new RouterService(` (none: Nest builds it), `StepContext` literals
(none outside the router), `implements IssueProvider`, `passThrough`, `calls.map((call) => call.method)`,
`labelsOf(…)).toEqual`, `statusBeforeStop:`, `onApplicationBootstrap`). Each row belongs to the task named; a task
isn't done until its rows pass.

- **18 labels** (T1): `src/github/labels.spec.ts:11–15` (16 → 18, distinct names; `bot: working` is neither a status
  nor a human label); `src/github/github-startup.spec.ts:53,56` ("16 created" → "18 created, 0 updated, 0 already
  present") and `:67–81` (its "11 labels of spec 3" are `BOT_LABELS` less the model labels, which now gives 13: the
  fixture names spec 3's eleven explicitly, the log becomes "7 created, 0 updated, 11 already present");
  `src/github/github-issue.provider.spec.ts:52–77` (review: its listed labels have no description, so T1 would send
  an unscripted `PATCH` and the fake answers 501: the fixtures get `BOT_LABELS`' descriptions; a missing or `null`
  description counts as differing), `:79` ("never edits or deletes a label" → updates only a differing
  description of a bot-managed label; never a colour, a name or a human label; never deletes);
  `test/github-startup.integration.spec.ts:20` (16 → 18), `:30–40` (the same explicit eleven);
  `test/fakes/in-memory-issue-provider.ts:15–38` (`STATUSES`, `BOT_LABELS`), its spec `:298` (16 → 18).
- **`TaskStatus` gains `plan-review`** (T1): `src/workflow/stop-cause.ts:84–96` (`waitingStep`: `plan-review` →
  `plan`; `ready-for-dev` unchanged until T5), `src/workflow/stop-cause.spec.ts:102` (a `plan-review` row).
- **The port** (T2): `src/secret-scan/scanning-issue.provider.ts` and the typed `passThrough` table of its spec
  (`:91–106`: it won't compile without both methods); `src/github/github-issue.provider.spec.ts:586–633`
  (`acknowledgeComment`: the 👀 `POST`, then the 🚀 lookup and its delete; a `404` on the `POST` sends nothing more) and
  `:795–812` (the "another repo" table gains both methods); `test/fakes/in-memory-issue-provider.ts`, its spec `:206`
  (unchanged calls; a new case for the rocket); `src/github/smoke/run-smoke.ts:150–157` and `run-smoke.spec.ts:101`
  (the `acknowledgeComment` line, FP14's three lines). `test/grill-round.integration.spec.ts:216` is unchanged (one
  call per acknowledgement).
- **`APPROVED`** (T3): `src/workflow/decide.spec.ts:397–460` (rows 17–19: the call lists become one call, plus the
  `APPROVED` cases). No integration suite changes: what GitHub sees is the same.
- **`plan-review` in `src/documents`** (T4): `src/documents/approval-check.spec.ts` (the nothing-waits verdicts),
  `src/documents/document-comments.spec.ts` (FP1's texts), `test/documents-store.integration.spec.ts:506–540`
  (`waiting()` gains `plan-review` and `needs-human` from it).
- **The router produces `plan-review`** (T5): `src/workflow/decide.spec.ts:296–310` (row 11, unchanged),
  `:397–460` (rows 17–19), `:462–520` (row 20 in `plan-review`), `:532`, `:550`, `:706` (outcomes in
  `ready-for-dev`), `:725–840` (rows 32–35); `src/workflow/stop-cause.spec.ts:102–103` (`ready-for-dev` → `workspace`
  in `full-sdd`, `go-signal` in `code-only`); `test/documents-plan.integration.spec.ts:79,115–116,224,227–252` (the
  Plan under `plan-review`; the crash test fails its status write on `plan-review`), `:501–523` (code-only,
  unchanged); `test/documents-approve.integration.spec.ts:259–261` (row 17 → `plan-review`);
  `test/documents-refresh.integration.spec.ts:409–700` (the "`ready-for-dev`, `full-sdd`" block becomes
  `plan-review`: `:437`, `:510`, `:526`); `test/documents-store.integration.spec.ts:506–540` (`ready-for-dev` →
  the go-signal only; a `full-sdd` run → null); `test/up-to-date-approvals.integration.spec.ts:248–270` (`spec-code`:
  the stop now has `ready-for-dev` before it; the `/retry`'s `/approve` is `done`, so the same stop, still no
  question). Unchanged: `test/run-start.integration.spec.ts:237–253` (row 11), `test/documents-replies…:236,256`.
- **The migration** (T6): `test/webhook.integration.spec.ts:189` (`...failed` spread, gains nothing);
  `test/db.integration.spec.ts` (index list unchanged, FP21).
- **The recovery hook** (T7): `src/events/events.worker.spec.ts:51–66` (reset, then the hook, then the first tick;
  a throwing hook is logged), `:7` and `:72` (processor literals without `recover`: still compile);
  `test/app.ts:76–82` (`ManualEventsWorker` awaits the hook).
- **The sweep** (T8): `src/workflow/workflow-event.processor.spec.ts:12–24` (`new WorkflowEventProcessor(intake,
  router, worker, sweep)`); `test/github-startup.integration.spec.ts:17` (`['ensureLabels']` still: an empty database
  has nothing to sweep).
- **`StepContext.working`** (T10): `CancelContext` omits it (`src/workflow/step-handler.registry.ts:46`); the router
  is the only place that builds a `StepContext`; `test/fakes/scripted-step-handler.ts` unchanged (a script that
  wants the sign calls `context.working()`). `test/retry.integration.spec.ts:58–60,208–232` (`labelCalls` counts
  `setStatusLabel` only: unchanged; the accepted `/retry` gains a `reactWorking` call, a new assertion).
- **Handlers call `working()`** (T11): suites with real handlers record `reactWorking` / `setWorkingLabel` calls;
  none asserts the whole call list (`intake.integration` runs intake only), and every `labelsOf()` check after a model
  step uses `toContain` (`documents-spec:104`, `grill-start:139`, `up-to-date-approvals:125`, …), so none changes.
  `test/grill-round.integration.spec.ts:359` and `test/documents-plan.integration.spec.ts:529` copy `labelsOf()` into
  `setHumanLabels` after the event ended (no `bot: working` left): unchanged. The fake's `reactWorking` accepts a
  comment id it doesn't know, like `acknowledgeComment` (review: many suites' comments exist only as webhooks, e.g.
  `test/retry.integration.spec.ts`), so none of them fails at T10–T11.

## Task List

### Phase 0: The spec and `#I`

- [x] **Task 0: This plan's fixes in the spec; sandbox issue `#I` on today's code** (done 2026-11-26: `#I` is sandbox
  #90, Spec v1 approved, Plan v1 waiting under `status: ready-for-dev`)

**Description:** Write the "Fixes to the spec with no choice" and the confirmed FP1–FP3 lines into the spec (and the
overview's "Step outcomes"), each marked "2026-11-26, plan", and a status note pointing at this plan. Then the one
sandbox step that needs today's code (your OK for `gh` on the sandbox first): you stop `npm run dev` (the tunnel
stays); I build `cb27de3` as it is and run it on port 3000 with the dev database (log in
`node_modules/.cache/sdd-agent-logs/`, `caffeinate -s -i -w <pid>`); I open `#I` ("Add a `--dry-run` flag to the
seed script", labels `grill: skip` and `workflow: full-sdd`), wait for Spec v1, comment `/approve`, wait for Plan v1;
check `tasks.status = 'ready-for-dev'` for `#I` and its Plan's `approved_at` null; stop my instance.

**Acceptance criteria:**
- [ ] Every fix is in the spec and the overview, each marked "2026-11-26, plan"; the spec's status line names this
  plan.
- [ ] `#I` waits with Plan v1 under `status: ready-for-dev` (DB and label).

**Verification:** `git diff docs/specs` shows only those lines; the task query for `#I`.

**Dependencies:** this plan's approval. **Files:** the spec, the overview. **Scope:** XS.

### Phase 1: Labels and the port

- [x] **Task 1: 18 labels, `plan-review` as a status, descriptions updated at startup**

**Description:** `TaskStatus` gains `plan-review` (`src/contracts/issue-provider.ts`); `BOT_LABELS` gains `status:
plan-review` and `bot: working`, `ready-for-dev`'s description becomes BF6's (BFW9, FP18); `isBotManagedLabel()`;
`ensureLabels` updates a differing description of a bot-managed label (BFW7, FP17); `waitingStep('plan-review')` →
`plan`. The fake's label list. Nothing sets `plan-review` yet.

**Acceptance criteria:**
- [ ] An empty repo gets 18 labels; a repo with spec 4's 16 gets 2 created, 1 updated (`ready-for-dev`'s
  description, `PATCH` with the description only); a recoloured `status: ready-for-dev` keeps its colour; a
  human label with a different description is never touched; nothing is deleted.
- [ ] `removeLabel('bot: working')` is refused (spec 3 A4: not a human label).
- [ ] Every row of "18 labels" and "`TaskStatus` gains `plan-review`" above passes.

**Verification:** `npx vitest run src/github src/workflow/stop-cause.spec.ts`; the four commands.

**Dependencies:** T0. **Files:** `src/contracts/issue-provider.ts`, `src/github/labels.ts` (+ spec),
`src/github/github-issue.provider.ts` (+ spec), `src/github/github-startup.spec.ts`, `src/workflow/stop-cause.ts`
(+ spec), `test/fakes/in-memory-issue-provider.ts` (+ spec), `test/github-startup.integration.spec.ts`. **Scope:** M
(small edits in many files).

- [x] **Task 2: The port: `reactWorking`, `setWorkingLabel`, `acknowledgeComment` removes the bot's 🚀**

**Description:** BFW12 on `IssueProvider`, the GitHub adapter (FP16), the scanning wrapper (pass-through), the fake
(FP15) and `npm run github:smoke` (FP14). No caller yet.

**Acceptance criteria:**
- [ ] `reactWorking`: `POST …/reactions {content: 'rocket'}`, `201`/`200` fine, `404` skipped (a log line), other
  errors thrown with their kind; `setWorkingLabel(true)` adds `bot: working`, `false` removes it, `404` counts as
  removed.
- [ ] `acknowledgeComment` adds 👀, then removes only the bot's own 🚀 (a person's 🚀 stays); no 🚀 → no `DELETE`.
- [ ] Every row of "The port" above passes; the smoke's three new `PASS` lines in its unit test.

**Verification:** `npx vitest run src/github src/secret-scan test/fakes`; the four commands.

**Dependencies:** T1. **Files:** `src/contracts/issue-provider.ts`, `src/github/github-issue.provider.ts` (+ spec),
`src/secret-scan/scanning-issue.provider.ts` (+ spec), `test/fakes/in-memory-issue-provider.ts` (+ spec),
`src/github/smoke/run-smoke.ts` (+ spec). **Scope:** M.

### Checkpoint 1: after T1–T2

- [x] The four commands green.
- [x] (2026-11-26: as written; the smoke ran on a new issue, #91, closed after) **Sandbox (your OK for `gh` writes on the sandbox's labels, a GitHub write outside the bot):** `npm run dev` is
  still stopped (since T0). I build and run my instance on 3000 → the log reads `Labels on Hugoer/sdd-agent-sandbox:
  2 created, 1 updated, 15 already present` (checked 2026-11-26: the sandbox has spec 4's 16 labels with today's
  descriptions); `gh api …/labels` lists both new labels, `status: ready-for-dev` with BF6's description and colour
  `0e8a16`. I change that description by hand (`gh api -X PATCH`), restart → back to BF6's, "0 created, 1 updated, 17
  already present"; I recolour it to `0e8a17`, restart → the colour stays, "0 updated"; I put `0e8a16` back. I stop my
  instance and run `npm run github:smoke -- --issue <a sandbox test issue>`: every line `PASS`. Matrix row
  "Startup log" ticked.
- [ ] You review and commit; you may run `npm run dev` again until T5.

### Phase 2: The statuses and the migration

- [x] **Task 3: The `APPROVED` outcome (nothing changes on GitHub)**

**Description:** FP4 with today's statuses: the three `approve` ops return `APPROVED`; `decide()` maps it
(`spec-review` + `full-sdd` → the Plan, then `ready-for-dev` as today; `spec-review` + `spec-code` and
`ready-for-dev` → the claim, no status yet). A pure refactor that T5 then changes in one place.

**Acceptance criteria:**
- [ ] Every integration suite passes unchanged (same comments, same statuses, same stops).
- [ ] `decide.spec.ts`: rows 17–19 as one call each, and `APPROVED` per status and lane.

**Verification:** `npx vitest run src/workflow/decide.spec.ts`; the four commands.

**Dependencies:** T1. **Files:** `src/workflow/decide.ts` (+ spec), `src/documents/spec.handler.ts`,
`src/documents/plan.handler.ts`, `src/documents/go-signal.handler.ts`. **Scope:** S.

- [x] **Task 4: `src/documents` reads `plan-review` (not produced yet)**

**Description:** `DocumentsStore.waiting('plan-review')` → the current Plan (and `needs-human` stopped from it);
`lastApproved(runId)` (FP12); the gate in `ready-for-dev` with nothing waiting answers `done` (this event made an
run's last approved document, FP12) or `already-approved` (BFW6), instead of throwing; `refuseApprove` with no
waiting document names `lastApproved`; `NOTHING_WAITS` by status and lane with FP1's texts (FP19). The `ready-for-dev`
paths for a waiting Plan stay until T5.

**Acceptance criteria:**
- [ ] `approval-check.spec.ts`: nothing waits in `ready-for-dev` → `done` when this event approved the run's last
  approved document, else `already-approved` (also when this event approved only an earlier one, the Spec).
- [ ] A `spec-code` run in `ready-for-dev`, `/approve` from another person → spec 7's "already approved" reply
  naming the Spec (today: the gate throws), in `test/bot-feedback.integration.spec.ts`.
- [ ] Every row of "`plan-review` in `src/documents`" passes.

**Verification:** `npx vitest run src/documents`; `npx vitest run -c vitest.integration.config.ts
test/documents-store.integration.spec.ts test/bot-feedback.integration.spec.ts`; the four commands.

**Dependencies:** T3. **Files:** `src/documents/documents.store.ts`, `src/documents/approval-check.ts` (+ spec),
`src/documents/documents.handler.ts`, `src/documents/document-comments.ts` (+ spec),
`test/documents-store.integration.spec.ts`, `test/bot-feedback.integration.spec.ts` (new). **Scope:** M.

- [x] **Task 5: The router produces `plan-review`; `ready-for-dev`'s new meaning**

**Description:** **Stop `npm run dev` before this task** (see "When `npm run dev` must be stopped"). `decide()`: row
17 → `plan-review`; `APPROVED` in `spec-review` + `spec-code` and in `plan-review` → `ready-for-dev` first, then the
claim (rows 18, 19, BFW6); rows 20, 32, 33, 34 in `plan-review`; row 35 in `ready-for-dev` for every lane; `done` in
`ready-for-dev` → the claim (`plan-review`'s `done` stays "nothing, `DONE`", spec 7 P27). The router's `approvalOf`
asks the gate in `plan-review` too. `waitingStep('ready-for-dev')` → `go-signal` in `code-only`, `workspace`
otherwise. `waiting('ready-for-dev')` → the go-signal only. The Spec refresh and the Plan refresh read the waiting Plan
under `plan-review` (`spec.handler.ts:183–188,273`, `plan.handler.ts:188`).

**Acceptance criteria:**
- [ ] `full-sdd`: Spec `/approve` → Plan v1 under `plan-review`; Plan `/approve` → `ready-for-dev`, then the
  `workspace` stop with `status_before_stop = 'ready-for-dev'`; `/retry` → `ready-for-dev`, the `/approve` runs again
  as `done` → the same stop, NO reply (BFW6's testable path).
- [ ] `spec-code`: `/approve` → `ready-for-dev`, then the stop. `code-only`: unchanged (go-signal under
  `ready-for-dev`, `/approve` → the stop).
- [ ] `ready-for-dev` after every approval: `/refresh`, `/restore` → FP1's replies; `/approve` by another person →
  "already approved" naming the Plan (`full-sdd`) or the Spec (`spec-code`); a near-miss `/approve` → nothing (no
  waiting document); `plan-review`: rows 20, 32–34 as spec 7 had them in `ready-for-dev`.
- [ ] Every row of "The router produces `plan-review`" passes.

**Verification:** `npx vitest run src/workflow src/documents`; the integration suites listed; the four commands.

**Dependencies:** T4. **Files:** `src/workflow/decide.ts` (+ spec), `src/workflow/router.service.ts`,
`src/workflow/stop-cause.ts` (+ spec), `src/documents/documents.store.ts`, `src/documents/spec.handler.ts`,
`src/documents/plan.handler.ts`, and the five integration suites listed. **Scope:** L (one behaviour, many small test
edits; the source changes are a few lines each).

- [x] **Task 6: The migration: three columns and the data rule** (2026-11-27: `20261126221256_bot_feedback`; the dev
  database migrated with `prisma migrate deploy`; #90 and seven older sandbox issues, #49, #50, #55, #64, #73, #74,
  #78, now read `plan-review` with `shown_status` `ready-for-dev`)

**Description:** `tasks.working_event_id` (uuid, nullable, no foreign key), `webhook_events.working_started_at`,
`working_ended_at` (timestamptz, nullable) in `prisma/schema.prisma`; one migration `…_bot_feedback` made with
`prisma migrate dev --create-only` against the test database's schema, with FP11's two `UPDATE`s after a `-- Data
(spec 13 BFW11)` marker; its test in `test/bot-feedback-recovery.integration.spec.ts` (new) runs those statements on
seeded rows. At the end **you run `npm run db:migrate`** on the dev database (I tell you when).

**Acceptance criteria:**
- [ ] Seeded: `full-sdd` in `ready-for-dev` with an unapproved current Plan → `plan-review`; with an approved Plan →
  unchanged; with an unapproved Plan superseded by an approved one → unchanged; `code-only` and `spec-code` →
  unchanged; a stopped `full-sdd` run with `status_before_stop = 'ready-for-dev'` and an unapproved Plan →
  `plan-review`; `shown_status` never changed.
- [ ] After your `npm run db:migrate`, `#I` reads `status = 'plan-review'`, `shown_status = 'ready-for-dev'`.

**Verification:** the new suite; `npx prisma migrate status` on the dev database after you migrate; the four
commands.

**Dependencies:** T5. **Files:** `prisma/schema.prisma`, `prisma/migrations/<ts>_bot_feedback/migration.sql`,
`test/bot-feedback-recovery.integration.spec.ts`. **Scope:** S.

### Checkpoint 2: after T3–T6

- [x] The four commands green; the dev database migrated (I did, as you asked on 2026-11-26).
- [ ] You review and commit. `npm run dev` may run again during T7, and must be stopped when T8 starts; leave `#I`
  alone until Checkpoint 3 (its label still says `ready-for-dev` until the sweep runs).

### Phase 3: After a restart

- [ ] **Task 7: The worker's recovery hook**

**Description:** FP13, FP23: `EventProcessor.recover?()`; `EventsWorker.onApplicationBootstrap()` →
`resetInterrupted()`, then the first tick as today; the first tick awaits the hook once before it claims anything; a
throwing hook is one error line. `ManualEventsWorker` (test, no polling loop) awaits it in its bootstrap, so a suite's
first `drainOnce()` comes after the sweep. `src/events` still imports no feature module (BFW10).

**Acceptance criteria:**
- [ ] `events.worker.spec.ts`: the order reset → first tick → hook → first claim, the hook once (not on later
  ticks); the bootstrap doesn't wait for the hook; a processor without `recover` starts as before; a throwing hook →
  one error line and the worker still claims.

**Verification:** `npx vitest run src/events`; the four commands.

**Dependencies:** T6. **Files:** `src/events/event-processor.ts`, `src/events/events.worker.ts` (+ spec),
`test/app.ts`. **Scope:** S.

- [ ] **Task 8: The startup sweep**

**Description:** `StartupSweepService` (`src/workflow`, BFW10, FP9, FP10): every task with a mark whose event is
finished (`DONE`, `IGNORED`, `FAILED`) or gone → `setWorkingLabel(false)`, mark cleared; a mark whose event is
`PENDING` or `PROCESSING` stays (one line); every task whose `shown_status` differs from `status` (spec 5's
`labelPending`) → `setStatusLabel`, `shown_status` set. Each task under FP9's lease, released after; a lease held by
a `PROCESSING` event → skipped; a GitHub failure → one line, the next task. `SessionLeaseService.withIdleLease()`;
`TaskService.clearWorkingMark(lease, eventId)`. `WorkflowEventProcessor.recover()` calls it.

**Acceptance criteria:**
- [ ] `bot-feedback-recovery.integration.spec.ts` (booted with `keepData`): a mark on a `DONE`, `FAILED`, deleted
  event → label removed, mark null; on a `PENDING` event → left; a status differing → its label set and
  `shown_status` updated; `draft` with no label → nothing; a lease owned by a `PROCESSING` event → skipped; a lease
  owned by a `PENDING` event (after `kill -9`) → taken; `setWorkingLabel` failing for one task → one line, the other
  task still done; the summary line.
- [ ] An empty database: no provider call besides `ensureLabels` (`github-startup.integration:17` unchanged).
- [ ] With the polling worker (`startApp({ pollingWorker: true })`): the webhook endpoint answers while a sweep
  whose `setStatusLabel` is held open runs; the stored event is claimed only after the sweep ends (FP23).

**Verification:** the new suite; the four commands.

**Dependencies:** T7. **Files:** `src/workflow/startup-sweep.service.ts` (new), `src/workflow/session-lease.service.ts`,
`src/workflow/task.service.ts`, `src/workflow/workflow-event.processor.ts` (+ spec), `src/workflow/workflow.module.ts`,
`test/bot-feedback-recovery.integration.spec.ts`. **Scope:** M.

### Checkpoint 3: after T7–T8

- [ ] The four commands green.
- [ ] **Sandbox (your OK for `gh` and the SQL below; `npm run dev` stopped since T8):** in this order, my instance on
  3000:
  1. Start → the summary counts `#I` among the status labels repaired (other old sandbox issues whose Plan waited
     under `ready-for-dev` too; you said you don't mind); `#I` shows `status: plan-review`. Matrix "Migration" row,
     first half.
  2. **Status repair:** I set `#I`'s `shown_status` to `spec-review` (SQL) and its label to `status: spec-review`
     (`gh`), restart → `status: plan-review` again, "1 status label repaired".
  3. **Leftover:** I set `#I`'s `working_event_id` to one of its `DONE` events (SQL) and add `bot: working` (`gh`),
     restart → the label removed, the mark null, "1 working label removed".
  4. **Migration, second half:** `/approve` on `#I`'s Plan → `status: ready-for-dev`, then the `workspace` stop
     (`needs-human`, the stop comment; the task query shows `status_before_stop = 'ready-for-dev'`). No sign exists yet.
  Stop my instance.
- [ ] You review and commit.

### Phase 4: The working sign

- [ ] **Task 9: The sign's service**

**Description:** `WorkingSignService` (`src/workflow`): `on(target, eventId, commentId | null)` in FP6's order;
`end(target, eventId)` (FP7: label off when the task's mark is this event, then the mark cleared; a GitHub failure →
one line, the mark stays); `pending(target, task, eventId)` (FP8); `EventsService.workingStarted(eventId)`
(`COALESCE`) and `workingEnded(eventId)` (only with `working_started_at`), and `requeue`/`requeueFailed` clearing
both (FP3; `test/webhook.integration.spec.ts:189`'s `...failed` spread then needs both null: its row never started,
so unchanged); `TaskService.markWorking(lease, eventId)` (set when empty or this event;
returns whether this event holds it). FP10's lines.

**Acceptance criteria:**
- [ ] Integration (the service with the fake and the test database): on → mark, 🚀, label, in that order (a fake
  that fails each step in turn leaves: nothing; a mark only; a mark and 🚀); on twice → one label call each time the
  event holds the mark, 🚀 `200`; on while another unfinished event holds the mark → 🚀 only, the mark unchanged; end
  of the holder → label removed, mark null; end of a non-holder → nothing; end failing → the mark stays; pending on a
  finished holder → removed; on a `PENDING` holder → left.
- [ ] `working_started_at` kept through a second `on`; `working_ended_at` written only for an event that started.

**Verification:** `test/working-sign.integration.spec.ts` (new); the four commands.

**Dependencies:** T8. **Files:** `src/workflow/working-sign.service.ts` (new), `src/workflow/task.service.ts`,
`src/events/events.service.ts`, `src/workflow/workflow.module.ts`, `test/working-sign.integration.spec.ts`.
**Scope:** M.

- [ ] **Task 10: The router's hooks; 🚀 on an accepted `/retry`**

**Description:** `StepContext.working()` (BFW1; `CancelContext` omits it), made per job from the event's comment
(BFW4: `COMMENT`, `APPROVE`, `REFRESH`; none for the label events); `route()` runs `end` after `handle()` inside the
lease and writes `working_ended_at`; `failed()` writes `working_ended_at`, then runs `end` last under the lease (after
the stop, also when there is none); `handle()` runs `pending` first among the pending side effects; `acceptRetry`
adds 🚀 to the `/retry` before its write (BF10, FP5).

**Acceptance criteria (in `test/bot-feedback.integration.spec.ts`, scripted handlers that call `context.working()`):**
- [ ] A handler calling `working()` twice → one mark, one 🚀, one label on; the label off after the status label and
  the handler's comment; mark null.
- [ ] A transient error after `working()` → the label stays, the retried attempt ends it (one removal); a permanent
  error → the stop comment and `needs-human` first, then the label off.
- [ ] An attempt after `working()` that fails in intake (`getAccessLevel` failing three times → `FAILED`, no router
  mark), or that intake ignores on its retry → the label off, mark null (review).
- [ ] The next event on the issue removes a label the holder left (its removal failed); a `/retry` accepted → 🚀 on
  it before `setStatusLabel`; refused → no 🚀; a reply-only path (`documents` reply, `/approve` while grilling) → no
  sign.

**Verification:** the suite; `test/retry.integration.spec.ts`; the four commands.

**Dependencies:** T9. **Files:** `src/workflow/router.service.ts`, `src/workflow/step-handler.registry.ts`,
`src/workflow/workflow-event.processor.ts` (+ spec), `test/bot-feedback.integration.spec.ts`,
`test/retry.integration.spec.ts` (one assertion). **Scope:** M.

- [ ] **Task 11: The handlers call `working()`**

**Description:** Right before each `LlmService.call()`: Grill Me's evaluation (`grill-evaluation.service.ts:115`),
the Spec (`spec.handler.ts:97`), the Plan (`plan.handler.ts:97`), the refresh (`document-refresh.ts:103`, after the
"nothing changed" return, so that reply shows no sign). Grill Me's 👀 already removes the 🚀 (T2).

**Acceptance criteria (`test/bot-feedback.integration.spec.ts`, real handlers, scripted model):**
- [ ] The label on and off, no reaction, for a run start (Grill's first evaluation; with `grill: skip`, the Spec);
  🚀 + label for a Grill answer, `/approve` → Plan, `/refresh` with `main` moved; `grill: skip` added while asking →
  the label only.
- [ ] A Grill answer that waits → 👀 and NO 🚀 at the end (BF8); a burst of three answers → 🚀 on the event's
  comment only.
- [ ] NO sign: `/refresh` with `main` unmoved, spec 14's question, an `/approve` that is refused, the last
  `/approve` (the `workspace` stop), a step-config stop (before the call), a plain comment.
- [ ] `webhook_events`: both times set for each event that showed the sign, null for the others.

**Verification:** the suite; the four commands.

**Dependencies:** T10. **Files:** `src/grill/grill-evaluation.service.ts`, `src/documents/spec.handler.ts`,
`src/documents/plan.handler.ts`, `src/documents/document-refresh.ts`, `test/bot-feedback.integration.spec.ts`.
**Scope:** M.

### Checkpoint 4: after T9–T11

- [ ] The four commands green.
- [ ] You review and commit (you may try the sign on the sandbox yourself with `npm run dev`).

### Phase 5: Invariants, docs, matrix

- [ ] **Task 12: The invariant script**

**Description:** `scripts/bot-feedback-invariants.mjs` and its `.spec.mjs` (BFW14, FP22), read-only like spec 14's:
`node --env-file-if-exists=.env scripts/bot-feedback-invariants.mjs <issue>…`. The four invariants as the spec
words them; the pure checks exported.

**Acceptance criteria:**
- [ ] Each check has a passing fixture and a failing one in the `.spec.mjs`: a `bot: working` label on a given
  issue, a task with a mark; a comment with the bot's 🚀 and 👀; a 🚀 on a comment whose event has no `execution_logs`
  row in its own working window (FP24), including the review's overlap: a second Grill answer whose arrival and end
  span the first answer's model rows but which never started working, which must fail (and one on an accepted `/retry`, which passes; one on a refused `/retry`, which fails); a
  `full-sdd` issue labelled `ready-for-dev` with an unapproved current Plan.
- [ ] A live run that must fail: I set one task's `working_event_id` with SQL (a `DONE` event, no GitHub change),
  the script exits 1 naming invariant 1; I clear it, the script exits 0 on `#I`.

**Verification:** `npm test` (the `.spec.mjs` runs with the unit suite); the live run.

**Dependencies:** T11. **Files:** the two script files. **Scope:** M.

- [ ] **Task 13: The guide, `AGENTS.md`, the README, the status lines**

**Description:** `docs/guides/setup-github-agent-local.md`: "Reference: labels" (18, the two new rows,
`ready-for-dev`'s description), the startup lines (`2 created, 1 updated, 15 already present`; descriptions of
bot-managed labels are kept up to date), "When an issue is in …" (`plan-review`; `ready-for-dev` after every
approval), the working sign (🚀, `bot: working`, when it shows and when not, 👀 replacing 🚀, a crash and the sweep),
"Usage data" (the spec's wait query), `npm run db:migrate` after pulling, the line at `:1001` ("until spec 13 also
means …"). This repo's `AGENTS.md` (State) and the README's built list. Check the earlier specs' dated notes
(applied at approval) still match FP1–FP3.

**Acceptance criteria:**
- [ ] `grep -n -e "16 labels" -e "16 created" -e "until spec 13" -e "waiting for /approve to start the Coder"
  docs/guides/setup-github-agent-local.md README.md` finds nothing.
- [ ] The guide names every log line of FP10 a developer may see.

**Verification:** read-through; the grep.

**Dependencies:** T12. **Files:** the guide, `AGENTS.md`, `README.md`. **Scope:** S (docs).

- [ ] **Task 14: The verification matrix**

**Description:** I run every row I can (build, my instance on port 3000 with the dev database and your tunnel, SQL,
log grep, tests); the sandbox GitHub steps with `gh` as you, on `Hugoer/sdd-agent-sandbox` only, once you say so
(sandbox commits to `main` included, one file per commit with `gh api -X PUT …/contents/…`). Before the first event:
`pgrep -fl ngrok` (else `npm run tunnel` in the background, stopped at the end), `caffeinate -s -i -w <pid>`, a fresh
log file per start, `NO_COLOR=1`. Before every row that checks "within seconds" (steps 2, 3, 5, 6, 8–11), I wait
until `db:events` shows no `PENDING` row (the spec's "within seconds" holds only with nothing queued; review). If
`gemini-4-carbon` hangs, one sandbox commit switches the models and one switches
them back (your OK). Rows already ticked at Checkpoints 1 and 3 aren't run again. The order, so no shared sandbox
commit reaches an issue meant for another row:

1. **Open the issues** (each with a short, specific description unless said otherwise; labels added after the issue
   is open, so the run starts from the label event):
   `#A` `workflow: full-sdd`, vague enough to ask ("Add a discount feature"): **row "Add `workflow: full-sdd`"**
   (label within ~10 s, no reaction anywhere, the questions, the label gone, mark null). `#B` the same way, vague
   ("Improve the reports"). `#C` `spec-code` + `grill: skip`; `#D` `spec-code` + `grill: skip`; `#E` `code-only`;
   `#F`, `#G`, `#H` `full-sdd` + `grill: skip`. Their Specs are written one at a time (a few minutes each). While
   `#D`'s Spec is written: **row "A person removes `bot: working`"** (I remove it with `gh`; it isn't put back; `#D`'s
   Spec is posted and the bot's own removal finds it gone; the person's `unlabeled` event ends `IGNORED`
   `other-label`).
2. **`#A`:** answer every question in one comment → 🚀 + label, Spec under `spec-review`, label gone, 🚀 stays.
3. **`#B`:** answer one question only, "I'll answer the rest later" → 🚀 then 👀, at the end 👀 only. Then `/approve`
   on `#B` → spec 6's reply, NO 🚀, NO `bot: working` at any time (issue events). If the model proposes new
   questions instead of waiting (spec 11's lesson), I try once more with a clearer partial answer, then write the
   row down with the integration test that covers it (T11).
4. **`#J`** (a new issue, no label): `/retry` → the reply, NO 🚀, NO label; then I add `bot: working` with `gh` →
   `db:events` `IGNORED` `other-label`; I remove it again.
5. **`#A`:** `/approve` the Spec → 🚀 + label, Plan v1, `status: plan-review`, label gone. A plain comment → NO 🚀,
   NO label. Then one sandbox commit adding `docs/bot-feedback-matrix.md` (no document read it, so no spec 14
   question anywhere), and `/refresh` → 🚀 + label, "still up to date" (if the model writes Spec v2 instead, `#A` is
   back in `spec-review`: `/approve` → Plan v2, then on), label gone.
6. **`#A`:** `/approve` the Plan → `ready-for-dev`, then the `workspace` stop, `status_before_stop` `ready-for-dev`,
   NO sign. `/retry` → 🚀 on it within seconds, `ready-for-dev`, the `/approve` runs again → the same stop, NO
   "already approved" reply, NO `bot: working`. `/refresh` → spec 7's "stopped" reply.
7. **`#D`:** `/approve` → `ready-for-dev`, the stop, NO Plan. **`#E`:** the "Ready to code" comment under
   `ready-for-dev`; `/approve` → the stop.
8. **`#G` (the `workflow.json` break):** first `context_loads` is checked to hold no `.github-agent/workflow.json`
   row (so the commit can't trigger a spec 14 question elsewhere) and no other Plan is being written or refreshed.
   One sandbox commit sets `models.standard.plan` to `gemini-bot-feedback-missing`; `/approve` on `#G`'s Spec → 🚀 +
   label, the stop comment, label gone, `needs-human`. One commit puts the model back; `/retry` → 🚀 on the `/retry`
   within seconds, `spec-review` (T0's fix), then the label, Plan v1 under `plan-review`, the label gone.
9. **`#H` (`kill -9`):** `/approve` on `#H`'s Spec; once the log shows `#H working on`, I `kill -9` my instance's pid
   (only that pid) → `bot: working` stays on GitHub; restart (and a new `caffeinate -s -i -w <new pid>`: the old one
   ended with the killed pid) → the sweep line "left for event … (pending)"; the
   `/approve` runs again, Plan v1, the label gone.
10. **`#F` (Wi-Fi):** a background script in `node_modules/.cache/sdd-agent-logs/` waits for `#F working on` after
    I comment `/approve`, then says "Wi-Fi off" (`say`); you turn Wi-Fi off; it waits for `attempt 1/3 failed` (at
    most 60 s), says "Wi-Fi on"; you turn it back on; it waits for `#F working off` and writes the issue events, the
    row's `attempts` and `wait_s` to a file. Expected: ONE `bot: working` added and ONE removed, the Plan posted,
    `attempts` 2 or 3, `wait_s` from the first attempt. If the in-flight call survives the outage (no failure in 60
    s), the row is written down with T10's integration test (a transient error keeps the label) and left unticked.
11. **`#C` (spec 14's question):** last, after every other `/approve`: one sandbox commit changing a file `#C`'s
    Spec read (from its `context_loads` rows), then `/approve` → spec 14's question, NO 🚀, NO label.
12. **Usage query:** one row per event that showed the sign above, with a `wait_s`; NO row for `#A`'s plain comment.
13. **Invariants** with the app idle: `node --env-file-if-exists=.env scripts/bot-feedback-invariants.mjs` on `#A`
    to `#J`. Then the test commits are undone, as in spec 7's build: one commit removing `docs/bot-feedback-matrix.md`
    and one putting back the file step 11 changed (review), so the sandbox's `main` has the same files as before the
    matrix.

**Acceptance criteria:** every row ticked in the spec, or written down with why and the test that covers it; the
spec's and this plan's status lines say "built and verified 2026-…".

**Dependencies:** T0–T13. **Files:** the spec, this plan. **Scope:** —.

### Checkpoint 5: complete

- [ ] Every matrix row and invariant passes; the sandbox's `main` has the same files as before the matrix.
- [ ] You commit.

## Review (fresh context, 2026-11-26)

A subagent with no knowledge of this session read the spec, the plan and the code. It confirmed every claim about
the existing mechanics the plan relies on (the `steps` action and its outcomes, the gate throwing when nothing waits,
`retryWritten` after an accepted `/retry`, the worker's 5 s / 30 s retries, `ensureLabels` before the sweep, the T0
spec fixes) and found:

1. **Medium:** a `watch` reload of `npm run dev` after T8 would run the sweep before Checkpoint 3's first row.
   Fixed: the stop table (T8 to the end of Checkpoint 3).
2. **Medium:** invariant 3's window isn't exact (a burst, a comment during the Spec). A choice: FP24.
3. **Medium:** `github-issue.provider.spec.ts:52–77` lists labels without descriptions, so T1's update would send an
   unscripted `PATCH`. Fixed: listed under T1.
4. **Low/Medium:** `done` from any approval by this event is looser than BFW6. Fixed: FP12, T4.
5. **Low:** an attempt that ends in intake after `working()` left the label on. Fixed: FP7, T10.
6. **Low:** the sweep inside the bootstrap delays the webhook port. A choice: FP23.
7. **Low:** "within seconds" rows need an empty queue; `caffeinate` after `kill -9`. Fixed: T14.
8. **Low:** `#C`'s commit stayed on the sandbox. Fixed: undone in T14 step 13 (spec 7's practice).
9. **Low:** the fake's `reactWorking` on unknown comments, three new suites (not two), the `approved` reply only for
   `/refresh` and `/restore`. Fixed: the grep list, FP20, FP19.

Not tested on purpose (each follows from code already tested): BFW15 and three edge cases (the lane label removed
while the Spec is written, the issue closed while the bot works, the triggering comment deleted before its turn).

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| A code task leaves a suite red because a test constructs or asserts what it changed | Medium: red suites mid-build | the grep list above, each row in the task that changes it |
| T5's code runs against unmigrated data, or T6's schema against an unmigrated database | High for the dev bot: wrong replies to waiting Plans, then every query fails | `npm run dev` stopped from T5 to your `npm run db:migrate` (table at the top) |
| A sandbox commit meant for one row reaches another issue's `/approve` (a spec 14 question instead of the expected status) | Medium: a row fails for the wrong reason | the matrix order: unread file for `/refresh`, the `workflow.json` break with nothing else writing a Plan, `#C`'s commit last |
| The Wi-Fi outage doesn't break the in-flight model call | Low: one row can't be shown on the sandbox | the script's 60 s limit; T10's test for the retried label |
| The model doesn't wait on a partial Grill answer (`#B`) | Low | one retry, then the row written down with T11's test |
| The startup sweep relabels many old sandbox issues at Checkpoint 3 | Low (sandbox only, you said you don't mind) | said at Checkpoint 3; the summary line counts them |
| `gemini-4-carbon` hangs during the matrix | Medium: rows wait | one sandbox commit to another model, one back (spec 12's build) |

## Open Questions

None: FP1–FP3, FP23 and FP24 confirmed 2026-11-26.
