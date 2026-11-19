# Implementation Plan — Spec #6: Grill Me

> **Created:** 2026-11-17 · **Status:** approved 2026-11-17, **built 2026-11-18 and verified 2026-11-19** (Tasks
> 0–21, the spec's matrix passed on the sandbox; fresh-context review 2026-11-17, its 11 findings applied the same
> day: see "Review"; P1–P5 confirmed the same day)
>
> **Why this file exists:** turns the approved spec `docs/specs/spec-github-agent-grill-me.md` (spec 6, `grill-me`,
> approved 2026-11-17) into ordered, verifiable tasks (skill `agent-skills:planning-and-task-breakdown`). The spec
> stays normative: this plan adds order, slicing and build-time decisions only. The task checklist lives here (repo
> placement rules override the skill's `tasks/todo.md`). It is the one plan for everything the spec changes,
> including the code that specs 1–5 built (`src/events`, `src/intake`, `src/github`, `src/llm`, `src/workflow`, the
> fakes) and the sandbox's skill.
>
> **Also read:** overview `docs/specs/spec-github-agent-architecture-overview.md` §1 row 6, §3 rows 9–16 and 27–31,
> §4 (`IssueProvider`, `TaskComment`, the Grill row of the step-skill contract), §5 `GRILL_*`, §6 the four Grill
> tables; spec 5 `docs/specs/spec-github-agent-router-session-lease.md` ("Step-handler registry", "Cancel and
> restart", "`/retry`"); spec 4 `docs/specs/spec-github-agent-llm-foundation.md` (`LlmService.call()`, "Notes").

## Overview

Build `GrillModule` (`src/grill`), the `grill` handler of spec 5's step-handler registry. **Grill Me** is the first
step of a `full-sdd` or `spec-code` run: the bot judges whether the issue says enough to write a Spec; if not, it
asks a few numbered questions with its guesses in one comment, reads the answers people write, and hands over to
the Spec step (spec 7) once it is sure enough, or stops at the round limit. Words used below: an **evaluation** is
one model call that judges the issue and the answers so far (spec 4's re-asks included); a **round** is one question
comment; an **answer** is a comment from someone with access, read once; the **session** is the run's Grill record.

Built in 21 tasks across 7 phases, after a Task 0 that writes this plan's confirmed decisions into the spec and the
overview:

1. **Changes to what specs 1–5 built:** the three settings, the 👀 port method, answer comments from stored events,
   the skill check line, `decide()`'s Grill rows and the router's seams.
2. **Grill Me's core:** the four tables and their store, the model side (output, frame, prompt), the texts.
3. **Run start on the sandbox:** the answer reader, round 1, already clear, skipped; the real sandbox skill.
4. **Answers:** rounds, 👀, bursts, `/retry` re-runs, the round limit, invalid answers.
5. **`/approve` and `grill: skip` while the bot is asking.**
6. **Cancel and restart:** the answers block, `transcript()` for spec 7.
7. **Docs and the verification matrix.**

Spec 7 (`spec-plan-approvals`, approved later, not built) owns the Spec step, so every Grill Me that ends (clear,
skipped or stopped) hands over to `spec`, which stops the run with `step-not-built`: expected (spec "Out"). Real
GitHub is reached at Checkpoint 1 (the smoke script), Checkpoints 3–6 and T21. You review and commit at each
checkpoint (I never commit). Every task ends with `npm run typecheck && npm run lint && npm test && npm run
test:integration` green.

## Build-time decisions (not in the spec; to confirm with this plan)

Each told as what happens on GitHub. P1–P5 change something you can see: I ask about them one at a time. P6–P9
change nothing on GitHub.

| # | On GitHub | My guess (and the alternative) | Spec lines it changes |
|---|---|---|---|
| P1 | While the bot is asking, someone adds `grill: skip`: "Grill Me stopped", then the Spec step. That step fails and the run stops. Someone removes `grill: skip`, then comments `/retry`. As written, the re-run label event finds the label gone and is ignored, and a Grill session that has ended answers nothing: the issue stays in `status: grilling` and no comment gets a reply until a restart. | Once Grill Me has ended (clear, skipped or stopped), every later Grill call of that run first posts Grill Me's closing comment if it is missing (found by its marker: "no questions needed" at 0 rounds, "skipped", or "stopped" rebuilt with the stored login), then goes on to the Spec without a model call (it returns `CLEAR`; a `LIMIT` session keeps returning `LIMIT`). A `grill: skip` event that finds the label gone while the bot is asking is read like a comment: nothing new, no reply, the event `DONE` instead of `IGNORED` `no-transition`. So `/retry` reaches the Spec. *Alternative:* as written; only a restart gets out. | "Exactly once and recovery" step 2; "`/approve`, `grill: skip` and `/retry` while the bot is asking"; "Contracts" (`decide()`); the matrix row "add `grill: skip` and remove it within a second"; overview row 16 |
| P2 | An 80,000-character description, and the bot is sure at once: "Grill Me: no questions needed" with "Model: …" and "The bot read only the first 65,536 characters of the issue description" under the rule. GitHub fails on that post; the retry rebuilds the comment from the stored model and level, so the cut line is missing. The round-limit body has the same gap. | One more column, `grill_evaluations.notes` (text[]: the lines under the rule), so the clear comment and the limit body are always built from the row, identical on a retry. *Alternative:* accept the missing line in that crash case. | "Owned tables" (`GrillEvaluation`); overview §6 |
| P3 | With `GRILL_MAX_ROUNDS=1` (the matrix's limit rows) the limit comment says "Grill Me used all 1 rounds"; a round with one question says "A few questions …" and "Answer with `Q1: …`, `Q2: …`". | Singular forms only where the number is 1: "Grill Me used its only round and is 80% sure …", "One question before the bot writes the Spec:", "One more question before the bot writes the Spec.", "Answer with `Q4: …`. `Q4: yes` accepts the guess." Every other word as approved. *Alternative:* the approved texts as they are. | "Comments and reactions" (one note) |
| P4 | The matrix needs five sandbox issues: vague, complete, skipped, the round limit, Spanish. | New issues "Spec 6 check A" to "E", closed when the matrix is done. The README's six starter issues stay unopened until spec 7 can write their Spec, so their first run goes end to end. *Alternative:* open starter issues now (their runs would wait at `spec` until spec 7, then `/retry`). | — |
| P5 | A colleague sets up their own sandbox from the setup guide and needs the Grill skill. | The skill and its notice live only in the reference sandbox; section 3 of the guide links to the two files. The sandbox README's two stale lines (`grill: skip` "read only when a run starts"; steps "use the bot's built-in prompt", stale since spec 4) are fixed in the same sandbox commit (T14). *Alternative:* a copy in this repo too (two copies that can drift). | "Setup & configuration" (one line) |
| P6 | No difference. The cancel hook needs how the run ended (GM17's header names the new run) and when (GM16 reads only answers received before the ending event). | The router passes both: `cancelled`, or `replaced` with the new run's number and lane, and the ending event's `received_at`, also when a later event posts the pending run-ended comment (`RunService.endedBy` returns the time with the login). *Alternative:* the hook reads the run row and the event itself. | "Contracts" (`src/workflow` line) |
| P7 | No difference. | `GrillModule` also imports `GitHubModule` (the issue port) and `EventsModule` (`commentEventsSince`): none of the three modules the spec lists re-exports them. | "Project structure" |
| P8 | No difference. | Spec 5's router suites keep testing the router alone: `startApp` overrides the `GrillHandler` provider that `GrillModule` registers. By default with a handler that throws `StepNotBuiltError('grill')` (today's behavior: the closed-issue and lane-conflict suites, and the "without handlers" parts of the others, start `full-sdd` and `spec-code` runs and expect the `grill` stop); `startApp({ grill: handler })` for a scripted one (five suites register theirs after `startApp` today, which would make their `beforeAll` throw "already registered"); `startApp({ grill: 'real' })` for the Grill suites. *Alternative:* the real handler by default, and every older suite scripts the model or passes a handler. | — |
| P9 | No difference. | The migration is created against the test database; your dev database changes only when you run `npm run db:migrate` (four new tables, nothing existing changes). As in specs 1–5. | — |

## Dependency graph

```text
T0 spec + overview lines (on approval)
T1 GRILL_* settings ─────────────────────┐
T2 acknowledgeComment (spec 3) ──────────┤
T3 answer comments (specs 1, 2) ─────────┤
T4 skill check line (spec 4) ────────────┤
T5 decide() Grill rows, limit stop text ─┤
T6 router seams (spec 5) ────────────────┴··································· Checkpoint 1
T7 tables + GrillStore (T6) ── T8 output, frame, prompt ── T9 texts ·········· Checkpoint 2
T10 answer reader (T3, T7)
  └─ T11 round 1 at run start (T1, T5, T8, T9, T10)
       └─ T12 already clear + look again
            └─ T13 skipped at run start
T14 sandbox skill (T8; you push it) ·········································· Checkpoint 3
T15 answers: round, 👀, bursts, /retry re-run (T2, T13)
  └─ T16 round limit + invalid answers ······································· Checkpoint 4
T17 /approve and grill: skip while asking (T16) ······························ Checkpoint 5
T18 answers block (pure) ── T19 cancel hook + transcript (T17) ··············· Checkpoint 6
T20 docs ── T21 verification matrix ·········································· Checkpoint 7
```

One session builds them in number order. T1–T5 are independent of each other, and so are T8 and T9; T14 can be
written any time after T8. From T11 on every task changes `grill.handler.ts`, so nothing else runs in parallel.

**Your part (the build stops for these):**

1. **After T7:** run `npm run db:migrate` (four new tables; nothing existing changes).
2. **Before Checkpoint 3:** read T14's three changes in your sandbox clone (`/Users/891944/Projects/sdd-agent-sandbox`),
   then commit and push them to `main`.
3. **Checkpoints 3–6 and T21:** stop `npm run dev` (the tunnel stays). I run my instance on port 3000 with the dev
   database and its log in the scratchpad. The sandbox steps (issues, labels, comments, edits, close and reopen) I
   do with `gh` as you if you say so at the checkpoint; otherwise you do them, one per message. Yours in any case:
   the signed `octocat` comment (Checkpoint 4, the guide's `send` helper). Keep the Mac awake (lid open) while the
   model is called.
4. **Every checkpoint:** you review and commit.

---

## Phase 1 — Changes to what specs 1–5 built

### Task 0: This plan's decisions in the spec and the overview (on approval, before any code)

**Description:** Boundaries: the overview and the spec change first when a row, a contract or a table changes.
The lines in the column "Spec lines it changes" for every confirmed decision, each with the date and the plan's
number (as spec 5's plan did), plus the review's fixes that need no choice.

**Acceptance criteria:**
- [x] Every confirmed decision with a "Spec lines" entry is in the spec, and in the overview where named
- [x] Every matrix row a decision changes can be checked as written
- [x] Review fix: the spec's "Agreed for later specs" says a `SKIPPED` session holds the answers its skip read
  (usually none), not "no answers"

**Verification:**
- [ ] Manual: you read the diff of both documents

**Dependencies:** your approval of this plan
**Files:** `docs/specs/spec-github-agent-grill-me.md`, `docs/specs/spec-github-agent-architecture-overview.md`
**Scope:** S

### Task 1: The three Grill settings

**Description:** `GRILL_MAX_ROUNDS` (integer 1–10, default 5), `GRILL_MAX_QUESTIONS_PER_ROUND` (1–10, default 3) and
`GRILL_CONFIDENCE_THRESHOLD` (1–100, default 95) join `envSchema` (spec "Configuration"). `.env.example` gets them
with their defaults and one comment line each (GM2); `test/test-env.ts` sets the defaults.

**Acceptance criteria:**
- [x] `GRILL_MAX_QUESTIONS_PER_ROUND=11`, `GRILL_MAX_ROUNDS=0`, `GRILL_CONFIDENCE_THRESHOLD=101`, `abc` and `2.5`
  → the startup error names the variable; `10` → accepted; unset → 5, 3, 95 (unit)
- [x] `.env.example` lists the three with their defaults and one comment line each

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass

**Dependencies:** None
**Files:** `src/config/env.schema.ts` (+ `.spec.ts`), `.env.example`, `test/test-env.ts`
**Scope:** XS

### Task 2: `IssueProvider.acknowledgeComment` (spec 3's adapter, fake, wrapper and smoke script)

**Description:** The method as overview §4 has it (GM6, GMW9). GitHub adapter: `POST
/repos/{owner}/{repo}/issues/comments/{comment_id}/reactions` with `content: eyes`; `200` and `201` succeed, `404`
is ignored (`requestOrNull`), every other failure is a `ProviderError` as for the other methods (G5). The in-memory
fake records the call in `calls` and answers `acknowledged(task)` (the comment ids, in order); an unknown id is not an
error. The scanning wrapper passes it through. `npm run github:smoke` calls it once on the comment it just posted.

**Acceptance criteria:**
- [x] `src/contracts/issue-provider.ts` matches overview §4's `IssueProvider` line by line
- [x] Adapter: `201` and `200` resolve, `404` resolves, `500` → transient, `403` → permanent `ProviderError`; the
  request names the comment id and `eyes` (unit, fake fetch)
- [x] Fake and wrapper: recorded, passed through, twice is fine (unit)
- [x] Smoke: one `PASS acknowledgeComment` line, run against the fake (unit)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass
- [x] At Checkpoint 1: the real smoke run puts a 👀 by the bot on its comment

**Dependencies:** None
**Files:** `src/contracts/issue-provider.ts`, `src/github/github-issue.provider.ts` (+ `.spec.ts`),
`src/secret-scan/scanning-issue.provider.ts` (+ `.spec.ts`), `test/fakes/in-memory-issue-provider.ts` (+ `.spec.ts`),
`src/github/smoke/run-smoke.ts` (+ `.spec.ts`)
**Scope:** M (small edits in five files)

### Task 3: Answer comments from stored events (specs 1 and 2)

**Description:** Spec "Changes to earlier specs' behavior". `TaskComment.url` (optional) from `comment.html_url`;
spec 2's signed test requests have none. `EventsService.commentEventsSince(externalRef, since)`: the issue's
`issue_comment` events received at or after `since`, any status, oldest first (the overview: the first spec that
needs an issue's events adds the query). `IntakeService.answerComments(task, events)`: classifies each stored event
with spec 2's rules (`classifyGitHubEvent`), keeps the plain comments (`COMMENT`) on this issue, asks
`getAccessLevel` once per distinct author and keeps Participants and Approvers; no reply, no label revert, no line per
event with text.

**Acceptance criteria:**
- [x] A comment payload with `html_url` → `comment.url` set; without → undefined, still `COMMENT`. Spec 2's classify
  test for a comment expects `url` now (its fixture sends `html_url`); the other classify tests pass untouched (unit)
- [x] `commentEventsSince`: other issues, other event names and events before `since` left out; no status filter
  (`PENDING`, `PROCESSING`, `IGNORED`, `FAILED` and `DONE` all returned); oldest first (integration, stored rows)
- [x] `answerComments` drops `/approve`, `/retry`, the bot's own, edits, deletions, PR comments, another issue's
  comment and an author with no access; one lookup per author; the fake's `calls` show no `postComment` and no
  `removeLabel` (unit)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** None
**Files:** `src/contracts/workflow-input.ts`, `src/intake/github-payload.ts` (+ `.spec.ts`),
`src/events/events.service.ts`, `src/intake/intake.service.ts` (+ `.spec.ts`), `test/answer-comments.integration.spec.ts`
**Scope:** M

### Task 4: The skill check line (spec 4, GM13)

**Description:** When `loadSkill` has read a skill, it runs `findInjectionKinds` over each file; on a match, one
warning line: step, file path, kinds, never the text. The skill still loads (overview §4 "Trust").

**Acceptance criteria:**
- [x] A file with "ignore all previous instructions" → one warning line naming the step, the path and
  `override-instructions`, without the text; the skill is returned whole (unit, `Logger` spy)
- [x] No match → no warning line

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass

**Dependencies:** None
**Files:** `src/llm/skill-loader.ts` (+ `.spec.ts`)
**Scope:** XS

### Task 5: `decide()`'s Grill rows and the round-limit stop comment (spec 5)

**Description:** Spec "Contracts", `src/workflow` line. In `grilling`: `APPROVE` → `steps([grill approve])`;
`SKIP_ADDED` with `grillSkipOnIssue` → the skip path `steps([grill skip, spec generate], 'spec-review')`, without it →
P1's `grill round` (as written: ignored); `COMMENT` with `grillSkipOnIssue` → the skip path, without it → `grill
round` as before. `RUN_START`: the skip path when `run.grillSkip` or `grillSkipOnIssue` (GM15). The stop comment of a
`grill-limit` stop is the step's body alone: no "To start again from scratch" line (GM9); other work-result stops
keep it.

**Acceptance criteria:**
- [x] One named test per new case: `grilling` + `APPROVE`; + `SKIP_ADDED` with and without the label; + `COMMENT`
  with the label; `RUN_START` with the stored skip, with the label only, with neither; `code-only` unchanged (unit)
- [x] Every other row's test passes unchanged (rows 17–20 and 27 still ignore `SKIP_ADDED`)
- [x] The `grill-limit` stop comment = marker + body; a `coder-red` stop still ends with the restart line (unit);
  spec 5's scripted-`LIMIT` test expects the marker and the body only (integration)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** None
**Files:** `src/workflow/decide.ts` (+ `.spec.ts`), `src/workflow/workflow-comments.ts` (+ `.spec.ts`),
`src/workflow/needs-human.service.ts`, `test/needs-human.integration.spec.ts`
**Scope:** S

### Task 6: The router's seams (spec 5)

**Description:** `StepRun.startEventReceivedAt` (the run's `start_event_received_at`). `SessionLeaseService`
exported from `WorkflowModule` (`assertHeld`, spec "Changes to earlier specs"). P6: the cancel hook's context gains
the run's end (`cancelled`, or `replaced` with the new run's number and lane) and the ending event's `received_at`;
`completeEndComment` reads both through `RunService.endedBy`. The scripted step handler records them.

**Acceptance criteria:**
- [x] A scripted handler sees `startEventReceivedAt` equal to the run's row (integration)
- [x] A cancel → the hook gets `cancelled` and the label event's `received_at`; a restart → `replaced` with run N+1;
  the same when a later event posts the pending run-ended comment (integration, `failNextOn('postComment')`)
- [x] A module outside `src/workflow` can inject `SessionLeaseService` (unit: `WorkflowModule` exports it)
- [x] Spec 5's suites pass unchanged apart from the hook's new argument

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** None
**Files:** `src/workflow/step-handler.registry.ts`, `src/workflow/router.service.ts`, `src/workflow/run.service.ts`,
`src/workflow/workflow.module.ts`, `test/fakes/scripted-step-handler.ts`, `test/cancel-restart.integration.spec.ts`
**Scope:** M (small edits)

### Checkpoint 1 — The seams, and the 👀 on the sandbox

**On GitHub you'll see:** the comment of `npm run github:smoke -- --issue <n>` (on an old closed sandbox issue) gets
a 👀 reaction by the bot. Nothing else changes: Grill Me isn't registered yet, so a run still stops at `grill` with
`step-not-built`.
**Matrix rows:** "Startup", both.
- [x] `typecheck`, `lint`, `test`, `test:integration` green
- [x] `GRILL_MAX_QUESTIONS_PER_ROUND=11 node dist/main.js` refuses to start, naming it; `10` starts;
  `GRILL_MAX_ROUNDS=0` refuses (my instance, your `npm run dev` untouched)
- [x] `npm run github:smoke -- --issue <n>` → every line `PASS`, the 👀 on its comment (`gh api …/reactions`)
  (2026-11-18: issue #11, comment 6964612534, `sdd-agent-app[bot] eyes`)
- [ ] You review and commit

---

## Phase 2 — Grill Me's core

### Task 7: The four Grill tables and `GrillStore`

**Description:** `GrillSession`, `GrillEvaluation` (with P2's `notes`), `GrillRound` and `GrillAnswer` in
`prisma/schema.prisma` exactly as the spec's "Owned tables" (snake_case, statuses as text, the four indexes; the back
relations on `Task` and `Run` add no column). Migration `<ts>_grill` created against the test database (P9).
`resetDatabase` empties the four tables. `GrillStore` (`src/grill/grill.store.ts`), the only writer: every
transaction starts with `assertHeld`. Its first writes here: create a session; record a `SUPERSEDED` evaluation (its
own small transaction, no answers); record an acting evaluation with its answers and the session (`rounds`,
`lastQuestion`, the confidences), and for `ASKED` its round `PENDING_POST` with the full body (Tx1); mark a round
`POSTED` with the comment id, url and time (Tx2). Reads: the session of a run, its rounds, answers and latest acting
evaluation, a pending round, the ids of the comments it has read. Later tasks add the rest.

**Acceptance criteria:**
- [x] The migration applies to an empty test database; `prisma migrate diff` from the migrations to the schema is
  empty; `tasks` and `runs` keep their columns (2026-11-18: `20261118111741_grill`, applied with the six before it
  to a new empty database in the test container: "No difference detected")
- [x] A second session for one run, a round number twice in a session, two rounds for one evaluation and one comment
  read twice in a session all fail (integration)
- [x] A write with another lease owner throws `LeaseLostError` and writes nothing, in all four tables (integration)
- [x] Tx1 writes the evaluation, its answers, the session and the round together; a failure inside rolls all back
  (integration)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T6 (`assertHeld` exported)
**Files:** `prisma/schema.prisma`, `prisma/migrations/<ts>_grill/migration.sql`, `test/db.ts`,
`src/grill/grill.store.ts`, `test/grill-store.integration.spec.ts`
**Scope:** M

### Task 8: The model side: output schema, frame and prompt

**Description:** Spec "Model, skill and prompt", all pure. `grill-output.ts`: the Zod schema built per call with the
threshold and the last question number, and GMW4's rules as `superRefine` issues whose messages name the rule ("open
lists Q7, but only Q1–Q5 were asked"; "below 95 you must ask at least one new question or list the open questions
you are waiting for"); at or above the threshold nothing else is checked (CLEAR wins). `grill-frame.ts`: the frame
text with `{K}`, `{threshold}`, `{rounds}`, `{max}` filled. `grill-prompt.ts`: one user turn from the issue, the
session's rounds and answers and the unread comments: title and description as untrusted blocks (keys `title`,
`description`), "Comments before the first questions" only when there are any, each round as "Round r (Qa–Qb)" with
its questions, guesses and answers, then "New comments since the last call" (or "None. This is the first
evaluation." / "None."); every comment untrusted with key `comment-<id>` and label "the comment by <login>".

**Acceptance criteria:**
- [x] Every GMW4 rule has a test: an open number above the last asked, zero or negative; below the threshold with no
  question and nothing open; a question or guess over 600 characters; a gap over 200; 11 gaps; 21 questions; at the
  threshold with questions and open numbers → valid (unit)
- [x] The schema goes through `withStructuredOutput` as spec 4 sends it (the scripted model records it), and Zod
  judges the raw answer: a mismatch is re-asked with the rule's message (unit)
- [x] The frame equals the spec's text for K 3, threshold 95, rounds 2, max 5 (unit)
- [x] The prompt: grouping by round, answers before round 1 first, keys and labels, the three "new comments"
  wordings; no comment, title or description text in a plain block (unit)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass

**Dependencies:** None
**Files:** `src/grill/grill-output.ts` (+ `.spec.ts`), `src/grill/grill-frame.ts`, `src/grill/grill-prompt.ts`
(+ `.spec.ts`)
**Scope:** M

### Task 9: The texts the bot posts

**Description:** `grill-comments.ts`, pure: every marker and text of spec "Comments and reactions" except the answers
block (T18). The question comment (round 1 versus later, "Still open from before" only when something earlier is
open, the footer, the model line through `withNotes`); "no questions needed"; skipped at run start; stopped, with the
sender's login or "(`grill: skip` is on)"; the `/approve` reply with the open numbers; the round-limit body (with and
without gaps, the run's lane label in step 1); P3's singular forms. GMW3's cleaning of model text: every `@name` in
backticks (also at a line start or after punctuation; an e-mail address untouched) and every hidden `sdd-agent`
marker removed.

**Acceptance criteria:**
- [x] Each text equals the spec's example for the same input, marker first (unit; 2026-11-18: a paragraph the spec
  wraps to fit the page is one line in the comment, as in spec 5's texts, since GitHub shows a line break where a
  comment has one)
- [x] No text has an `@` outside backticks, also with model text full of mentions (unit over every text; 2026-11-18:
  mentions written together, `@a@b`, are wrapped as one, and when model text with a mention also has a backtick
  outside any code span or a backslash, those characters are dropped, so the added backticks always hold)
- [x] A question or guess holding `<!-- sdd-agent:needs-human:x:1 -->` posts without it (unit)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass

**Dependencies:** None
**Files:** `src/grill/grill-comments.ts` (+ `.spec.ts`)
**Scope:** M

### Checkpoint 2 — Grill Me's core

**On GitHub you'll see:** nothing new (the core isn't wired to the router yet).
**Matrix rows:** none.
- [x] `typecheck`, `lint`, `test`, `test:integration` green (2026-11-18: 1,038 unit, 204 integration)
- [x] You ran `npm run db:migrate`; `\d grill_sessions`, `\d grill_evaluations`, `\d grill_rounds`, `\d
  grill_answers` show the spec's columns (and `notes`, P2)
- [ ] You review and commit

---

## Phase 3 — Run start on the sandbox

### Task 10: The answer reader

**Description:** `answer-reader.service.ts`, spec "Which comments are answers": the run's comment events since its
`startEventReceivedAt` (T3's query), less the comments this session has read (`grill_answers`), through
`answerComments` (T3), in creation order then comment id. Optional upper bound: received before a given time (the
cancel hook, T19). The event's own processing state never matters (`PROCESSING` included: the triggering comment's
own event).

**Acceptance criteria:**
- [x] With stored events: commands, the bot's own, edits, another issue, before the run, no access and already read
  are left out; a `PENDING`, a `PROCESSING`, an `IGNORED` and a `FAILED` comment event are read; the order holds for
  equal times (integration)
- [x] One `getAccessLevel` per distinct author per call (integration, the fake's `calls`)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T3, T7
**Files:** `src/grill/answer-reader.service.ts`, `test/answer-reader.integration.spec.ts`
**Scope:** S

### Task 11: Round 1 at run start

**Description:** The first vertical slice. `grill-evaluation.service.ts`: one evaluation (spec "One evaluation")
read → prepare (`getTaskDetails`, `StepConfigService.prepare('grill', …)`) → `LlmService.call` (context: the issue,
`grill`, the lane, the run id) → act. Here the act is `ASKED`: the first K questions numbered from
`lastQuestion + 1`, Tx1 (evaluation `ASKED` with `logId`, model, level, `afterRound`, `questionsProposed`, P2's notes;
the answers read; the round `PENDING_POST` with its body and marker `grill-round:<roundId>`, its id made before the
insert), then "find the marker, else post", then Tx2. `grill.handler.ts`: `start` with spec "Exactly once and
recovery" step 1 (a `PENDING_POST` round posted once) and step 2 for `start` (no session → create and evaluate; a
session with no round → evaluate; a round posted → act as `round`, which until T15 finds nothing to read and returns
`ASKED`). `grill.module.ts` registers `GrillHandler` in `onModuleInit`; `AppModule` imports it; P7, P8.

**Acceptance criteria:**
- [x] `workflow: full-sdd` on a vague issue, a scripted answer (confidence 60, two questions) → session `ASKING`,
  evaluation `ASKED` whose `log_id` is the call's `execution_logs` row (`grill`, this run), round 1 `POSTED` with Q1
  and Q2, one comment with the marker, `status: grilling`, the event `DONE` (integration)
- [x] Five questions with K = 3 → three posted, `questions_proposed` 5 (integration)
- [x] `postComment` failing once after Tx1 → retried → one comment, one model call; Tx2 failing once → found by its
  marker, one comment; Tx1 failing once → one more model call, one comment (integration)
- [x] The run's start event processed again with round 1 posted → no model call, `ASKED`, no second comment
  (integration)
- [x] P8: every older suite passes unchanged, except the five that registered a scripted `grill` and now pass it
  to `startApp` (one line each) and T5's scripted-`LIMIT` test (2026-11-18: four of them also drop the registry
  import they no longer use; `startApp` hands Nest a plain object around the handler, since Nest awaits a provider
  value that has a `then` method, and the scripted handler's `then` is its script)
- [x] Log `#12 run 1 grill: evaluation → ASKED (round 1, 2 of 3 questions, confidence 60)`; a recovery logs
  `round 1 posted (recovered)`

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T1, T5, T8, T9, T10
**Files:** `src/grill/grill-evaluation.service.ts`, `src/grill/grill.handler.ts`, `src/grill/grill.module.ts`,
`src/app.module.ts`, `test/app.ts` + the five spec 5 suites (one line each, P8), `test/grill-helpers.ts`,
`test/grill-start.integration.spec.ts`
**Scope:** M (the spec 5 suites are one-line changes)

### Task 12: Already clear, and the look again (GM4)

**Description:** The rest of "One evaluation". Step 4, look again: after the call, the reader runs again; comments
not in the evaluated list → a `SUPERSEDED` evaluation (its own transaction, no answers), the list grows, and the
evaluation goes back to prepare. The act for `CLEAR`: one transaction (evaluation `CLEAR`, its answers, the session
`CLEAR` with its confidences and `endedAt`), then with no round posted the "no questions needed" comment (marker
`grill-clear:<sessionId>`, built from the row, P2), and `CLEAR` back to the router (→ `spec`). Recovery step 2: a
session already `CLEAR` posts its missing clear comment and returns `CLEAR` without a model call. The scripted chat
model gets a hook that runs during a call (to store a comment "while the model thinks").

**Acceptance criteria:**
- [x] A complete issue (confidence 97, with two questions) → session `CLEAR`, rounds 0, first and last confidence
  97, one "no questions needed" comment, the questions dropped, then the `spec` stop `step-not-built` (integration)
- [x] The clear comment failing once → retried → posted once, no second model call; `/retry` after the `spec` stop
  → no model call, a second `spec` stop (integration)
- [x] A comment stored during the first call → `SUPERSEDED`, a second call whose prompt has it under "New comments",
  one question comment; that comment's own event then `DONE` with no call; two comments during two calls → two
  `SUPERSEDED`, three calls (integration)
- [x] Logs `… → CLEAR (confidence 97)` and `… → SUPERSEDED (1 newer comment)`

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T11
**Files:** `src/grill/grill-evaluation.service.ts`, `src/grill/grill.handler.ts`, `src/grill/grill.store.ts`,
`test/fakes/scripted-chat-model.factory.ts`, `test/grill-start.integration.spec.ts`
**Scope:** M

### Task 13: Skipped at run start

**Description:** The `skip` op when no question was posted: the unread answers read into the session without a model
call, the session `SKIPPED` (0 rounds, confidences null), the comment "Grill Me skipped (`grill: skip` is on): …"
(marker `grill-skipped:<sessionId>`, no login, GMW5), then the router's `spec` call. Also at a retried run start
(GM15: the label added while the run was stopped before its first question).

**Acceptance criteria:**
- [x] `grill: skip` and `workflow: full-sdd` in one go → session `SKIPPED`, one skipped comment, the `spec` stop; no
  `execution_logs` row for `grill` (integration)
- [x] The first evaluation fails (permanent) → stop at `grill` → `grill: skip` added → `/retry` → the skipped
  comment, no model call, the `spec` stop (integration)
- [x] Posting the skipped comment failing once → posted once (integration)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T12
**Files:** `src/grill/grill.handler.ts`, `src/grill/grill.store.ts`, `test/grill-start.integration.spec.ts`
**Scope:** S

### Task 14: The sandbox's `grill` skill and its notice (files you commit)

**Description:** Spec "Sandbox skill", GMW7, GMW8. I write three changes into your sandbox clone
`/Users/891944/Projects/sdd-agent-sandbox` (on `main`, up to date with `origin`), nothing committed:
`.github-agent/skills/grill/SKILL.md` replaces the placeholder with `interview-me` (addyosmani/agent-skills 0.6.15,
MIT) adapted as the spec lists (kept, changed, dropped); `.github-agent/skills/THIRD-PARTY-NOTICES.md` holds the MIT
text, outside the skill's folder so the model never gets it; the README's two stale lines (P5). You read them, then
commit and push to `main` before Checkpoint 3.

**Acceptance criteria:**
- [x] The skill's first line is the spec's attribution line, word for word; the notice has the full MIT text with
  "Copyright (c) 2025 Addy Osmani", names the source and version, and says what was changed
- [x] Nothing in it contradicts the frame: several independent questions per comment (GM3's test), each with a
  guess and its reasoning; no numbering, no `@`, no "one question at a time", no explicit "yes" to wait for, no
  terminal-turn rule, no file to save; questions in the issue's language; the stop is the threshold the frame gives
- [x] Spec 4's injection patterns find nothing in it (GM13); one text file, far below 204,800 bytes (2026-11-18:
  4,785 bytes)

**Verification:**
- [x] Manual: you read the three changes, then commit and push (e.g. `chore: grill skill adapted from interview-me
  (sdd-agent spec 6)`) (2026-11-18: `9b6752a` on the sandbox's `main`)
- [x] At Checkpoint 3 the app log shows `skill grill @<commit>: 1 file, …` and no warning line for it (2026-11-18:
  `skill grill @9b6752a: 1 file, 4,779 chars, skipped 0` on every call)

**Dependencies:** T8 (the frame it fits)
**Files:** in the sandbox only: `.github-agent/skills/grill/SKILL.md`, `.github-agent/skills/THIRD-PARTY-NOTICES.md`,
`README.md`
**Scope:** S

### Checkpoint 3 — Run start on the sandbox

My instance on port 3000 (dev database, log in the scratchpad); issues "Spec 6 check A" to "E" (P4).
**On GitHub you'll see:** `workflow: full-sdd` on `#A` ("Let people split bills") → `status: grilling` and one
"**Grill Me, round 1 of 5** · confidence N%" comment with one to three questions from Q1, each with a *Guess*, the
footer and the model line, no `@`. `#B` (who, what, done, out of scope) + `workflow: spec-code` → one "Grill Me: no
questions needed" comment, then the `step-not-built` stop at `spec`. `#C`: `grill: skip` and `workflow: full-sdd` in
one edit → "Grill Me skipped" and the `spec` stop. `#E` in Spanish → questions and guesses in Spanish, the bot's own
lines in English. If the model asks questions on `#B` anyway, I run `#B` again on my instance with a lower
`GRILL_CONFIDENCE_THRESHOLD`: the row checks the clear path, not the model's judgment.
**Matrix rows:** "Questions and answers": the first row and the Spanish row (`#E`); "Clear and skipped": both.
- [x] `typecheck`, `lint`, `test`, `test:integration` green
- [x] The sandbox's `main` has T14's files (you pushed them)
- [x] The rows above, ticked in the spec; `grill_evaluations` and `execution_logs` checked with the matrix's queries
  (2026-11-18: `#A` = #22, `#B` = #23, `#C` = #24, `#E` = #25; Google answered HTTP 503 on all three attempts on
  #22 and #25, so both stopped at `grill` first and continued after `/retry`)
- [ ] You review and commit

---

## Phase 4 — Answers

### Task 15: Answers: rounds, 👀, bursts and the `/retry` re-run

**Description:** The `round` op (spec "Exactly once and recovery" step 2): read the unread answers and evaluate them
if there are any; the comment that triggered it already read → nothing, no model call, the event `DONE`. The act for
the remaining results: `ASKED` with rounds already posted (numbered on, "Still open" from the model's `open`),
`CLEAR` with rounds posted (nothing posted: the Spec is the reply), `WAITING` (one transaction; then 👀 through
`acknowledgeComment` on each comment it read; then `acknowledged`). Recovery step 1: answers read by a `WAITING`
evaluation without their 👀 get it. Step 3's return values (`ASKED` when step 1 posted a round). GM12 needs no code
of its own: the reader reads the comments written while the run was stopped.

**Acceptance criteria:**
- [x] Round 1 posted; one comment answering both → one evaluation, round 2 from Q3 with "Still open from before"
  when the model lists an earlier number; or `CLEAR` → nothing posted, the `spec` stop; no 👀 (integration)
- [x] A partial answer → `WAITING`: 👀 on that comment, `acknowledged` true, no comment, `status: grilling`,
  `rounds` unchanged; then the rest → one reply (integration)
- [x] `acknowledgeComment` failing once → retried → the 👀 added, no second model call (integration)
- [x] Two answer events stored before the worker runs → one evaluation reading both; the second event `DONE`, no
  call, log `nothing new (comment N already read)` (integration)
- [x] GM12: the model fails with a permanent code → stop at `grill`; a comment while stopped → `IGNORED`
  `no-transition`, no reply; `/retry` → one evaluation whose prompt holds both comments, one reply (integration)
- [x] GM14's third case: round 2's post fails once (transient) and a new comment's event runs before the retry →
  round 2 posted once, then that comment evaluated; the retried event posts nothing (integration)
- [x] `model: max-grill` on the issue → the evaluation and the round comment name the `max` model; a changed
  description → the next prompt has the new text; an edited comment and an `octocat` comment → never in a prompt
  (integration)
- [x] Log `… → WAITING (open Q2, Q3; 👀 on 1 comment)`

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass (2026-11-18: unit 44
  files / 1,038 tests; integration 24 files / 233 tests, 8 of them in `test/grill-round.integration.spec.ts`)

**Dependencies:** T2, T13
**Files:** `src/grill/grill-evaluation.service.ts`, `src/grill/grill.handler.ts`, `src/grill/grill.store.ts`,
`test/grill-helpers.ts`, `test/grill-round.integration.spec.ts`
**Scope:** M

### Task 16: The round limit and invalid answers

**Description:** Spec "Round limit": below the threshold, new questions, and `GRILL_MAX_ROUNDS` rounds already posted
(at least: a lowered setting counts too) → one transaction (evaluation `LIMIT`, its answers, the session `LIMIT`
with `endedAt`), then `LIMIT` back to the router with the body built from the row (P2, P3); spec 5 stops the run
(`grill-limit`, not retryable, no restart line: T5). Below the threshold with nothing new but something open →
`WAITING` even at the limit. Recovery step 2: a session already `LIMIT` returns the same body, no model call. Invalid
answers: spec 4's re-ask, then `invalid-answer` (retryable). The limit suite boots with `GRILL_MAX_ROUNDS=1`:
`ConfigModule.forRoot` reads the environment when `app.module.js` is first imported, so the suite sets it before its
imports (e.g. `vi.hoisted`; each integration file runs in its own module scope).

**Acceptance criteria:**
- [x] `GRILL_MAX_ROUNDS=1`: round 1 posted, an answer, the model wants a new question → `needs-human`, one stop
  comment = the limit body (gaps, three numbered steps naming `workflow: full-sdd`, the model line) with no "To start
  again from scratch" line; the run's stop `grill-limit`, not retryable (integration)
- [x] At the limit, nothing new but Q1 open → 👀, no stop (integration)
- [x] `/retry` → spec 5's reply "… stopped because the Grill round limit was reached, so it needs a restart …"
  (integration)
- [x] The stop's write failing once (the lease taken) → retried → the same body, no second model call (integration)
- [x] Three answers with `open: [7]` after five questions → `invalid-answer` stop with the `/retry` line; three
  `execution_logs` rows, attempt 2's prompt has the re-ask naming the rule (integration) (2026-11-18: after round
  1's three questions, since this suite runs with one round: "open lists Q7, but only Q1–Q3 were asked")
- [x] Log `… → LIMIT (confidence 80)`

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass (2026-11-18: the same run;
  5 tests in `test/grill-limit.integration.spec.ts`. The limit body now counts the rounds posted, `rounds` in
  `limitBody` (was `maxRounds`, the setting): a lowered setting still says how many were used, and a retry
  rebuilds the same text from the row)

**Dependencies:** T15
**Files:** `src/grill/grill-evaluation.service.ts`, `src/grill/grill.handler.ts`, `test/grill-limit.integration.spec.ts`
**Scope:** S

### Checkpoint 4 — Answers on the sandbox

**On GitHub you'll see:** on `#A`, one reply per answer comment (round 2 numbered on, or the `spec` stop once it's
clear); a 👀 by the bot on a partial answer or a side remark and no new comment (or one round with "Still open from
before"); one reply for two quick comments; an edit, `/retry` while asking ("Run 1 isn't stopped") and `octocat`'s
signed comment change nothing in the next prompt; after `model: max-grill`, the model line says `gemini-4-carbon`
(max). On `#D` with my instance at `GRILL_MAX_ROUNDS=1`: the "⚠️ Grill Me used its only round …" stop with three
steps and no restart line, and `/retry` → "needs a restart". With my instance on a wrong `GOOGLE_API_KEY`: the
`bad-api-key` stop; a comment while stopped gets nothing; key fixed and `/retry` → one reply that read both. My
instance killed while the model thinks → still one reply.
**Matrix rows:** "Questions and answers": every row but the first and `#E`; "Commands while asking": `/retry` and
`model: max-grill`; "Round limit": the first two; "Failure and `/retry`": the first; "Recovery": the first.
- [x] `typecheck`, `lint`, `test`, `test:integration` green
- [x] The rows above, ticked in the spec (2026-11-18: `#A` = #22, `#E` = #25 for the two quick comments, `#D` = #26
  with my instance at `GRILL_MAX_ROUNDS=1`, a new `#F` = #27 for the comment while thinking and the kill, run again
  after Google cut their first tries short; `gemini-4-hydrogen` failed 18 of its 31 calls with the real key (HTTP
  503, once no answer within 300 s), its 13 answers took 60 s on average; `gemini-4-carbon` answered both calls)
- [ ] You review and commit

---

## Phase 5 — `/approve` and `grill: skip` while the bot is asking

### Task 17: `/approve`, `grill: skip` and ended sessions

**Description:** Spec "`/approve`, `grill: skip` and `/retry` while the bot is asking" (GM8, GM14, GM15). `approve`:
one reply per `/approve` comment (marker `grill-approve:<commentId>`) listing the questions open now, from the
latest evaluation that acted (`ASKED`: its questions and the earlier ones it lists; `WAITING`: its `open`). `skip`
mid-way: the unread answers read without a model call, the session `STOPPED` (`stoppedBy` = the label event's sender)
with "Grill Me stopped by `<login>` (`grill: skip` added): …", or "Grill Me stopped (`grill: skip` is on): …" when a
comment or a retried run start took the skip path. Every op first finishes a pending round (GM14). P1: a session
that has ended first posts its missing closing comment (by marker), then returns `CLEAR` (or `LIMIT`) to every op,
with no model call.

**Acceptance criteria:**
- [x] `/approve` by an Approver → one reply naming the open questions; a second `/approve` comment → its own reply;
  the job retried → no second reply; status, rounds and evaluations unchanged; a Participant's `/approve` → spec 2's
  reply (integration)
- [x] `grill: skip` added while asking → answers read without a call, session `STOPPED` with the login, one stopped
  comment, the `spec` stop; the label added and removed before its event runs → no stopped comment, the questions
  go on (P1: the event `DONE`) (integration)
- [x] A comment while asking with the label on (added while the issue was closed) → "Grill Me stopped (`grill: skip`
  is on)" (integration)
- [x] A round `PENDING_POST` when `/approve` or `grill: skip` arrives → the round posted once first, then the reply
  or the stop (integration)
- [x] P1: session `STOPPED`, the `spec` step fails, the label removed, `/retry` → the `spec` step again, no model
  call, no comment from Grill Me (integration)
- [x] P1: the stopped comment's post fails once and the label is removed before the retry → the retried event posts
  "Grill Me stopped by `<login>`" once (marker, stored login), then the `spec` step (integration)
- [x] Log `#12 run 2 grill: stopped by grill: skip`

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass (2026-11-18: unit 44
  files / 1,038 tests; integration 25 files / 245 tests, 12 of them in `test/grill-commands.integration.spec.ts`,
  also `/approve` after a 👀 wait and after a "Still open" round, and the matrix's `grill: skip` while stopped by
  a failure, then `/retry`)

**Dependencies:** T16
**Files:** `src/grill/grill.handler.ts`, `src/grill/grill.store.ts`, `test/grill-commands.integration.spec.ts`
**Scope:** M

### Checkpoint 5 — Commands on the sandbox

These rows need an issue the bot is asking on: if `#A` became clear at Checkpoint 4, a new run on `#A` (remove the
label and add it again) or `#E`.
**On GitHub you'll see:** on `#A`, `/approve` → one "There's nothing to approve yet: the bot is still asking
questions (still open: …)" reply per `/approve` comment; `grill: skip` → one "Grill Me stopped by `<you>` (`grill:
skip` added): …" comment, then the `spec` stop. On another asking issue, `grill: skip` added and removed within a
second → nothing; your next answer gets a normal reply. On a run stopped by a wrong key, `grill: skip` added while
stopped, then `/retry` (key fixed) → "Grill Me stopped (`grill: skip` is on): …" and the `spec` stop, no question.
**Matrix rows:** "Commands while asking": `/approve`, `grill: skip`, the add-and-remove row; "Failure and
`/retry`": the second.
- [x] `typecheck`, `lint`, `test`, `test:integration` green
- [x] The rows above, ticked in the spec (2026-11-18: on two new issues, `#G` = #28 and `#H` = #29, instead of a
  new run on `#A` or `#E`: a restart before T18 would post a run-ended comment without the answers block, and
  `#A`'s answered rounds are Checkpoint 6's; the first rows with `gemini-4-carbon` as the sandbox's standard model:
  its 3 answers took 36 s on average, and its 2 failures were absorbed by the worker's own retry)
- [ ] You review and commit

---

## Phase 6 — Cancel and restart

### Task 18: The answers block

**Description:** `answers-block.ts`, pure, spec "Answers block": the rounds with at least one answer, in order;
answers read before the first question first; each round its questions with their guesses, then `<login>: <text as
written>`; inside a fence one backtick longer than the longest run inside (at least three); `sdd-agent` markers
removed; an answer over 2,000 characters cut with "… (cut; full comment: <url>)" or "… (cut; the full comment is on
the issue)"; over 60,000 characters the oldest answers left out and a first line saying how many; the header for a
cancel or for a replacement (GM17); no answer → `null`.

**Acceptance criteria:**
- [x] The spec's example block for the spec's example rounds, word for word (unit)
- [x] A ```` ``` ```` fence inside → a four-backtick fence; `<!-- sdd-agent:test -->` gone; 2,500 characters with and
  without a url; 61,000 characters → the oldest left out with the count; a round with no answer left out; the
  replaced header names run N+1 (unit)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass (2026-11-18: unit 45 files / 1,047 tests, 9 of them in
  `src/grill/answers-block.spec.ts`; the left-out count is the first line inside the code block, and the marker
  removal is shared with `cleanModelText` as `withoutMarkers`)

**Dependencies:** None
**Files:** `src/grill/answers-block.ts` (+ `.spec.ts`)
**Scope:** S

### Task 19: The cancel hook and `transcript()`

**Description:** Spec "Cancel and restart: the answers block" (GM10, GM16, GM17): `onCancel` reads the answers not
read yet that were received before the ending event (P6), with no model call; closes an `ASKING` session as
`CANCELLED` (one update); returns T18's block with the header for `end` (P6), or `null`. A run with no session
(`code-only`, or cancelled before its first evaluation) → `null` at once, nothing read. Safe to call twice (spec 5
plan Q1). `GrillService.transcript(runId)` for spec 7: the rounds (questions with guesses) and answers (author, text
as written, comment id, url), in order; exported by `GrillModule`.

**Acceptance criteria:**
- [x] Two answered rounds, the label removed → one run-ended comment ending with the block (cancel header), session
  `CANCELLED`, `status: draft` (integration)
- [x] The lane swapped → the "replaced" comment with GM17's header naming run N+1; the new run starts at Q1 and its
  prompt has none of the old answers (integration)
- [x] GM16: an answer stored while the run is stopped, never read → in the block; one received after the ending
  event → not in it (integration)
- [x] The run-ended comment's post failing once → the hook called twice → the same block, the session closed once,
  no answer read twice (integration)
- [x] No answer → no block; a `LIMIT` or `STOPPED` session keeps its status, its answers in the block (integration)
- [x] A `code-only` run cancelled → no block, no Grill row, no `getAccessLevel` call (integration, the real hook)
- [x] `transcript()`: rounds and answers in order; a `SKIPPED` session → only the answers its skip read (none at a
  plain run start) (integration)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass (2026-11-18: unit 45
  files / 1,047 tests; integration 26 files / 255 tests, 10 of them in `test/grill-cancel.integration.spec.ts`;
  the retried cancel event ends `IGNORED` `no-transition` after posting the pending comment, as spec 5 designed)

**Dependencies:** T17, T18
**Files:** `src/grill/grill.handler.ts`, `src/grill/grill.store.ts`, `src/grill/grill.service.ts`,
`src/grill/grill.module.ts`, `test/grill-cancel.integration.spec.ts`
**Scope:** M

### Checkpoint 6 — Cancel and restart on the sandbox

**On GitHub you'll see:** on `#A` with two answered rounds, removing the label → `status: draft` and one run-ended
comment ending with "**Your Grill Me answers from run N.**" and a code block (questions, guesses, `<you>: …`), which
notifies nobody; adding it again → a first question from Q1 that ignores the old answers. A swap to `workflow:
spec-code` → the "replaced" comment with "Run N+1 started from the issue description and won't see them: …". A run
cancelled before any answer → no block. Answers with a fence, a marker line and 2,500 characters → one clean code
block with the long answer cut and linked. On `#D` (limit): removing the label → the block; pasting the answers into
the description and adding the label again → run 2 starts at Q1 (or "no questions needed"). A failure stop with
"Q4: …" unread, then the label removed → the block has "Q4: …".
**Matrix rows:** "Cancel, restart and the block": all four; "Round limit": the last two; "Failure and `/retry`":
the third.
- [x] `typecheck`, `lint`, `test`, `test:integration` green
- [x] The rows above, ticked in the spec (2026-11-18: `#A` = #22, runs 1 to 4; `#D` = #26; six `gemini-4-carbon`
  calls, all answered on the first try, 23 s on average)
- [ ] You review and commit

---

## Phase 7 — Docs and full verification

### Task 20: Setup guide, `AGENTS.md`, `README.md` and the spec

**Description:** The spec's "Setup & configuration": section 3 replaces the `grill` placeholder line with a link to
the reference sandbox's skill and notice (P5); the three variables in section 5; a new section "When the bot asks
questions" (answering with Q-numbers, 👀, `grill: skip`, the round limit and how to continue); "Reference: labels"
(`grill: skip` also stops the questions); "Usage data" (the four tables, one example query); "Reference: what the
bot never posts" (no `@` in Grill Me comments); "When an issue is in `needs-human`" (its "until spec 6" line);
section 8 "Smoke test" (a `full-sdd` label now calls the model and posts questions; a comment is an answer).
`AGENTS.md`: State and the next spec (11, `skill-discovery`; 2026-11-18, overview D27). `README.md` where it names
what changed. The spec's status line and any line the build had to change.

**Acceptance criteria:**
- [x] Every command and variable in the guide exists (`package.json`, `envSchema`); the example query runs on the dev
  database (2026-11-18: `grill_of` as written, on #22 and #26; the two `curl` links of section 3 fetch the files
  from the sandbox's `main`. The sandbox README's "only way out of `needs-human`" line, stale since spec 5, is fixed
  in your sandbox clone, not committed)
- [x] `AGENTS.md` says spec 6 is built and names spec 11 (`skill-discovery`) as next

**Verification:**
- [ ] Manual: you read the changed guide sections once

**Dependencies:** T19
**Files:** `docs/guides/setup-github-agent-local.md`, `AGENTS.md`, `README.md`, `docs/specs/spec-github-agent-grill-me.md`
**Scope:** S

### Task 21: Run the verification matrix and the success criteria

**Description:** Every row of the spec's matrix and the overview rows marked 6, as for specs 1–5: I run what I can
(SQL, `gh api` reads, log greps, my instance with other settings) with its log in the scratchpad; the sandbox steps
as agreed at Checkpoint 3. Rows passed at Checkpoints 3–6 run again only where a later task touched their path.
Results ticked in the spec; the spec's and the plan's status lines set.

**Acceptance criteria:**
- [x] Every matrix row is ticked or reported failing with its output (no silent skips); the "Invariants" are scoped
  to rows stored since Checkpoint 3 and say so (2026-11-19: no row failed. Run again on the sandbox because plan
  T17 moved their path into `ended()` and the wait into `acted()`: "no questions needed" on #23 run 3, "skipped" on
  #24 run 2, the 👀 wait and the `spec` stop after a round on #22 run 5, the round limit and its `/retry` on #26
  run 2 with my instance at `GRILL_MAX_ROUNDS=1`; five `gemini-4-carbon` calls, all answered on the first try, 20 s
  on average. The
  invariants: one script over the 97 comments on #22–#29 and the dev database's Grill rows, its output in the
  scratchpad (`t21/check.log`). The overview's five rows marked 6 are the spec's rows on cancel with answered
  rounds, answering only Q1, `grill: skip` and `/approve` while asking, the kill after a post, and the round limit:
  all passed, left unticked in the overview like the rows of specs 1–5)
- [x] "Not checked by hand": the integration tests named (crash windows, the hook twice, invalid answers, a
  Participant-only sender) pass (2026-11-19: the seven tests named in the spec, by name, in a verbose run of their
  five suites: 43 tests pass)
- [x] The spec's success criteria: no question comment posted twice (one query over the sandbox's comments and
  `grill_rounds`), every evaluation in `grill_evaluations` with its `log_id` (2026-11-19: 18 rounds, each with
  exactly one comment carrying its marker, the stored one; 32 evaluations, each with its own `execution_logs`
  row; the 32 successful `grill` calls of a run, each with its evaluation; the other 31 calls with a run are
  errors: 28 `provider-unavailable`, 3 `bad-api-key`)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` green (2026-11-19, after Task 20:
  unit 45 files / 1,047 tests, integration 26 files / 255 tests)

**Dependencies:** T20
**Files:** `docs/specs/spec-github-agent-grill-me.md` and this plan (checkboxes and status only), plus fixes if a row
fails
**Scope:** S (more if a row fails)

### Checkpoint 7 — Complete

- [x] The spec's "Success criteria" are all checked (2026-11-19, the note under them)
- [x] "Spec 6 check A" to "E" closed (P4) (2026-11-19, as completed, with `#F` to `#H` (#27–#29), made for this
  matrix too; their `issues.closed` events `IGNORED` `unsupported-event`)
- [ ] You review and commit; spec 11 (`skill-discovery`) is next in the build order

---

## Noticed while planning (not changed)

- While the first evaluation runs (a Gemini call can take minutes), the issue still shows `status: draft`: the label
  follows the outcome (spec 5's projection), so `grilling` appears with the first question.
- Comments written after Grill Me ended clear (before the Spec is posted, or while the Spec step is stopped) are not
  in `GrillService.transcript(runId)`. Spec 7 decides whether its Spec reads the answers not read yet (the reader
  can serve it).

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| A question comment posted twice, or never, when the app crashes or GitHub fails between a write and a post | High | Two transactions and a marker; every op finishes what a crash left first; T11 makes each window fail once (`failNextOn`, a store spy) and asserts one comment |
| An answer read twice, or lost (bursts, comments while thinking or while stopped) | High | One reader over the stored events, any status; `(session_id, comment_id)` unique; look again before acting; T10, T12, T15 |
| An issue stuck in `grilling` after Grill Me ended | High | P1; T17's test of the scenario |
| The real `grill` handler breaks spec 5's suites | Med | P8: they keep a scripted `grill` through `startApp` and pass otherwise unchanged (T11) |
| Gemini refuses the Grill JSON schema (lengths, integer ranges), numbers its questions or mentions people | Med | The first real call is Checkpoint 3's first row; GMW3's cleaning; a leading number in a question is shown as it comes, and a fix is asked first (texts approved, Boundaries) |
| The real model rarely waits (👀), rarely clears, or clears too soon | Low | Rows that need one outcome get it from my instance's settings (`#B`: a lower threshold; `#D`: `GRILL_MAX_ROUNDS=1`) or a fresh run; the others accept either outcome; the scripted model covers each path |
| A long Gemini call, or the Mac asleep, looks like a provider failure | Med | Lid open during model rows; `pmset -g log` before blaming Google; the lease heartbeat covers long calls |
| The sandbox skill trips spec 4's patterns or contradicts the frame | Low | T14 checks both; the frame wins over the method (spec 4's fixed paragraph) |
| A lost webhook delivery leaves an answer unread | Low | Redeliver it from the App's settings (spec 2, IA13); the reader takes it then |
| The migration harms the dev database | Low | Four new tables only (P9); you run it |

## Open questions

- **P1–P5:** asked one at a time before approval; all five confirmed 2026-11-17, each as the guess. T0 writes the
  spec and overview lines they change before any code.
- **P6–P9:** nothing changes on GitHub; confirmed with the plan unless you say otherwise.

## Review

A general-purpose subagent with no context from this session read the spec, this plan, overview §3–§4 and the code
it changes (2026-11-17). Verdict: "ready after fixes". It confirmed P1's stuck issue by tracing `decide()` and the
spec's recovery rules, and found P2–P9 real gaps or needed choices, none against a GM or GMW decision. All 11 findings
were checked against the code and applied the same day; none needed a new decision:

| # | Finding | Kind | Applied |
|---|---|---|---|
| 1 | T5 drops the restart line that spec 5's scripted-`LIMIT` test asserts (`test/needs-human.integration.spec.ts:331`); T5 ran unit tests only | bug | T5 updates the test and runs `test:integration`; T11's line corrected |
| 2 | P1 as worded made an ended session skip its own closing comment: a retried skip (T13's crash test) or a "stopped" post that failed before the label was removed would never be posted | bug | P1: post the missing closing comment by marker first, then `CLEAR`; T17 test |
| 3 | GM14's third case (a comment while a question is half-posted) had no test | gap | T15 criterion |
| 4 | The guide's section 8 "Smoke test" says `full-sdd` stops at `grill` and a comment ends `no-transition` | gap | T20 |
| 5 | `#B` needs "no questions needed" whatever the model judges; `#A` may be clear before Checkpoint 5's asking rows | gap | Checkpoint 3 (lower threshold on my instance), Checkpoint 5 (a new run), risk row |
| 6 | The real cancel hook runs on every run end, `code-only` included, untested there | gap | T19: no session → `null`, nothing read |
| 7 | T3 claimed spec 2's classify tests pass untouched; one uses `toEqual` on a comment whose fixture sends `html_url` | nit | T3 criterion |
| 8 | The reader's statuses left out `PROCESSING` (the triggering comment's own event) | nit | T3, T10 |
| 9 | A `SKIPPED` session can hold the answers its skip read; T19 and the spec's "Agreed for later specs" said none | nit | T19; T0 fixes the spec line |
| 10 | No criterion for the `→ LIMIT` log line | nit | T16 |
| 11 | P8 named the table suite (it builds services directly) and called the duplicate registration a startup error | nit | P8 wording |

It checked and found fine: exactly five suites register a scripted `grill`; the hook gets only `{task, run, lease}`
today (P6 needed); `SessionLeaseService` isn't exported yet; no module re-exports the issue port or `EventsService`
(P7); `external_ref` is stored with the event, so queued comments are readable; P2's cut lines exist only during the
live call; the sandbox README's two stale lines; every listed unit and integration test maps to a task; T14 is pushed
before Checkpoint 3.
