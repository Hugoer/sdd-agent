# Implementation Plan — Spec #2: Intake & Authorization

> **Created:** 2026-11-11 · **Status:** approved 2026-11-11 (including P1–P9) · build started 2026-11-11
>
> **Why this file exists:** turns the approved spec `docs/specs/spec-github-agent-intake-authorization.md` into
> ordered, verifiable tasks (skill `agent-skills:planning-and-task-breakdown`). The spec stays normative: this plan
> adds order, slicing and build-time decisions only. The task checklist lives here (repo placement rules override
> the skill's `tasks/todo.md`). It is the one plan for everything the spec changes, including the code that specs
> 1 and 3 built (`src/events`, `src/github`, the fakes).
>
> **Also read:** `docs/specs/spec-github-agent-architecture-overview.md` §3 ("Inputs", "Ignored at intake"), §4
> (contracts) and §7 (rules 2–4).

## Overview

Replace the hello comment with intake: every stored event becomes a neutral `WorkflowInput` from an allowed
sender, or an ignore reason. Built in 16 tasks across 5 phases:

1. **Changes to what specs 1 and 3 built**, while the hello still runs: the `external_ref` column, the redelivery
   of a `FAILED` event, the two access levels on the port.
2. **Intake wired into the worker with one event kind** (`issues.opened`). The riskiest change (the worker's
   processor seam and the removal of the hello) is therefore tested on real GitHub first.
3. **Label events and the label revert.**
4. **Comments, `/approve` and its reply, pull requests, failure paths.**
5. **Docs and the verification matrix.**

Real GitHub is reached at every checkpoint. You review the work and commit at each one (I never commit).

## Build-time decisions (not in the spec; confirmed 2026-11-11)

| # | Decision | Why |
|---|---|---|
| P1 | The registration of AW5 lives on the worker: `EventsWorker.registerProcessor(processor)`, and `EventsModule` exports the worker. Exactly one processor: with none the app does not start, a second one is refused. | No new class and no module cycle. A second registration can only be a wiring mistake (spec 5 replaces the placeholder, it doesn't add to it). |
| P2 | `AppModule` imports `IntakeModule`. | Something must load it; `src/app.module.ts` is not in the spec's "Project structure". |
| P3 | The worker's integration tests (`test/worker.integration.spec.ts`) run with a scripted processor, registered through the same seam (`startApp({ processor })`). Intake gets its own file, `test/intake.integration.spec.ts`. | Today those tests watch the hello. Tied to intake they would break again when spec 5 replaces the processor. |
| P4 | Fixtures are one TypeScript module of builder functions, `test/fixtures/github/payloads.ts`, not JSON files. Field paths and types come from the stored sandbox deliveries; repo and logins are test values. The dev database has no delivery for: `unlabeled` with a label, a comment `edited` / `deleted`, a comment on a pull request, `pull_request` `opened` / `synchronize` (only `closed`). Those builders are derived from the nearest real one. | No `tsconfig` change for JSON imports, and tests can vary sender, label and text. A wrong path in a derived builder shows on real GitHub as `invalid-payload` (Checkpoints 2–4 and the matrix). |
| P5 | Intake's log line (`accepted …` / `ignored …`, with the sender) is written by `IntakeService`. The worker keeps its own status line (`… DONE`, `… IGNORED (reason)`, retries, `FAILED`). So an event shows two lines, not the one line the spec's "Logging" names. | The intake line survives spec 5 (which keeps `IntakeService` and replaces the processor), and the worker never reads a payload. |
| P6 | The fake's `getAccessLevel` checks that the ref is in its repo, not that the issue was seeded. | The GitHub adapter never reads the issue for this call, and AW6 passes a ref built from a pull request number. |
| P7 | The migration's back-fill is tested: an integration test runs the `UPDATE` statement from the migration file on rows stored with an empty `external_ref` and compares the result with `externalRefOf()`. | The spec wants "the same rule" in SQL and in TypeScript; your dev database holds real rows. |
| P8 | The migration file is created against the test database. The dev database changes only when you run `npm run db:migrate`. | As in specs 1 and 3: I don't touch your dev data. |
| P9 | Intake goes live at Checkpoint 2 with one event kind, not at the end. The hello stays through T5–T7 (registered through the new seam) and is deleted in T8. Until Checkpoint 4 the app is incomplete on purpose: an event family not built yet ends `unsupported-event`; a lane label added with no access (until T10) and a Participant's `/approve` (until T12) end `unauthorized` with no answer. | Every task leaves a working app, and each family is checked on real GitHub at its own checkpoint. Nothing reads accepted inputs before spec 5, so the gaps have no effect. |

## Dependency graph

```text
T1 external_ref column ── T2 redelivery of a FAILED row ──────────────────────────┐
T3 access levels (port, adapter, fake) ── T4 smoke; hasWriteAccess removed        │
 │   T5 worker seam (the hello registers itself)                                  │
 │    │   T6 WorkflowInput + reasons + classify core (uses T1's externalRefOf)    │
 └────┴────┴── T7 IntakeService + placeholder processor + IntakeModule            │
                └── T8 intake replaces the hello                                  │
                       └── T9 label events ── T10 label revert                    │
                              └── T11 comment events + /approve ── T12 reply      │
                                     └── T13 pull request events                  │
                                            └── T14 failure paths end to end ─────┘
                                                   └── T15 docs ── T16 matrix
```

T9–T13 edit the same files (`github-payload.ts`, `intake.service.ts`, the payload builders, the integration
spec), so they run one after another.

**Your part (the build stops for these):**

1. **After T1:** run `npm run db:migrate` (dev database: one new column and one index, existing rows get their
   reference, nothing is deleted), then restart `npm run dev`. Until then your running app can't read the table.
2. **Checkpoint 1:** stop `npm run dev` while I run the smoke script (`nest build` empties `dist/`). The test
   issue of spec 3 works if it has `grill: skip` and `bug` again (setup guide, step 11).
3. **Checkpoints 2–4:** the GitHub clicks named there (open an issue, add and remove labels, comment), one step
   per message.
4. **T16:** the other GitHub UI steps (edit and delete a comment, close and reopen, a pull request made by hand,
   the branch `smoke/spec-2` with one commit and later a second one, redeliveries from the App's "Recent
   deliveries", deleting the bot's revert comment) and the Wi-Fi rows.

---

## Phase 1 — Changes to what specs 1 and 3 built (the hello still runs)

### Task 1: `external_ref` column, filled when an event is stored

**Description:** `WebhookEvent.externalRef` with its index and its migration (P7, P8). A pure
`externalRefOf(payload)` with the rule of the spec's "When an event is stored". `EventsService.enqueue` fills the
column. `npm run db:events` also shows `external_ref` and the sender.

**Acceptance criteria:**
- [x] `externalRefOf`: issue, comment, comment on a pull request and pull request payloads → `owner/repo#number`;
  no issue and no pull request, or a missing or wrongly typed field → `null`; it never throws (unit)
- [x] A stored event has its `external_ref`; a payload without an issue is stored with none and still answers
  `202` (integration)
- [x] The migration's back-fill gives rows stored earlier the same value as `externalRefOf` (integration, P7)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass
- [x] Manual (after your `npm run db:migrate`): `npm run db:events` shows old `issues` rows with
  `<TARGET_REPO>#<n>` and their sender; `ping` rows show no reference

**Dependencies:** None
**Files:** `prisma/schema.prisma`, `prisma/migrations/<ts>_webhook_event_external_ref/migration.sql`,
`src/events/external-ref.ts` (+ `.spec.ts`), `src/events/events.service.ts`, `package.json`,
`test/webhook.integration.spec.ts`; one field in `src/events/event-processor.spec.ts` (the row type grew)
**Scope:** M (small changes)

### Task 2: A redelivery queues a `FAILED` event again

**Description:** `enqueue` returns `{ duplicate, requeued }`. When the delivery ID is already stored, one update
that only matches a `FAILED` row puts it back to `PENDING` (spec "Redelivery", IA13). The log line says `stored`,
`duplicate` or `requeued`.

**Acceptance criteria:**
- [x] `FAILED` row → `PENDING`, `attempts = 0`, `availableAt` = now, `processedAt` empty; payload, `receivedAt`,
  `externalRef` and `lastError` unchanged; the worker then processes it once
- [x] Two redeliveries at the same time → `requeued` is `true` for exactly one; a `PENDING`, `PROCESSING`, `DONE`
  or `IGNORED` row is left untouched
- [x] Every case answers `202`, and there is one row per delivery ID

**Verification:**
- [x] `npm run test:integration` passes
- [x] Manual: Checkpoint 1's requeue row

**Dependencies:** T1 (same file)
**Files:** `src/events/events.service.ts`, `test/webhook.integration.spec.ts`
**Scope:** S

### Task 3: `getAccessLevel` and `isSelf` on the port, the GitHub adapter and the fake

**Description:** `AccessLevel` and the two methods join `IssueProvider` as in overview §4 (`hasWriteAccess` stays
until T4). GitHub adapter: the mapping of AW4, `404` → `none`, no cache; `isSelf` compares with the bot login
resolved at startup. Fake: `setAccessLevel(login, level)` (default `none`), a bot login and `isSelf` (P6).

**Acceptance criteria:**
- [x] Adapter (scripted `fetch`): `admin`, `maintain`, `write` → `approver`; a Triage answer → `participant`;
  `read`, `none`, `404` and an answer without `user.permissions` → `none`; one request per call, never cached
- [x] `isSelf`: the bot login, also in another letter case → `true`; a human login or another bot → `false`; no
  request
- [x] Fake: the level that was set, `none` by default; `isSelf` for its bot login; a ref outside its repo →
  permanent error

**Verification:**
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass

**Dependencies:** None
**Files:** `src/contracts/issue-provider.ts`, `src/github/github-issue.provider.ts` (+ `.spec.ts`),
`test/fakes/in-memory-issue-provider.ts` (+ `.spec.ts`)
**Scope:** M

### Task 4: Smoke script on the new methods; `hasWriteAccess` removed

**Description:** The smoke's access checks call `getAccessLevel` and `isSelf` (spec "Smoke script changes"). Then
`hasWriteAccess` and the fake's `setPermission` are deleted everywhere.

**Acceptance criteria:**
- [x] Smoke lines: `getAccessLevel` → `approver` for the issue author, `none` for `octocat` and for an invented
  login; `isSelf` → `true` for the bot login (`getPushCredentials().authorName`), `false` for the issue author
- [x] `runSmoke` passes against the fakes and prints `FAIL` when a fake gives `octocat` a level (unit)
- [x] `grep -rn "hasWriteAccess\|setPermission" src test` → no match; `src/contracts/issue-provider.ts` matches
  overview §4

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass
- [x] Manual (real GitHub, your `npm run dev` stopped): `npm run github:smoke -- --issue N` → every line `PASS`

**Dependencies:** T3
**Files:** `src/github/smoke/run-smoke.ts` (+ `.spec.ts`); deletions in `src/contracts/issue-provider.ts`,
`src/github/github-issue.provider.ts` (+ `.spec.ts`), `test/fakes/in-memory-issue-provider.ts` (+ `.spec.ts`)
**Scope:** M (7 files, 5 of them only lose code)

### Checkpoint 1 — Storing and access levels
- [x] `typecheck`, `lint`, `test`, `test:integration` green
- [x] After your `npm run db:migrate`: `npm run db:events` shows `external_ref` and the sender for rows stored
  before today
- [x] Signed `issues.opened` for issue `999999` with delivery ID `requeue-1` → `FAILED` at once (the hello's
  `404`); the same request again → the log shows `requeued` and the row fails again with `attempts = 1`; still
  one row
- [x] The smoke's access lines: `approver` for you, `none` for `octocat`, `isSelf` `true` for `<app>[bot]`
- [x] Opening a sandbox issue still gets the hello
- [ ] You review and commit

---

## Phase 2 — Intake wired with its first event

### Task 5: The worker takes a registered processor

**Description:** `EventProcessor` becomes an interface next to `ProcessResult`. The worker gets
`registerProcessor()` and refuses to start without a processor (P1); `EventsModule` exports the worker. The hello
class stays for now and registers itself (P9). The test harness can register a scripted processor instead, and
the worker's integration tests use it (P3).

**Acceptance criteria:**
- [x] No registered processor → the app does not start and the error says why; a second registration is refused
  (unit)
- [x] Every worker rule (oldest first, due time, retries after 5 s and 30 s, permanent error, rate-limit wait,
  `lastError` length, two drains at once, crash reset, shutdown) passes with a scripted processor; no worker test
  mentions the hello
- [x] The hello's unit tests and one signed-webhook test still pass

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** None
**Files:** `src/events/event-processor.ts` (+ `.spec.ts`), `src/events/events.worker.ts` (+ new `.spec.ts`),
`src/events/events.module.ts`, `test/app.ts`, `test/worker.integration.spec.ts`
**Scope:** M (7 files; the two test files carry most of the change)

### Task 6: `WorkflowInput`, the ignore reasons and the first part of classify

**Description:** `src/contracts/workflow-input.ts` as in overview §4. `ignore-reason.ts` with the 16 reasons.
`github-payload.ts` (pure, Zod): checks 1–5 of the spec's "Classify" table and the `issues` · `opened` row. The
first payload builders (P4).

**Acceptance criteria:**
- [x] One test per check 1–5 and per order case: a `ping` from another repo → `ping`; an unsupported event from
  another repo → `other-repo`; an unsupported event without a sender → `unsupported-event`; the bot's own `issues`
  event → `own-event`; a bad `sender.login` or no `action` → `invalid-payload`
- [x] `issues` · `opened` → `ISSUE_OPENED` with `task`, `deliveryId`, `receivedAt` and `sender`, needing a
  Participant; `issue.id` or `issue.number` missing or wrongly typed → `invalid-payload`; another action →
  `unsupported-event`
- [x] The file is pure (no NestJS, no provider; `isSelf` comes in as a function), and for every builder that
  gives an input, `externalRefOf(payload)` equals the input's reference

**Verification:**
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass

**Dependencies:** T1
**Files:** `src/contracts/workflow-input.ts`, `src/intake/ignore-reason.ts`, `src/intake/github-payload.ts`
(+ `.spec.ts`), `test/fixtures/github/payloads.ts`
**Scope:** M

### Task 7: `IntakeService`, the placeholder processor and `IntakeModule`

**Description:** `IntakeService.intake(event)`: classify, then at most one `getAccessLevel`, then the level rule
of the spec's "Authorize" table (the revert and the reply come in T10 and T12). It writes intake's log line (P5).
`IntakeEventProcessor` maps the result to `DONE` or `IGNORED` and registers itself with the worker.
`IntakeModule` provides both; nothing imports it yet.

**Acceptance criteria:**
- [x] `ISSUE_OPENED`: `approver` or `participant` → accepted; `none` → `unauthorized`; exactly one
  `getAccessLevel(task, sender)` call
- [x] An event decided by classify (`ping`, another repo, …) → zero provider calls; a `ProviderError` from the
  lookup comes out unchanged
- [x] One log line per event with delivery, event, action, sender and `accepted ISSUE_OPENED <ref>` or
  `ignored <reason>`; the processor returns `DONE` for accepted and `IGNORED` + reason for ignored

**Verification:**
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass

**Dependencies:** T3, T5, T6
**Files:** `src/intake/intake.service.ts` (+ `.spec.ts`), `src/intake/intake-event.processor.ts` (+ `.spec.ts`),
`src/intake/intake.module.ts`
**Scope:** M

### Task 8: Intake replaces the hello

**Description:** `AppModule` imports `IntakeModule` (P2). The hello class, its text and its tests are deleted;
`event-processor.ts` keeps only the interface and `ProcessResult`. `EventsModule` no longer imports
`GitHubModule`. The harness's payload helper gets a `sender`. `test/intake.integration.spec.ts` starts: signed
requests through the controller.

**Acceptance criteria:**
- [x] Signed `issues.opened` from an Approver → row `DONE`, no comment; from a sender with no access → `IGNORED`
  `unauthorized`; another repo → `other-repo` with zero provider calls; a body without `sender` →
  `invalid-payload` with `attempts = 1`; `ping` → `ping`
- [x] `src/events` imports nothing from `src/github` or `src/intake`;
  `grep -rn "helloCommentBody\|not-handled" src test` → no match
- [x] The app boots with the fakes, and a failing GitHub startup still stops it (spec 3's startup tests pass
  unchanged)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass
- [ ] Manual: Checkpoint 2

**Dependencies:** T7
**Files:** `src/app.module.ts`, `src/events/event-processor.ts` (its `.spec.ts` is deleted),
`src/events/events.module.ts`, `test/app.ts`, `test/intake.integration.spec.ts`
**Scope:** M

### Checkpoint 2 — First real event through intake
- [x] All four commands green
- [x] You open a sandbox issue → row `DONE`; the log shows `accepted ISSUE_OPENED`; NO comment appears
- [x] Signed `issues.opened` with sender `octocat` → row `IGNORED` `unauthorized`; nothing posted
- [x] Signed request for `someone/other-repo` → `IGNORED` `other-repo`. `send issues '{"action":"opened"}'` →
  `IGNORED` `invalid-payload`, `attempts = 1`
- [x] Adding a label gives `unsupported-event` for now (P9)
- [ ] You review and commit

---

## Phase 3 — Label events and the label revert

### Task 9: Label events

**Description:** The `issues` · `labeled` / `unlabeled` rows of the classify table, with a helper in
`src/github/labels.ts` that says which lane a label name stands for. A refused `LANE_ADDED` or `SKIP_ADDED` is
`unauthorized` until T10.

**Acceptance criteria:**
- [x] One test per label row: a lane label → `LANE_ADDED(lane)` / `LANE_REMOVED(lane)`; `grill: skip` →
  `SKIP_ADDED` / `skip-removed`; `status: *` → `status-label`; any other label and an unknown `workflow: *` →
  `other-label`; names in any letter case
- [x] No `label` object → `label-deleted` (the builder is the sandbox's real delivery); the bot's own `status: *`
  label event → `own-event`, not `status-label`
- [x] Integration: an Approver adds `workflow: full-sdd` → `DONE`, the issue's labels unchanged, nothing posted;
  the same for a Participant; a sender with no access removes a lane label → `unauthorized`

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T8
**Files:** `src/github/labels.ts`, `src/intake/github-payload.ts` (+ `.spec.ts`),
`test/fixtures/github/payloads.ts`, `test/intake.integration.spec.ts`; new cells in
`src/intake/intake.service.spec.ts`
**Scope:** M

### Task 10: Label revert

**Description:** `LANE_ADDED` or `SKIP_ADDED` from a sender with no access: remove the label, then post the
revert comment unless its marker is already there (spec "Label revert", AW2, IA11).

**Acceptance criteria:**
- [x] The calls in this order: `getAccessLevel`, `removeLabel` (canonical label name), `findCommentByMarker`,
  `postComment`; result `label-reverted`; the comment is the spec's text with the marker, the label and the login
  in backticks, without `@`
- [x] A second event for the same issue and label → the label is removed again, no second comment; another label
  gets its own comment; after the comment was deleted it is posted again
- [x] A `ProviderError` from any of the three calls comes out unchanged, and running the event again ends with
  exactly one comment (unit, and integration with a failing `postComment`)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass
- [x] Manual: Checkpoint 3

**Dependencies:** T9
**Files:** `src/intake/intake.service.ts` (+ `.spec.ts`), `test/intake.integration.spec.ts`
**Scope:** S

### Checkpoint 3 — Labels on real GitHub
- [x] All four commands green
- [x] You add `workflow: full-sdd` → row `DONE`, log `accepted LANE_ADDED full-sdd`, the label stays. You remove
  it → `accepted LANE_REMOVED full-sdd`. You add `bug` → `IGNORED` `other-label`
- [x] You add `workflow: code-only`; I send the signed `labeled` request with sender `octocat` → the label
  disappears; one bot comment naming `workflow: code-only` and `octocat` (no `@`); row `IGNORED` `label-reverted`
- [x] The bot's own `issues.unlabeled` and `issue_comment.created` rows are `IGNORED` `own-event`; nothing else
  follows
- [x] The same once more → the label disappears again; NO second comment
- [ ] You review and commit

---

## Phase 4 — Comments, `/approve`, pull requests and failures

### Task 11: Comment events and `/approve`

**Description:** `approve-command.ts` (pure): is this text `/approve`? The `issue_comment` rows of the classify
table, with the comment's ID, text and creation time. A Participant's `/approve` is `unauthorized` until T12.

**Acceptance criteria:**
- [ ] Every row of the spec's "What counts as `/approve`" table (unit)
- [ ] `created` on an issue → `COMMENT` (Participant) or `APPROVE` (Approver) with `comment { id, body,
  createdAt }`; on a pull request → `pr-comment`; `edited` / `deleted` → their reasons; no `comment` object →
  `invalid-payload`; the bot's own comment → `own-event`
- [ ] Integration: a Participant's comment → `DONE`; an Approver's `/approve` → `DONE`; `/approve` from a sender
  with no access → `unauthorized` and no comment; the captured log never holds the comment text

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T10 (same files)
**Files:** `src/intake/approve-command.ts` (+ `.spec.ts`), `src/intake/github-payload.ts` (+ `.spec.ts`),
`test/fixtures/github/payloads.ts`, `test/intake.integration.spec.ts`; new cells in
`src/intake/intake.service.spec.ts`
**Scope:** M

### Task 12: Reply to a Participant's `/approve`

**Description:** `APPROVE` from a Participant: post the reply unless the marker of that comment ID is already
there (spec "`/approve` reply", IA4, IA11).

**Acceptance criteria:**
- [ ] `findCommentByMarker` with the marker of that comment ID, then `postComment` with the spec's text, which
  mentions `@<login>`; result `approve-denied`
- [ ] The same event again (a retry) → no second reply; a second `/approve` comment → a second reply; a sender
  with no access → no reply
- [ ] A `ProviderError` comes out unchanged; integration: one reply and row `approve-denied`

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T11
**Files:** `src/intake/intake.service.ts` (+ `.spec.ts`), `test/intake.integration.spec.ts`
**Scope:** S

### Task 13: Pull request events

**Description:** The `pull_request` rows: `opened` and `synchronize` on a pull request the bot opened →
`PR_UPDATED` with `pr` and `headSha`; everything else is ignored. The bot as sender needs no lookup; a human
sender must be an Approver, checked with a ref built from the pull request number (AW6).

**Acceptance criteria:**
- [ ] Bot PR, bot sender → accepted with zero provider calls; bot PR, human sender → accepted only for
  `approver` (`participant` and `none` → `unauthorized`), with one lookup on `<repo>#<PR number>`
- [ ] A pull request opened by a human → `not-bot-pr`; another action (`closed`, …) → `unsupported-event`;
  `head.sha`, `html_url` or `user.login` missing → `invalid-payload`
- [ ] Integration: one accepted `pull_request` row (`DONE`) and one `not-bot-pr`, both with `external_ref`
  `<repo>#<PR number>`; every row of both classify tables now has a test

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T12 (same files)
**Files:** `src/intake/github-payload.ts` (+ `.spec.ts`), `src/intake/intake.service.ts` (+ `.spec.ts`),
`test/fixtures/github/payloads.ts`, `test/intake.integration.spec.ts`
**Scope:** M

### Task 14: Failure paths end to end

**Description:** Integration tests that join the phases: a failing lookup, the retries, the `FAILED` row and its
redelivery, and the real polling loop.

**Acceptance criteria:**
- [ ] A transient error on every lookup → three attempts, then `FAILED` with `lastError`; the row is never `DONE`
  or `IGNORED`; no label removed, no comment
- [ ] A redelivery of that `FAILED` row once the lookup works → processed once, `DONE`, `attempts = 1`; one more
  redelivery changes nothing
- [ ] With the polling worker: a signed `labeled` event from a sender with no access ends `label-reverted` with
  one comment

**Verification:**
- [ ] `npm run test:integration` passes

**Dependencies:** T2, T13
**Files:** `test/intake.integration.spec.ts`
**Scope:** S

### Checkpoint 4 — Comments on real GitHub
- [ ] All four commands green
- [ ] You comment `looks fine` → row `DONE`, log `accepted COMMENT`; the log does NOT contain `looks fine`
- [ ] You comment `/approve` → `accepted APPROVE`. You comment `/approve thanks` → `accepted COMMENT`
- [ ] Signed `/approve` with sender `octocat` → row `IGNORED` `unauthorized`; NO reply on the issue
- [ ] `grep -rn "\.payload" src/intake --include='*.ts'` → only `github-payload.ts` and its test; Octokit is
  imported only under `src/github/`
- [ ] The pull request rows wait for T16 (they need the smoke branch)
- [ ] You review and commit

---

## Phase 5 — Docs and full verification

### Task 15: Setup guide, `AGENTS.md` and `README.md`

**Description:** The guide changes listed in the spec ("Setup & configuration"): steps 6, 8, 9 and 11, and the
new sections "History of an issue", "Reference: who can do what" and "Send a signed test request". `AGENTS.md`:
State and the `db:events` line. `README.md`: the sentence about the hello. The overview only if the build changed
a name it lists.

**Acceptance criteria:**
- [ ] Every command in the guide exists in `package.json`; the guide's table of ignore reasons equals
  `ignore-reason.ts`
- [ ] No living doc (the guide, `README.md`, `AGENTS.md`) promises a hello comment or names `hasWriteAccess`
- [ ] `AGENTS.md` says spec 2 is built and names the next spec (4, `llm-foundation`)

**Verification:**
- [ ] Manual: you read the changed guide sections once

**Dependencies:** T14
**Files:** `docs/guides/setup-github-agent-local.md`, `AGENTS.md`, `README.md`
**Scope:** S

### Task 16: Run the verification matrix and the success criteria

**Description:** Every row of the spec's matrix, as for specs 1 and 3. I run what I can (signed requests, the
smoke, the database, log greps) with my own app instance and its log in the scratchpad. You do the GitHub UI
steps, the redeliveries and the Wi-Fi rows, one step per message. Results are ticked in the spec; the spec's and
the plan's status lines are set.

**Acceptance criteria:**
- [ ] Every matrix row is ticked or reported as failing with its output (no silent skips); the "Organization
  repo only" rows are marked as not run
- [ ] The spec's success criteria are checked, including the three `grep` rows

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` green

**Dependencies:** T15
**Files:** `docs/specs/spec-github-agent-intake-authorization.md` and this plan (checkboxes and status only),
plus fixes if a row fails
**Scope:** S (more if a row fails)

### Checkpoint 5 — Complete
- [ ] The spec's "Success criteria" are all checked
- [ ] You review and commit; spec 4 (`llm-foundation`) is next in the build order

---

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The new seam changes a worker rule (order, retries, crash reset) | High | T5 moves the worker's tests to a scripted processor before intake exists; the same tests run unchanged to the end |
| The bot answers its own events (revert → `unlabeled` → …) | High (a loop on a real issue) | `own-event` is check 5, before every event row; order tests in T6, T9 and T11; Checkpoint 3 watches that nothing follows the bot's own rows |
| A failed lookup is read as "no access" (a label removed or an `/approve` refused by mistake) | High | The service catches nothing (T7 test); the adapter maps only `404` to `none` (T3); T14: the row ends `FAILED` and nothing is posted |
| A derived payload builder doesn't match what GitHub sends | Med | P4: every derived kind is run on real GitHub (Checkpoints 2–4, the matrix); a wrong path shows as `invalid-payload` |
| The Triage mapping is wrong (it can't be tried on a personal repo) | Med | T3 tests it on GitHub's documented answer for a Triage user; the matrix keeps the optional organization rows |
| The back-fill differs from `externalRefOf`, or the migration harms existing rows | Med | P7 test; the migration only adds a column and an index, and its `UPDATE` writes only that column |
| Two redeliveries queue an event twice, or a row that is not `FAILED` is queued again | Med | One conditional update; T2 tests both, with requests sent at the same time |
| Comment text or a payload ends up in the log | Med | The log line is built from fixed fields; tests on the captured log in T7 and T11; `grep` at Checkpoint 4 and in T16 |
| A test reaches the real GitHub API | Low | The harness of spec 3 is unchanged: fakes behind both ports, a client that sends nothing |
| Your GitHub steps block a checkpoint | Low | Listed under "Your part"; each checkpoint needs two or three clicks |

## Open questions

None. P1–P9 were confirmed on 2026-11-11. P5 changed the spec's wording (two log lines per event instead of
one); the spec's "Logging" section was updated the same day. P2 and P3 touch files that the spec's "Project
structure" doesn't list: `src/app.module.ts`, `test/app.ts`, `test/worker.integration.spec.ts`.
