# Implementation Plan — Spec #7: Spec, Plan and Approvals

> **Created:** 2026-11-22 · **Status:** approved 2026-11-22, not built (fresh-context review 2026-11-22, its findings
> applied the same day: see "Review"; P1–P11 and P33 confirmed one at a time the same day, all as recommended; P4's
> recommendation changed while explaining it: the approved Spec's reads count at the Plan's approval)
>
> **Why this file exists:** turns the approved spec `docs/specs/spec-github-agent-spec-plan-approvals.md` (spec 7,
> `spec-plan-approvals`, approved and committed 2026-11-22 in `91d2ed7`) into ordered, verifiable tasks (skill
> `agent-skills:planning-and-task-breakdown`). The spec stays normative: this plan adds order, slicing and build-time
> decisions only. The task checklist lives here (repo placement rules override the skill's `tasks/todo.md`). It is the
> one plan for everything the spec changes, including the code that specs 2, 3, 4, 5, 6 and 11 built (`src/intake`,
> `src/github`, `src/llm`, `src/workflow`, `src/grill`, their fakes and tests) and the sandbox's `spec` and `plan`
> skills (SP11).
>
> **Also read:** overview `docs/specs/spec-github-agent-architecture-overview.md`: D28–D31; §3 (R2, rows 5, 17–20,
> 27, 32–36); §4 (`WorkflowInput`, `RepoProvider`, the step-skill contract); §6 (`TaskDocument`, `DocumentAction`,
> `ContextLoad`). Spec 5 "Step-handler registry"; spec 6 `GrillService.transcript()`; spec 11 "The two tools".
>
> **Build effort:** xhigh (overview §1, row 7).

## Overview

Spec 7 builds the texts a human approves before any code exists. When Grill Me ends, the bot writes the **Spec**
and posts it as an issue comment; an Approver edits that comment if needed and comments `/approve`; the bot stores
the text as the comment reads then (the **approved snapshot**) and, in `full-sdd`, writes the **Plan** from it the
same way. A `code-only` run gets a **go-signal** comment instead. Spec and Plan can list and read the repo's files.
Each document records the commit it read; an `/approve` asks GitHub which of the files it read have changed on
`main` since (the **commit check**), and `/refresh` brings a waiting document up to date without a restart. A deleted
document comes back with `/restore`. Every refused command gets one reply. Two new tables hold every version and
every answered action. Until spec 8 exists, the last approval before code ends with spec 5's stop at `workspace`
(`step-not-built`). Terms used below: **the waiting document** = the Spec, Plan or go-signal an `/approve` would
approve now; **a version** = one posted Spec or Plan comment (v1, v2 …).

Built in 27 tasks across 7 phases (T0–T26):

0. **Before any code:** this plan's decisions in the spec.
1. **Foundations, nothing new on GitHub:** the document text (pure, with `diff`), the two tables, the compare call,
   the text maximum, the two read tools.
2. **The Spec:** Grill Me ends → Spec v1 (and the sandbox's `spec` skill).
3. **`/approve`:** the verdict, the approved snapshot, the Plan, the warning reply, the go-signal, every reply to
   `/approve` and to a late comment (and the sandbox's `plan` skill).
4. **`/refresh`:** in `spec-review`, then while the Plan waits.
5. **Deletions, `/restore`, the run's end.**
6. **The invariant script, the docs, the verification matrix.**

Real GitHub is reached at Checkpoint 1 (`npm run github:smoke`), Gemini from Checkpoint 2 on. You review and commit
at each checkpoint (I never commit). Every code task ends with `npm run typecheck && npm run lint && npm test && npm
run test:integration` green.

## Build-time decisions (not in the spec; to confirm with this plan)

Each told as what happens on GitHub. P1–P5 change something you can see: to ask one at a time. P6–P11 and P33 change
nothing on GitHub but have a real choice: to ask after them. P12–P32 and P34–P38 follow from a rule named in their
row. P33–P38 come from the review (2026-11-22); P39–P41 from Checkpoint 3 (2026-11-23).

| # | On GitHub | My guess (and the alternative) | Spec lines it changes |
|---|---|---|---|
| P1 | `bob` comments `/refresh` (the whole comment, like `/approve`); `main`'s code changed, so the bot changes one sentence of a 40-line Spec. Spec v2's comment has the folded "Diff from v1" block. | **Confirmed 2026-11-22. Hunks as `git diff` shows them:** 2 unchanged lines around each change and the `@@ -12,5 +12,5 @@` line that says where, without the `---` / `+++` file lines. *Alternative:* only the changed lines, as the spec's example shows (shorter, but a changed line is hard to find in a long Spec). | "The v2 comment" (the example, one line) |
| P2 | The model answers the Spec with 71,200 characters, three times. The run stops. | **Confirmed 2026-11-22. The stop comment speaks to people:** "⚠️ **Run 2 stopped at step `spec`:** model `gemini-4-carbon` answered with 71,200 characters, more than the 50,000 a document may have, also after 2 requests to shorten it. Adding `model: max-spec` before `/retry` may help. (`invalid-answer`)", then spec 5's `/retry` and restart lines. The model still gets the spec's re-ask ("your answer has 71,200 characters; at most 50,000 fit: shorten it"). The same for the Plan (`model: max-plan`). A refresh answers in a schema, so its too-long `document` gets the same re-ask through the schema's own message (Zod's `max` with a custom text) and stops with spec 4's form: "model `gemini-4-carbon` gave no valid answer: document: 71,200 characters, at most 50,000 fit" (review, 2026-11-22). *Alternative:* spec 4's message as it is: "model `gemini-4-carbon` gave no valid answer: your answer has 71,200 characters; at most 50,000 fit: shorten it" (the model-facing line, no hint). | SP7 (the stop's text); "Contracts" → `src/llm` (the error message beside the re-ask) |
| P3 | `alice` answered two Grill questions, Spec v1 waits, `bob` removes `workflow: full-sdd`. The run-ended comment has spec 6's answers block and spec 7's documents line. | **Confirmed 2026-11-22. The answers block first, then the documents line:** the run's own order (questions, then documents); in code, GrillModule registers its cancel hook before DocumentsModule. *Alternative:* the documents line first. | "When the run ends" (one line) |
| P4 | The Spec read `src/index.ts`; the Plan read `src/split.ts` only. After the Plan was written, `main` changes `src/index.ts`. `bob` comments `/approve` on the Plan. | **Confirmed 2026-11-22, the alternative to my first guess: one warning reply.** A Plan's flagged files are what its own calls read, its earlier versions' (a refresh, a restore), and, following `basedOnId` to the approved Spec, the Spec's chain too, as the spec's "Approving" step 2 already reads. The reply names who read each file: "… changed `src/index.ts`, which the approved Spec read" ("which it read", "which it and the approved Spec read"). No double warning: the range starts at the Plan's commit, so what the Plan's header already showed isn't repeated. Reason (you): the Spec must never stay stale, and the code is written from both texts. *My first guess:* the Plan's own reads only ("which it read"). | "The warning reply" (the file's reader named) |
| P5 | `bob` deletes everything between the Spec comment's hidden markers, then comments `/refresh`. | **Confirmed 2026-11-22. One reply, no model call:** "Spec v1's comment has no text left between its markers, so there's nothing to refresh. Edit the comment to put the Spec back, then comment `/refresh`." (`document_actions` `refresh`, result `empty`), as for `/approve` (SPW5). *Alternative:* refresh from the empty text (the model writes the Spec again from nothing; v2's diff shows every line). | "`/refresh`" step 1 (one line); `document_actions.result` (`empty`) |
| P6 | No difference (only the event's reason in `npm run db:events`). | **Confirmed 2026-11-22. A handler can end the event `IGNORED`:** spec 5's `StepOutcome` gains `{ type: 'IGNORED'; reason }`, which decide() turns into `ignore(reason)`. The `documents` handler returns it after each of its replies (`approve-refused`, `approve-hint`, `late-comment`, `refresh-refused`, `restore-refused`) and when a comment or a deleted bot comment needs nothing (`no-transition`): only the handler can tell, since it reads the documents. *Alternative:* the router asks a wider check before decide() (comments and deletions too), so decide() picks each reply itself; the same rows are then read twice per event. | "Contracts" → `src/workflow` (`StepOutcome`); overview §3 "Inputs" (the step outcomes) |
| P7 | No difference (the same reply). | **Confirmed 2026-11-22. The no-run replies are spec 7's too:** `/approve`, `/refresh` and `/restore` on an issue with no run are answered by the check DocumentsModule registers (it becomes a small "gate" with two methods: the verdict, and the reply without a run), so they get a `document_actions` row with no run, counted with the other wasted actions. A step handler can't be called without a run (`StepContext.run`). *Alternative:* the router posts them from `workflow-comments.ts`, like `/retry`'s no-run reply; no row, and `document_actions.run_id` is never empty. | "Contracts" → `src/workflow` (the check → a gate) |
| P8 | No difference. | **Confirmed 2026-11-22. Older suites keep their stops:** as spec 6 plan P8 did for Grill Me, `startApp` replaces the four handlers by default with ones that stop the run as unbuilt steps (no cancel hook), so spec 5's and 6's suites keep asserting `step-not-built` at `spec` and `go-signal` unchanged (listed below); `startApp({ documents: 'real' })` for spec 7's suites; `startApp({ documents: { 'go-signal': handler } })` for a scripted one (`run-start` registers its own today, which would throw "already registered"). *Alternative:* the real handlers everywhere; every spec 6 suite scripts a Spec answer and asserts Spec v1 instead of the stop. | "Testing strategy" (the last sentence: those tests stay, through the default) |
| P9 | Only with `grill: skip` added before a retried run start (spec 6 GM15): the Spec's prompt then says "skipped". | **Confirmed 2026-11-22. `GrillService.transcript()` also gives the session's status** (spec 6's values: `CLEAR`, `SKIPPED`, `STOPPED` when the Spec is written; null without a session), so the Spec's turn says "skipped (grill: skip)" exactly when Grill Me was skipped. One field added to spec 6's contract. *Alternative:* no change to spec 6 (SPW24): "skipped" when the run started with `grill: skip` (`StepRun.grillSkip`), which misses GM15's case. | SPW24; "Changes to earlier specs' behavior" (the spec 6 bullet) |
| P10 | No difference, except that a Spec can't quote another step's skill or the bot's settings. | **Confirmed 2026-11-22. The read tools leave out `.github-agent/`,** like SPW1's files: `list_files` doesn't show it, `read_file` answers "Not available". It holds the bot's own settings: `workflow.json` (the model names), the other steps' skills and the license notice that spec 6 plan P5 placed so "the model never gets it". *Alternative:* serve it like any repo file (untrusted data). | SPW1 (one line); "The read tools" (the outcome table); overview D28 |
| P11 | No difference. | **Confirmed 2026-11-22. The invariant script gets a unit test:** its checks are pure functions over the rows and comments it fetched, exported from the `.mjs`; `scripts/spec-plan-approvals-invariants.spec.mjs` (Vitest's `include` gains `scripts/**/*.spec.mjs`) gives each invariant a fixture that breaks it and expects FAIL, and a clean fixture that passes. At T26 it also runs once on the sandbox with a wrong issue list, as the spec says. *Alternative:* as spec 11's script: only that one manual run. | "Commands" (one line) |
| P12 | No difference. | **`task_documents.notes`** (text[]): the lines under a version's rule, stored with it, so a restore repeats them (spec 6 plan P2's rule: what a later post repeats is stored, never parsed back from a comment). | "Owned tables" (`TaskDocument`, one row) |
| P13 | No difference. | **`"diff": "9.0.0"`, pinned exactly,** as you asked (the other dependencies use `^`). `npm view` (2026-11-22): BSD-3-Clause, no dependencies, its own ESM types, published 2026-04-13. | "Tech stack" ("version pinned in the plan") |
| P14 | No difference. | **`StepContext` gains `status`, `statusBeforeStop` and `approval`,** copied from decide()'s state and the run's row, so the `documents` handler words a reply by status, finds the waiting document of a stopped run, and doesn't read the verdict again. The router builds the only `StepContext` (`router.service.ts:541`). | "Contracts" → `src/workflow` (one line) |
| P15 | Only after a crash between posting the Plan and writing the status. | **The waiting document is chosen by status** (the spec's "The waiting document"): in `spec-review` the run's current Spec, in `ready-for-dev` its current Plan or go-signal, in `needs-human` the one of `statusBeforeStop`; an approved one means "nothing waits" for `/refresh`, `/restore` and deletions. (Review, 2026-11-22: my first guess, "the latest document", would answer a retried `/approve` in `spec-review` with `done` while a Plan is already posted.) | — |
| P16 | Only if someone edits the comment in the same second. | **The approve op reads the comment again** (spec "Boundaries": "read the comment again at `/approve`") and approves that text; gone or empty since the check → the refusal reply, `IGNORED` `approve-refused`, nothing approved, the list stops (no Plan). | — |
| P17 | No difference (correct counts). | **`\r\n` becomes `\n`** before the text is extracted, counted, diffed and stored: GitHub's web editor saves edited comments with `\r\n`, so without it every line of an edited Spec would count as changed. | — |
| P18 | No difference. | **`read_file` text goes through spec 4's guard:** detected, cut at 65,536 characters with its marker line, wrapped in the call's untrusted tag with the label "the file `<path>`". A cut file gets no notes line (spec 4's line is for the turns' texts). | — |
| P19 | No difference. | **`read_file` serves every listed file** (an `AGENTS.md`, a skill file) as untrusted repo data; a path already given in the call (also through `load_file`) → `already-loaded`; a folder listed twice → `already-loaded` ("`src` is already listed in this conversation."). | — |
| P20 | No difference. | **Flagged files come through `ContextLoadService`** (spec 11 owns `context_loads`): a read method that joins `execution_logs` by `call_id` for a list of `log_id`s; `LlmModule` exports it. | "Contracts" → `src/llm` (one line) |
| P21 | No difference (the reason only). | **A deletion on a closed issue ends `issue-closed`:** spec 5's closed rule runs first (spec 5 plan P5); the spec's list says `no-transition`. | "Deleted documents" (the "anything else" line) |
| P22 | No difference. | **`npm run github:smoke` calls `changedFiles` and `compareUrl` too:** spec 3's smoke calls every GitHub method once; it compares the base branch's commit with itself (empty, complete) and prints the compare URL. | — |
| P23 | No difference. | **Test fixtures:** spec 7's suites send comments with `createdAt` = now (the payload fixture's default, `2026-11-11`, is before every document: every `/approve` would be `before-document`, every comment "late"); the fake issue provider gains `editComment` (a human edit, not a provider method); `CommentOptions.author` sets the comment's author apart from the sender (a deletion). | — |
| P24 | A restored Spec v2. | **A restore repeats what is between the markers and the notes**, with the spec's restored header and line: v2's "What changed" list and diff block (outside the markers) aren't repeated. Rule: the spec's `/restore` table. | — |
| P25 | No difference. | **The migration** `prisma/migrations/<ts>_documents`: the two tables with the spec's indexes, foreign keys to `tasks`, `runs` and `task_documents`, back-relations on `Task` and `Run` (no new column there); `test/db.ts` empties both tables. Created against the test database; your dev database changes when you run `npm run db:migrate`. | — |
| P26 | No difference. | **The gate (P7) is registered with spec 5's registry** (`registerGate`; one, like a handler name). The router asks its verdict only for `APPROVE` in `spec-review` or `ready-for-dev` with a run; `ApprovalVerdict` lives in `src/workflow/decide.ts`, so `WorkflowModule` imports nothing from `src/documents`. | — |
| P27 | No difference. | **The `done` verdict** is `steps` with no calls: the event ends `DONE`, nothing is posted (R2). | — |
| P28 | No difference. | **A `/refresh`'s `document_actions` row records each call's result before the next step** (written in the same transaction as a new version or a `checkedCommit`), so a retried event never asks the model twice for a step that already answered. | — |
| P29 | No difference. | **`ContextLoaderService` gets the secret scanner** (SPW2); `LlmModule` imports `SecretScanModule`. | — |
| P30 | No difference. | **One integration file per slice:** `test/documents-store`, `-spec`, `-approve`, `-plan`, `-replies`, `-refresh`, `-restore`, `-run-end` `.integration.spec.ts`, with `test/documents-helpers.ts`. | — |
| P31 | Only for a model text that has a mention outside code *and* a stray backtick or backslash. | **SPW20's cleaning keeps code as written:** spec 6's `cleanModelText` drops every backtick and backslash in that case, which would break a document's code. For documents, a mention outside code goes in backticks; in that rare case its `@` is dropped instead (`alice`), so nobody is notified and the code stays. Fenced blocks (``` and `~~~`) and inline code are left as written. Rule: SPW20 ("code blocks and inline code are left as written"). | SPW20 (one line) |
| P32 | `main` was force-pushed and the Spec's commit is gone; `bob` comments `/refresh`. | **The refresh still runs:** the frame says "the bot couldn't list the files changed since `4f2c1ab`; read what you need" in place of the list, as SPW22 never blocks. Only GitHub's "unknown commit" (404, 422) counts as not compared, here and at an approval; a 401 or 403 is a failure (row 28) (review, 2026-11-22). | "`/refresh`" step 3 (one line); SPW22 (one line) |
| P33 | Only in the Plan's prompt: which files changed since the Spec. | **Confirmed 2026-11-22. The changed paths are stored at the approval:** `task_documents.changed_paths` (text[], up to GitHub's 300) next to `changed_files`, so `plan generate` builds its "files changed" paragraph from PostgreSQL, also after a `/retry` hours later, with one compare per approval; the dashboard can read them too. The paragraph then spans the Spec's commit to the approval's commit. *Alternative:* `plan generate` asks `changedFiles` again from the Spec's commit to its own (one more GitHub call per Plan, SPW22's case handled there too; the paragraph matches the Plan's own commit exactly). (Review, 2026-11-22: the spec's table had only the count.) | "Owned tables" (`TaskDocument`, one row) |
| P34 | No difference. | **Every op first replays its own row:** a version by `(run_id, kind, trigger_comment_id)` (the run's first Spec: by `origin` `written`), an action by `(action, source_comment_id)`; it posts whatever is still pending and returns the recorded outcome (`spec-changed` → `SPEC_REFRESHED` again, a refusal → `IGNORED` again), so a retried event never posts twice or asks the model twice (P28 is the refresh's case). Rule: the spec's "Two transactions + marker" ("a retried event finds the row"). (Review, 2026-11-22: a retried `/restore` would otherwise answer "still on the issue".) | — |
| P35 | No difference (the reason only). | **How a valid command's answers end:** a new version, a restore, "nothing changed" and "still up to date" end `DONE`; inside rows 32 and 34, an answer that did nothing (deleted, empty, already approved, nothing deleted, the Plan's `/restore` pointer) ends `IGNORED` `refresh-refused` / `restore-refused`, which also stops a two-call list (spec `refresh`, then plan `refresh`). Rule: `IGNORED` = the command changed nothing (spec 5's `retry-refused`). | — |
| P36 | No difference. | **decide()'s no-run reply** is a new action `{ kind: 'reply-without-run' }`: the router calls the gate (P7) and ends the event `IGNORED` with the command's `-refused` reason. | — |
| P37 | No difference. | **The go-signal's row:** `text` is empty (it has no document; the column is NOT NULL); `approved_text` is the title, a blank line, then the description as written, `redact()`ed. | — |
| P38 | No difference. | **One hint per waiting document** is enforced in code under the session lease (one job per issue, R3), not by a partial index (Prisma's schema can't hold one, and a raw one would show as drift). | — |
| P39 | `alice` comments "Q3: actually weekly" and `/approve` while the bot writes the Spec. Both replies come after Spec v1, below it, so neither is next to the comment it answers (#53, Checkpoint 3). | **Confirmed 2026-11-23. Every reply to a person's comment links that comment, as its subject:** "[Your `/approve`](…) was written before Spec v1 was posted, so it didn't count. …", "`alice`, [your comment](…) was written while the bot was writing the Spec …", "[Your comment](…) isn't an approval: to approve, comment exactly `/approve` …", "[Your `/approve`](…) approved Plan v1. Since it was written …". The link is the comment's own URL from the event; nothing from the comment is quoted (no repeated mentions, no echoed human text, D32). Spec 2's signed test requests carry no URL: "Your `/approve`" without a link. The `/refresh` and `/restore` replies (T18–T22) follow the same rule. *Alternative:* the link plus a quote of the comment's first line (rejected: it repeats human text). | SP12; "`/approve`" (the verdict table, the warning reply, the hint); "A comment written while the bot writes the Spec"; "Replies where nothing waits"; the matrix's warning-reply rows |
| P40 | Labels added while the bot wasn't running (#52, Checkpoint 3): `workflow: full-sdd` is on, but the bot never got its event, so there's no run. `bob` comments `/approve`. | **Confirmed 2026-11-23. The no-run reply names the label:** "[Your `/approve`](…) has nothing to approve: `workflow: full-sdd` is on, but the bot has no run for it yet. If none starts within a few minutes, remove the label and add it again." Several lane labels: "… keep one `workflow:` label, then remove it and add it again." (2026-11-23, after #56: first "it probably missed when the label was added", but the label's event may only be late; GitHub doesn't keep the order of deliveries.) The router already read the labels for this event (`NoRunContext.lanes`), so no extra call; `/refresh` and `/restore` the same (T18). *Alternative:* start the run from the comment (rejected: changes spec 5's rows). | "Replies where nothing waits" (one paragraph) |
| P41 | #50's Spec was read before a commit that changed two `.github-agent/` files (Checkpoint 3); the Plan's prompt listed their names. | **Confirmed 2026-11-23. Model-facing lists of changed paths leave out what the read tools hide (P10):** the Plan's "files changed" paragraph now (only hidden ones → no paragraph), the refresh frame (T18), spec 9's Coder later. The stored `changed_paths` and the people-facing lines (⚠️ line, warning reply) keep them: people can see the repository. *Alternative:* leave it to spec 12 (rejected: the names reach the model meanwhile). | "Writing the Plan" (one paragraph); "Agreed for later specs" (spec 9, one line) |

## Existing tests this plan changes (grep, 2026-11-22)

Every type, constructor, registered handler, `toEqual` over a row and `step-not-built` assertion the plan changes,
grepped across `src/**/*.spec.ts` and `test/**`. Each row belongs to the task named; a task isn't done until its rows
pass.

**Types and constructors:**
- `RouterState.approveValid` → `approval` (T11): `src/workflow/decide.ts:103, 320, 338`;
  `src/workflow/router.service.ts:628` (`stateOf`); `src/workflow/decide.spec.ts:79–89` (the `state()` builder),
  `:352–355` (row 16 with `approveValid: false`), `:379–430` (rows 17–19 need `approval: 'valid'`), `:431–443`
  (row 20: an invalid `/approve` → the `documents` `reply` call).
- `StepContext` gains `status`, `approval` (T7, P14): built only at `src/workflow/router.service.ts:541`;
  `test/fakes/scripted-step-handler.ts:13` records it (every test reads it with `toMatchObject`: unchanged).
- `HandlerName`, `HandlerOp`, `StepOutcome` (`IGNORED`, `SPEC_REFRESHED`), `RouterIgnoreReason` (T7):
  `src/workflow/decide.ts:17–35, 47–57, 106` (decide()'s outcome switch must handle both outcomes),
  `src/workflow/router.service.ts:62` (`EventIgnoreReason`), `src/workflow/step-handler.registry.ts:57–87`.
- `WorkflowInput` gains `REFRESH`, `RESTORE`, `BOT_COMMENT_DELETED` (T7, types only; intake produces them in T19, T21,
  T22): `src/contracts/workflow-input.ts`; `src/workflow/decide.ts:199–212` (`isIssueEvent`); `intake.service.ts`
  `describe()` (its default branch covers them).
- `ClosedCommand` gains `refresh` (T19) and `restore` (T22): `src/workflow/workflow-comments.ts:124`,
  `decide.ts` `onClosedIssue`; `src/workflow/workflow-comments.spec.ts:221–231`, `src/workflow/decide.spec.ts:827–836`
  (new cases beside the unchanged ones).
- `RepoProvider.changedFiles`, `compareUrl` (T3): every implementer: `src/github/github-repo.provider.ts`,
  `src/secret-scan/scanning-repo.provider.ts`, `test/fakes/in-memory-repo-provider.ts`;
  `src/secret-scan/scanning-repo.provider.spec.ts:22–39` (a `Proxy` recorder cast `as RepoProvider`: any method works;
  a pass-through case added); `src/github/smoke/run-smoke.ts` and `run-smoke.spec.ts:72–131` ("passes every check":
  one more line, P22).
- `LlmCall.output` gains `{ text: { maxChars } }` (T4): `src/llm/llm-call.ts`; `llm.service.ts` `ask` / `judge`
  (`output === 'text'`); the `'text'` cases at `src/llm/llm.service.spec.ts:167, 446, 745` stay as they are.
- `ContextLoaderService` constructor gains the scanner (T6, P29): `src/llm/context-loader.service.spec.ts:71`;
  `test/fakes/in-memory-context-loads.ts:76` (`contextLoaderOver`, which `llm.service.spec.ts:78`,
  `grill-output.spec.ts:179` and `run-llm-smoke.spec.ts:178` use: unchanged through the helper). Both build their
  `ConfigService` with the two discovery keys only, and `SecretScanner`'s constructor reads `GITHUB_WEBHOOK_SECRET`
  and `GOOGLE_API_KEY` (`secret-scanner.ts:25–29`): they pass a scanner built with test values (review, 2026-11-22).
  `loader.tools(setup)` → `tools(setup, repoFiles)`: `src/llm/llm.service.ts:82`,
  `context-loader.service.spec.ts:123–135`.
- `ContextLoadEntry.tool` / `kind` gain the new values (T6): types only; `test/context-load.integration.spec.ts:62`
  (a `toEqual` over every column) is unchanged: no new column.
- `GrillTranscript` gains `status` (T8, P9): `src/grill/grill.service.ts`; `test/grill-cancel.integration.spec.ts:341–
  378` and `:381–388` (two `toEqual` over the whole transcript gain `status`: `'ASKING'` for the run still asking,
  `'SKIPPED'`, and `null` for a run with no session).
- Prisma (T2, P25): `test/db.ts:12` (`TRUNCATE` list); `Task` and `Run` gain relation fields only, so no `toEqual`
  over a `tasks` or `runs` row changes (`test/workflow-tables.integration.spec.ts`).
- `LlmModule` exports `ContextLoadService` (T12, P20); `src/app.module.ts` imports `DocumentsModule` (T9).

**Registered handlers (P8):**
- `test/app.ts:173–201`: the `documents` option; by default the handlers T9, T11, T13 and T15 register are replaced by
  unbuilt stubs, each added in the task that registers the real one.
- `test/run-start.integration.spec.ts:180–185` registers `go-signal` after `startApp`: from T15 that throws "already
  registered" → `startApp({ grill, documents: { 'go-signal': goSignal } })`, T15.
- The five suites that pass a scripted `grill` (`cancel-restart:48`, `needs-human:200`, `retry:258`, `run-start:180`,
  `stale:172`): unchanged.

**`step-not-built` at `spec` and `go-signal`: these stay (P8):**
- Spec 6: `test/grill-commands.integration.spec.ts:189–190, 268, 328, 353–354, 386`;
  `test/grill-round.integration.spec.ts:149–156`; `test/grill-start.integration.spec.ts:281–284, 315–316, 438–439,
  471–472, 493`.
- Spec 5: `test/needs-human.integration.spec.ts:65–93`; `test/retry.integration.spec.ts:38, 151`;
  `test/run-start.integration.spec.ts:142–148, 169`; `test/cancel-restart.integration.spec.ts:262–263`.
- `test/workflow-tables.integration.spec.ts:185, 198` call `RunService` directly: unaffected.
- Spec 7's own suites assert the stop at `workspace` (the spec's "move to `workspace`").

**Behaviors:**
- Row 5 (T16): `src/workflow/decide.spec.ts:160–171` (`ev.approve()` in `draft` with no run → the gate's reply; the
  others stay ignored).
- Row 20 (T16): `decide.spec.ts:431–437`, the `COMMENT` part (→ the `documents` `reply` call, no longer ignored;
  `SKIP_ADDED` stays ignored); T11 changes its `APPROVE` part (review, 2026-11-22).
- Row 27 (T16): `decide.spec.ts:522–530` (`APPROVE` in `in-review`, `needs-human`, `executing` → the reply;
  `COMMENT`, `SKIP_ADDED` stay ignored).
- Intake: `src/intake/github-payload.spec.ts:598–608` (a human's comment deleted → still `comment-deleted`; T21 adds
  the bot's); `src/intake/intake.service.spec.ts:735–820` (`answerComments`: a `/refresh` or `/restore` is no longer a
  comment, T19, T22); `test/fixtures/github/payloads.ts:110–145` (`author`, T21); `src/intake/approve-command.spec.ts`
  (the near-miss check, T16).
- Closed issues (T19, T22): `test/closed-issue.integration.spec.ts:138–146` (`/approve`'s reply unchanged;
  `/refresh` and `/restore` added).
- Prompt (T5): `src/llm/prompt.spec.ts:252` ("Loading:" unchanged without the read tools), `:430–445` ("Read:"
  unchanged without repo files).
- Run-ended comments compared byte for byte (`test/grill-cancel.integration.spec.ts`,
  `test/cancel-restart.integration.spec.ts`): unchanged (no document in those runs; the default stub has no cancel
  hook), T23.
- `src/intake/ignore-reason.ts`: unchanged (no new intake reason).

## Dependency graph

```text
T0 decisions into the spec (on approval)
T1 document text + diff (pure) ─────────────────────────────┐
T2 tables + DocumentsStore core ────────────────────────────┤
T3 changedFiles + compareUrl ───────────────────────────────┤
T4 text maximum ─┐                                          │
T5 read tools (pure) ── T6 read tools in the loader ········┴··········· Checkpoint 1
T7 router seam + startApp option
T8 Spec frame + turns, transcript status ── T9 DocumentsModule + spec generate (T1, T2, T4, T6, T7)
T10 sandbox spec skill (after T9's frame) ································ Checkpoint 2
T11 gate + verdict + refusals (T9) ── T12 approving (T3, T6) ── T13 the Plan ── T14 last approval + warning
T15 go-signal (T11) ── T16 hint, late comment, nothing waits (T11) ── T17 sandbox plan skill ··· Checkpoint 3
T18 refresh texts (pure, T1) ── T19 /refresh in spec-review (T12) ── T20 /refresh while the Plan waits · Checkpoint 4
T21 deletions (T11) ── T22 /restore ── T23 run-ended line ·································· Checkpoint 5
T24 invariant script ── T25 docs ── T26 verification matrix ································ Checkpoint 6
```

One session builds them in number order. T1–T5 are independent of each other (T6 needs T5); T18 can be written any
time after T1. From T9 on every task changes `src/documents` or its suites, so nothing else runs in parallel.

**Your part (the build stops for these):**

1. **After T2:** run `npm run db:migrate`.
2. **Before Checkpoint 2:** read T10's `spec` skill and notice in your sandbox clone
   (`/Users/891944/Projects/sdd-agent-sandbox`), commit and push them to `main` (one paste-ready block).
3. **Before Checkpoint 3:** the same for T17's `plan` skill.
4. **Checkpoints 2–5 and T26:** stop `npm run dev` (the tunnel stays). I run my instance on port 3000 with the dev
   database and its log in the scratchpad. The sandbox steps (issues, labels, comments, edits, deletions of the bot's
   comments) I do with `gh` as you if you say so at the checkpoint; otherwise you do them, one per message. Keep the
   Mac awake (lid open) while the model is called.
5. **Checkpoint 4:** sandbox commits to `main` the refresh rows need (a change to a file the Spec read, a change to
   `README.md`, a change that makes an approved Spec wrong, a change only the Plan's files see), each as a
   paste-ready block; at the end one revert block, if you want the library back as it was.
6. **T26:** the test branch `smoke/spec-7-bad-model` (paste-ready), and the signed request from `octocat` (the guide's
   `send` helper; the classifier blocks me from loading `.env`).
7. **Every checkpoint:** you review and commit.

---

## Phase 0 — Before any code

### Task 0: This plan's decisions in the spec and the overview (on approval, before any code)

**Description:** The spec changes first when a rule, a contract or a table changes: the lines in the column "Spec
lines it changes" for every confirmed decision, each with the date and the plan's number (as specs 5, 6 and 11's
plans did), plus the review's fixes that need no choice. The overview where named (P6: the step outcomes; P10: D28).

**Acceptance criteria:**
- [x] Every confirmed decision with a "Spec lines" entry is in the spec, and in the overview where named (P1–P14,
  P20, P21, P31–P33; overview: P6, P10), plus two review fixes (finding 6: a `/refresh` while the Plan waits checks
  the Plan first; finding 1: the `/approve` diagram picks the waiting document by status)
- [x] Every matrix row a decision changes can be checked as written (P1, P3, P4 and P10 amend rows; P4 and P5 add
  one row each)

**Verification:**
- [ ] Manual: you read the diff of both documents

**Dependencies:** your approval of this plan
**Files:** `docs/specs/spec-github-agent-spec-plan-approvals.md`, `docs/specs/spec-github-agent-architecture-overview.md`
**Scope:** S

---

## Phase 1 — Foundations (nothing new on GitHub)

### Task 1: `diff` and the document text (pure)

**Description:** `"diff": "9.0.0"` in `dependencies` (P13). `src/documents/document-text.ts`, pure: the constants
(`DOCUMENT_MAX_CHARS` 50,000; GitHub's 65,536; the 65,000 at which a v2 drops its diff block), the two hidden
markers, and four functions. `cleanDocument(text)`: SPW20 with P31 (reuses spec 6's `withoutMarkers` and its mention
and code-span patterns, exported from `src/grill/grill-comments.ts`). `documentText(body)`: SPW5 (between the first
start and the last end marker; a marker missing → the whole comment without hidden `sdd-agent` markers), `\r\n` →
`\n` (P17), trimmed. `lineCounts(posted, approved)`: jsdiff's line diff → lines added and removed. `diffBlock(before,
after)`: P1's hunks in a ```` ```diff ```` fence one backtick longer than any run inside (spec 6's rule); null when the
texts are the same.

**Acceptance criteria:**
- [x] SPW20 and P31: a hidden marker in the model's text is removed (also one cut off at the end); `@alice` →
  `` `@alice` ``; `@Injectable()` in a ``` block, a `~~~` block and inline code stays; an e-mail address stays; a
  mention next to a stray backtick loses its `@` and the backtick stays
- [x] SPW5: the text between the markers; a removed start or end marker → the whole comment minus hidden markers; a
  human who typed the markers → the first start and the last end count; `\r\n` edits give the same text as `\n`
- [x] `lineCounts`: unchanged → 0 and 0; one line edited → 1 and 1; CRLF only → 0 and 0
- [x] `diffBlock`: P1's shape for a one-line change in 40 lines; a text with a ```` ```` ```` run gets a five-backtick
  fence

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass; `npm ls diff` shows 9.0.0

**Dependencies:** None
**Files:** `package.json`, `package-lock.json`, `src/documents/document-text.ts` (+ spec), `src/grill/grill-comments.ts`
(two exports)
**Scope:** S

### Task 2: The two tables and `DocumentsStore`'s core

**Description:** The migration (P25) with `TaskDocument` and `DocumentAction` as the spec's "Owned tables" plus
`notes` (P12) and `changed_paths` (P33). `src/documents/documents.store.ts`, the only writer, every transaction starting with `assertHeld`
(spec 5): `insertVersion` (Tx1: the row with its full `body`, `PENDING_POST`; in the same transaction every earlier
version of the same kind in the run that isn't superseded is superseded, and a new Spec also supersedes the run's
waiting Plan, SPW8), `markPosted` (Tx2), `pendingVersion(runId)`, `current(runId, kind)`, `waiting(runId, status,
statusBeforeStop)` (P15), `insertAction` (with its reply body, `PENDING_POST`) and `markReplyPosted`, and P34's two
lookups: `versionFor(runId, kind, triggerCommentId)` and `actionFor(action, sourceCommentId)` (also for a row with no
run). Later tasks add the approval, the deletion and the refresh writes.

**Acceptance criteria:**
- [x] The migration applies on an empty test database and on one with spec 11's rows (your dev database, at
  `npm run db:migrate`); the indexes are the spec's (a test reads `pg_indexes`)
- [x] Tx1 supersedes as the spec says (a Spec v2 supersedes v1, approved or not, and the waiting Plan; a Plan v2
  supersedes Plan v1 only); a run has at most one current Spec and one current Plan
- [x] A second `insertAction` with the same `(action, source_comment_id)` and a second version with the same
  `(run_id, kind, trigger_comment_id)` are refused by the database, and the two lookups find the first; a write
  without the lease throws spec 5's error
- [x] `waiting()` by status: `spec-review` → the current Spec even when a Plan is posted; `ready-for-dev` → the Plan
  or the go-signal; `needs-human` → by `statusBeforeStop`

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass
  (`test/documents-store.integration.spec.ts`)
- [x] Your part: `npm run db:migrate` on the dev database

**Dependencies:** None
**Files:** `prisma/schema.prisma`, `prisma/migrations/<ts>_documents/migration.sql`, `src/documents/documents.store.ts`,
`test/db.ts`, `test/documents-store.integration.spec.ts`
**Scope:** M

### Task 3: `changedFiles` and `compareUrl`

**Description:** Overview §4's two methods. The GitHub adapter: `GET /repos/{owner}/{repo}/compare/{from}...{to}`;
each file's `filename`, and `previous_filename` for a rename (both sides); `complete` false when GitHub lists 300
files; an unknown commit (404) → a permanent `ProviderError`, anything else as the client's errors. `compareUrl` →
`https://github.com/<repo>/compare/<from>...<to>`. The scanning wrapper passes both through. The in-memory fake:
the paths that differ between the two snapshots `resolveRef` kept (added, removed, changed), an unknown SHA →
permanent; a `failNext` works as for the other methods. The GitHub smoke calls both (P22).

**Acceptance criteria:**
- [x] Adapter: a rename gives both paths; 300 files → `complete: false`; 404 → permanent with GitHub's status; a
  `503` stays transient (spec 3's client rules)
- [x] Fake: seeding a file moves `main` to a new SHA, and `changedFiles(old, new)` lists exactly that path; the same
  SHA twice → `[]`, complete
- [x] `npm run github:smoke` prints the compare check as PASS against the fake (unit); against the sandbox at
  Checkpoint 1

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass
- [x] Manual: `npm run github:smoke` on the sandbox at Checkpoint 1 (stop `npm run dev` first)

**Dependencies:** None
**Files:** `src/contracts/repo-provider.ts`, `src/github/github-repo.provider.ts` (+ spec),
`src/secret-scan/scanning-repo.provider.ts` (+ spec), `test/fakes/in-memory-repo-provider.ts` (+ spec),
`src/github/smoke/run-smoke.ts` (+ spec)
**Scope:** M

### Task 4: Text output with a maximum (`src/llm`)

**Description:** Spec "Contracts" → `src/llm`. `LlmCall.output` also takes `{ text: { maxChars } }`: an empty answer
is re-asked as today; a longer one is re-asked (spec 4's re-ask, without tools) with "your answer has 71,200
characters; at most 50,000 fit: shorten it". After two re-asks, `invalid-answer` with P2's message (the step's
`model: max-<step>` label name from `src/github/labels.ts`, as `workflow-comments.ts` names lane labels). A refresh's
schema is T18's (P2: its own `max` message).

**Acceptance criteria:**
- [x] 60,000 characters three times → two re-asks, three `execution_logs` rows (attempts 1–3), then `LlmError`
  `invalid-answer` with P2's message; 50,000 exactly passes
- [x] A long answer then a short one → the short one is the output; `'text'` calls behave as before

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass

**Dependencies:** None
**Files:** `src/llm/llm-call.ts`, `src/llm/llm.service.ts` (+ spec)
**Scope:** S

### Task 5: The read tools, pure part

**Description:** Spec "The read tools" (SP2, SPW1–SPW4) with P10 and P19, in `src/llm/context-tools.ts`: the
`list_files` and `read_file` declarations (arguments and limits as the spec's table), offered with spec 11's two
when a call asks for repo files; `LoadRequest.folder`; the request rules for both (spec 11's order: loads left →
count it → the path or folder in the commit's listing, a leading `./` or `/` removed, exact case → SPW1's files and
`.github-agent/` → `not-found` "Not available: `CLAUDE.md`." → already given → too large → fits); the listing answer
(every file under the folder at any depth, sorted, one `path (N bytes)` per line, at most 500 lines then "… and 812
more; list a sub-folder"; SPW1's files and `.github-agent/` left out), whose size counts toward the bytes (SPW3); the
answers of the spec's outcome table. `src/llm/prompt.ts`: the "Loading:" paragraph names all four tools when the read
tools are offered; the "Read:" line lists the files read with `read_file` by path, after spec 11's entries; listings
are never named.

**Acceptance criteria:**
- [x] Every outcome of the spec's table, each with its answer: `loaded`, `not-found` (a file, a folder, `CLAUDE.md` in
  any folder, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursorrules`, `.windsurfrules`, a file under
  `.cursor/`, a file under `.github-agent/`), `already-loaded` (a file, also one given by `load_file`; a folder
  twice), `too-large`, `limit-reached`
- [x] A listing of 812 files → 500 lines and the "and 312 more" line; an empty folder name lists the root
- [x] "Loading:" with the read tools names `load_skill`, `load_file`, `list_files`, `read_file`; without them it is
  spec 11's sentence, byte for byte (`prompt.spec.ts:252`)
- [x] "Read: skill `money-rules` (`SKILL.md`), `src/index.ts`, `src/index.test.ts`": repo files after spec 11's
  entries, whatever the load order; spec 11's cases unchanged (`prompt.spec.ts:430–445`)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass

**Dependencies:** None
**Files:** `src/llm/context-tools.ts` (+ spec), `src/llm/prompt.ts` (+ spec)
**Scope:** M

### Task 6: The read tools in the loader and the call

**Description:** `ContextLoaderService` (P29): `tools(setup, repoFiles)` gives the four tools when `repoFiles` is set
(even when spec 11 has nothing to load), else spec 11's rule; `load()` serves `list_files` from the commit's listing
(spec 11's `RepoCatalogService`, already in memory) and `read_file` with `readText` at the call's commit → `redact()`
(SPW2: one log line per redacted file, never the value) → spec 4's guard (P18) with the call's data tag
(`LoadContext.tag`) → its `context_loads` row (`tool` `list_files` / `read_file`, `kind` `listing` / `repo-file`,
`path` the folder or the file, `injectionKinds` from the file, SPW4: no warning comment). `LlmService.call()` passes
`repoFiles` and the tag. A GitHub error while reading → spec 11's `error` row, then thrown. `contextLoaderOver` and the
loader's own spec build the scanner with test values for the two secrets it reads.

**Acceptance criteria:**
- [x] A text call with `repoFiles`: the model lists `src`, reads `src/index.ts`, answers; two `context_loads` rows
  with the new values; the file reached the model wrapped in the call's tag; the notes' "Read:" line names it
- [x] A file holding a token-shaped test string → the model gets `[REDACTED: …]`, one log line without the value; a
  file with an injection pattern → its kinds on the row and no warning comment posted
- [x] `read_file` and `load_file` share one budget: the limits stop both; a call without `repoFiles` offers no read
  tool (Grill Me unchanged)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T5
**Files:** `src/llm/context-loader.service.ts` (+ spec), `src/llm/context-load.service.ts`, `src/llm/llm.service.ts`
(+ spec), `src/llm/llm-call.ts`, `src/llm/llm.module.ts`, `test/fakes/in-memory-context-loads.ts`
**Scope:** M

### Checkpoint 1 — Foundations
- [x] All tests pass (1,337 unit, 296 integration)
- [x] `npm run db:migrate` ran on the dev database (you, 2026-11-22: `20261122202553_documents` applied)
- [x] `npm run github:smoke` on the sandbox: the compare check passes (2026-11-22, issue #11, run by you: the
  classifier blocked me; every line PASS, `changedFiles main with itself: 86cf3e3 → no paths, complete` and its
  compare URL)
- [ ] You review and commit

---

## Phase 2 — The Spec

### Task 7: The router seam for spec 7, and the `startApp` option

**Description:** Spec "Contracts" → `src/workflow`, the parts every later task needs: `HandlerName` gains `documents`;
`HandlerOp` gains `refresh`, `reply`, `deleted`, `restore`; `StepContext` gains `status`, `statusBeforeStop` and
`approval` (P14; `approval` null until T11); `StepOutcome` gains `IGNORED` (P6) and `SPEC_REFRESHED`, which decide() turns into `ignore(reason)` and
`set-status` `spec-review`; `RouterIgnoreReason` gains the five new reasons; `WorkflowInput` gains the three inputs
(types only, ignored `no-transition` by decide() until their tasks). `test/app.ts`: the `documents` option (P8), with
no stub yet.

**Acceptance criteria:**
- [x] decide(): `IGNORED` → `ignore` with that reason; `SPEC_REFRESHED` → `set-status` `spec-review`; `REFRESH`,
  `RESTORE`, `BOT_COMMENT_DELETED` → ignored `no-transition` (open issue) for now
- [x] A scripted handler returning `IGNORED` ends the event `IGNORED` with its reason (router integration)
  (in `test/run-start.integration.spec.ts`'s dispatch-loop suite, which already boots with scripted handlers)
- [x] Every existing suite passes unchanged

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** None
**Files:** `src/contracts/workflow-input.ts`, `src/workflow/decide.ts` (+ spec), `src/workflow/step-handler.registry.ts`,
`src/workflow/router.service.ts`, `test/app.ts`, `test/router.integration.spec.ts`
**Scope:** M

### Task 8: The Spec frame and turns (pure), and the transcript's status

**Description:** `src/documents/spec-frame.ts`: the spec's frame with `{then}` per lane and `{commit}`; the turn
builder: the issue title and description as untrusted blocks (keys `title`, `description`), the Grill Me line from
P9's status ("skipped (grill: skip)", "no questions were needed", or the questions with their guesses; no line
without a session), then the answers in the order written as untrusted blocks (`comment-<id>`, "the comment by
`<login>`"). `GrillService.transcript()` gains `status` (P9).

**Acceptance criteria:**
- [x] The frame says "a Plan is then written…" for `full-sdd` and "the code is then written…, with no Plan in
  between" for `spec-code`; the commit is the setup's
- [x] The turn for a skipped run says "skipped" and has no answers; a run with questions lists Q1, Q2 with guesses,
  then each answer as its own untrusted block in creation order
- [x] `test/grill-cancel.integration.spec.ts:341–388`: the two `toEqual` gain the status; a run with no session →
  `status: null`

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** None
**Files:** `src/documents/spec-frame.ts` (+ spec), `src/grill/grill.service.ts`, `test/grill-cancel.integration.spec.ts`
**Scope:** S

### Task 9: `DocumentsModule` and writing the Spec

**Description:** Spec "Writing the Spec" and "The document comment". `src/documents/documents.module.ts` (imports
`WorkflowModule`, `LlmModule`, `GrillModule`, `GitHubModule`, `SecretScanModule`; `AppModule` imports it after
`GrillModule`, P3) registers the `spec` handler. `spec.handler.ts` op `generate`: first a `PENDING_POST` version of the
run (find its marker, else post the stored body, then Tx2); a current written Spec already posted → nothing; else
`getTaskDetails`, `prepare('spec', task)`, `transcript(runId)`, one call (T4's text maximum, `repoFiles`), clean
(SPW20), `redact()` (L17), the comment from `document-comments.ts` (`spec:<versionId>` marker, the header with run,
lane and "read at `main` @ `4f2c1ab`", the edit and `/approve` lines per lane, the document between its markers, the
notes), Tx1 → `postComment` → Tx2. One log line per action (spec "Logging"). `startApp`'s default stub for `spec`
(P8).

**Acceptance criteria:**
- [x] Grill Me clear → exactly one Spec v1 comment, `status: spec-review`; the row `written`, `POSTED`, `commit` =
  the base branch's, `log_id` a `spec` row of the run; `grill: skip` at run start → the skipped comment, then Spec v1
- [x] The spec's comment shape for both lanes; a model text with a marker and an `@name` is cleaned; a token-shaped
  string is redacted in the comment and in `text`
- [x] A crash after `postComment` (a fake port that fails after posting) → the retry finds the marker and posts
  nothing more; a retried `PENDING_POST` row posts its stored body; no second model call
- [x] 60,000 characters three times → stop at step `spec`, P2's message; `/retry` with a short answer → one Spec v1
- [x] Spec 5's and 6's suites pass unchanged (P8)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass
  (`test/documents-spec.integration.spec.ts`)

**Dependencies:** T1, T2, T4, T6, T7, T8
**Files:** `src/documents/documents.module.ts`, `src/documents/spec.handler.ts`, `src/documents/document-comments.ts`
(+ spec), `src/documents/documents.store.ts`, `src/app.module.ts`, `test/app.ts`, `test/documents-helpers.ts`,
`test/documents-spec.integration.spec.ts`
**Scope:** L (one slice; split the comment texts out first if it grows)

### Task 10: The sandbox `spec` skill (you commit)

**Description:** SP11, in your sandbox clone on `main`, uncommitted: `.github-agent/skills/spec/SKILL.md` replaces
the placeholder: the header (`name: spec`, a description), the first line naming its source
(`spec-driven-development`, addyosmani/agent-skills 0.6.16, MIT), then lean content: objective, assumptions,
behavior with testable success criteria, boundaries, out of scope, open questions, and a manual verification matrix
(precondition + action + expected result, negative cases, invariants); "read the code you change before you say what
changes" (SP2); `AGENTS.md` for commands and code style; spec 11's line asking to load `money-rules` when an issue
splits, rounds or shows money; a "When updating" section. Dropped as SP11 says. `THIRD-PARTY-NOTICES.md` gains its
section (kept, changed, dropped), as for `grill`. Then one paste-ready block (`( set -e … )`, no `#` lines) that
commits and pushes both.

**Acceptance criteria:**
- [x] The skill passes spec 11's header check (I run it on the file); nothing in it asks to save, name or commit a
  file, or for a second document
- [x] The notice lists what was kept, changed and dropped, with the MIT text already in the file

**Verification:**
- [x] Manual: you read the diff in the clone, run the block; I check the push (`git ls-remote`, the file at the new
  commit) (2026-11-22: sandbox `main` at `abf8f2d`)

**Dependencies:** T8 (the frame the skill sits under); pushed before Checkpoint 2
**Files:** in `/Users/891944/Projects/sdd-agent-sandbox`: `.github-agent/skills/spec/SKILL.md`,
`.github-agent/skills/THIRD-PARTY-NOTICES.md`
**Scope:** S (sandbox only)

### Checkpoint 2 — The Spec on the sandbox
- [x] T10 is on the sandbox's `main` (`abf8f2d`)
- [x] Matrix "The Spec": `#A` (Spec v1 shape, rows, sections with a verification matrix, cents, no `@`, no marker
  inside), its "Read:" line and `read_file` row, `#B` and `#C`, `#D` (`CLAUDE.md` never loaded; the canary checked
  with spec 11's `scripts/skill-discovery-invariants.mjs` here, spec 7's script at T26)
  (2026-11-22, sandbox `abf8f2d`, my instance: `#A` = #48, two Grill rounds then Spec v1, 10,511 characters, nine
  sections with a 13-row matrix in cents, `read_file` rows for `src/index.ts`, `src/index.test.ts`, `package.json`,
  `tsconfig.json`, `README.md`; `#B` = #49, "no questions needed" then Spec v1; `#C` = #50, the skipped comment then
  Spec v1, its prompt "Grill Me: skipped (grill: skip)" with no answers; `#D` = #51, the model never asked for
  `CLAUDE.md` or `.github-agent/`, no root listing shows either; spec 11's invariant 1 PASS. Its invariant 2 FAILs
  on the four Spec comments only: it matches a "Read:" line to Grill evaluations, which spec 7's comments aren't)
- [x] Matrix "Failures": `model: max-spec` before the Spec; the token-shaped string; the `spec` skill loads
  `money-rules` (#49: model line `(max)`, its four `spec` rows `max`, Grill's `standard`; #51: the key is in
  neither the comment nor `text`, the Spec says it keeps credentials out; #48, #50: `load_skill money-rules` in the
  Spec call)
- [ ] You review and commit

---

## Phase 3 — `/approve`, the Plan, the go-signal

### Task 11: The gate, the verdict and the refusals

**Description:** Spec "`/approve`" (R2, D10). `src/documents/approval-check.ts`: the pure `approvalVerdict` (the
spec's "Code style" function) and the gate (P7, P26): `verdict()` reads the waiting document (P15), whether this event
already approved a document of the run (`approve_event_id`) and one `getComment` (not for the go-signal).
`RouterState.approval` replaces `approveValid`; the router asks the gate only for `APPROVE` in `spec-review` or
`ready-for-dev` with a run. decide(): `valid` → rows 17–19; `done` → `steps` with no calls (P27); the four refusals
→ `documents` `reply`. `documents.handler.ts` op `reply` for an `APPROVE`: the verdict's reply (spec table, marker
`approve-refused:<commentId>`, a `document_actions` row with result, the reply pattern), a `deleted` verdict also
records the deletion without text when the bot hadn't seen it, then `IGNORED` `approve-refused` (P6). `startApp`'s
stub for `documents`.

**Acceptance criteria:**
- [x] decide() per verdict (one test each); the changed `decide.spec.ts` rows listed above pass
- [x] `/approve` written before Spec v1 was posted → ONE "written before Spec v1" reply, nothing approved, `IGNORED`
  `approve-refused`; the job run again → no second reply
- [x] The Spec comment emptied between its markers → the `empty` reply; deleted (the bot missed it) → the `deleted`
  reply and `deleted_at` set, `deleted_text` empty; already approved (rows set directly, P23) → the `already-approved`
  reply
- [x] Each verdict is one `getComment` (no other GitHub read)
- [x] Each refusal has its `document_actions` row (`approve-refused`, its result, the reply `POSTED`) and the spec's
  log line (`documents: /approve refused (before-document)`); the job run again after a crash between Tx1 and the
  post → the reply posted once (P34)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass
  (`test/documents-approve.integration.spec.ts`)

**Dependencies:** T9
**Files:** `src/documents/approval-check.ts` (+ spec), `src/documents/documents.handler.ts`,
`src/documents/document-comments.ts`, `src/documents/documents.store.ts`, `src/workflow/decide.ts` (+ spec),
`src/workflow/router.service.ts`, `src/workflow/step-handler.registry.ts` (+ spec), `test/app.ts`,
`test/fakes/in-memory-issue-provider.ts` (`editComment`, P23), `test/documents-approve.integration.spec.ts`
**Scope:** L

### Task 12: Approving the Spec (the snapshot, the commit check, the counts)

**Description:** Spec "Approving". `spec.handler.ts` op `approve`: this event's approval already recorded → nothing;
else `getComment` again (P16), `documentText`, `redact()` (SPW21); the commit check: `resolveRef` of the base branch,
from `checked_commit` (or `commit`) to it; the same commit → no compare; else `changedFiles`, and `staleFiles` = the
changed paths the document's calls loaded (P4's chain, P20's read method), and every changed path in
`changed_paths` (P33); GitHub's "unknown commit" (404, 422) → not compared (SPW22), any other error passes through
(P32); `lineCounts` (posted text → approved text); one transaction stores all of it. `src/documents/commit-check.ts`
(pure): the flagged files and the warning line's pieces (5 at most, "and N more", "… and possibly more", the
not-compared line).

**Acceptance criteria:**
- [x] An edited Spec approved: `approved_text` is the edited document without header or notes; `lines_added`,
  `lines_removed` ≥ 1; an unchanged one → 0 and 0
- [x] `main` unchanged → no `changedFiles` call, `changed_files` null; a file the Spec read changed → in
  `stale_files` and `changed_paths`; a changed file it didn't read → only in `changed_paths`; an unknown commit →
  `changed_complete` null, the approval counts; a `403` → the run stops (row 28)
- [x] A Plan's flagged files include the approved Spec's reads, each with who read it (P4); a restored or refreshed
  version's chain reaches its first writer (the chain: `chainReads` unit tests and `readsOf`'s walk; a Plan end to end at T14)
- [x] The spec's log line (`spec: v1 approved by bob (2 files flagged, +3 −1 lines)`)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T3, T6, T11
**Files:** `src/documents/spec.handler.ts`, `src/documents/commit-check.ts` (+ spec), `src/documents/documents.store.ts`,
`src/llm/context-load.service.ts`, `src/llm/llm.module.ts`, `test/documents-approve.integration.spec.ts`
**Scope:** M

### Task 13: The Plan

**Description:** Spec "Writing the Plan" (SP1). `src/documents/plan-frame.ts`: the frame with its "only when files
changed" paragraph (both commits, the changed paths with the Spec's read ones marked `*`); the turn: the issue title
and the approved Spec as one untrusted block (key `spec-<versionId>`). `plan.handler.ts` op `generate`: recovery as
the Spec's; a Plan based on this approved Spec exists → nothing; else `prepare('plan', task)`, one call, the Plan
comment (marker `plan:<versionId>`, "from the approved Spec v1", the ⚠️ line from the Spec's approval when files were
flagged or the comparison failed, the edit and `/approve` lines). The `plan` handler is registered; its `startApp`
stub (P8).

**Acceptance criteria:**
- [x] `full-sdd`: Grill Me clear → Spec v1 → edit (remove a requirement) → `/approve` → ONE Plan v1, `status:
  ready-for-dev`; the Plan's prompt holds the approved text and the title, never the description or the answers
- [x] Flagged files at the Spec's approval → the ⚠️ header line with the compare link; none → no line; more than 5 →
  "and N more"; the comparison failed → the not-compared line
- [x] Any changed path at the Spec's approval (P33, flagged or not) → the prompt's paragraph lists them, the Spec's
  read ones marked `*`; none → no paragraph
- [x] The Plan call fails → stop at `plan`; `/retry` → ONE Plan, the approval recorded once, no second Spec call
- [x] A crash after the Plan's Tx2 but before the status is written → the retried `/approve` (in `spec-review`, P15)
  ends in `ready-for-dev` with ONE Plan and no model call (review, 2026-11-22)
- [x] An injection in the approved Spec → spec 4's warning once (key `spec-<versionId>`)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass
  (`test/documents-plan.integration.spec.ts`)

**Dependencies:** T12
**Files:** `src/documents/plan-frame.ts` (+ spec), `src/documents/plan.handler.ts`, `src/documents/document-comments.ts`,
`src/documents/documents.module.ts`, `test/app.ts`, `test/documents-plan.integration.spec.ts`
**Scope:** M

### Task 14: The last approval: the warning reply and the `workspace` stop

**Description:** Spec "The warning reply" (SPW13). `plan.handler.ts` op `approve` (as the Spec's). For the last
document before code (`spec-code`'s Spec, `full-sdd`'s Plan) with flagged files or a failed comparison: the
`approve-warning` row (`stale` or `not-compared`, marker `approve-warning:<versionId>`) is written in the approval's
transaction and posted right after, then the router's `workspace` call stops the run (`step-not-built`). A pending
warning reply is posted by the same op when the event runs again.

**Acceptance criteria:**
- [x] P4's case (only the approved Spec read the changed file) → ONE reply naming "which the approved Spec read"
- [x] Plan v1 approved with a flagged file → ONE "Approved Plan v1. Since it was written …" reply with the compare
  link, then the stop at `workspace`; no flagged file → no reply, only the stop
- [x] `spec-code`: the Spec's approval with a flagged file → the reply names `workflow: spec-code`; NO Plan, ever
- [x] A crash between the approval and the reply → the retry posts it once; `/retry` of the `workspace` stop → the
  approval isn't recorded twice, no second reply, the same stop

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T13
**Files:** `src/documents/plan.handler.ts`, `src/documents/spec.handler.ts`, `src/documents/commit-check.ts`,
`src/documents/document-comments.ts`, `test/documents-plan.integration.spec.ts`
**Scope:** M

### Task 15: The go-signal (`code-only`)

**Description:** Spec "The go-signal" (SPW6). `go-signal.handler.ts` op `post`: the "**Ready to code**" comment
(marker `go-signal:<runId>`) as a `go-signal` row (version 1, no commit, empty `text`, the two transactions); op
`approve`: the issue's title and description as `approved_text` (P37), no comment read (a deleted go-signal still
counts). Registered,
with its `startApp` stub; `run-start`'s suite passes its scripted one through `startApp` (P8).

**Acceptance criteria:**
- [x] A `code-only` run → ONE "Ready to code" comment, `ready-for-dev`; `/approve` → the stop at `workspace`; the
  row's `approved_text` is the title and description as they read then
- [x] The go-signal comment deleted, then `/approve` → still approved
- [x] `test/run-start.integration.spec.ts:180–215` passes with the scripted go-signal

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T11
**Files:** `src/documents/go-signal.handler.ts`, `src/documents/document-comments.ts`, `src/documents/documents.module.ts`,
`test/app.ts`, `test/run-start.integration.spec.ts`, `test/documents-plan.integration.spec.ts`
**Scope:** S

### Task 16: The hint, the late comment, `/approve` where nothing waits

**Description:** The near-miss check (`isApproveNearMiss` in `src/intake/approve-command.ts`: trimmed, lower case,
starts with `/approve`, isn't exactly it). decide(): `COMMENT` in `spec-review` / `ready-for-dev` → `documents`
`reply`; `APPROVE` in `draft` with a run, `executing`, `in-review`, `needs-human` → `documents` `reply` (row 36); with
no run → `reply-without-run` (P36), the gate's reply (P7, row 5). The `reply` op for a `COMMENT`: a near miss → the
hint once per waiting document (`approve-hint:<versionId>`, P38), `IGNORED` `approve-hint`; SP12's four conditions → the late-comment reply
(`late-comment:<commentId>`), `IGNORED` `late-comment`; anything else → `IGNORED` `no-transition`. For an `APPROVE`:
the row-36 texts by status (P14).

**Acceptance criteria:**
- [x] `/approve please` twice → ONE hint; in another document's wait → a new hint
- [x] Late comment: the last answer, then a comment written before Spec v1 was posted → after Spec v1 ONE reply
  naming its author; a comment after → none; a comment Grill Me read → none
- [x] `/approve` with no run → ONE reply, a `document_actions` row with no run; in `needs-human` → "Run 2 is
  stopped"; in `executing` and `in-review` (status set in the test database) → their texts; on a closed issue →
  spec 5's reply, unchanged
- [x] `spec-code`, two `/approve` a second apart → the stop, then ONE "Run 1 is stopped" reply; `full-sdd`, the same
  on the Spec → ONE Plan, then ONE "written before Plan v1" reply
- [x] Every reply has its `document_actions` row (`approve-hint`, `late-comment`, `approve-refused` with the status as
  result) and the spec's log line; each job run again after a crash before the post → one reply (P34)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass
  (`test/documents-replies.integration.spec.ts`)

**Dependencies:** T11
**Files:** `src/intake/approve-command.ts` (+ spec), `src/documents/documents.handler.ts`,
`src/documents/approval-check.ts`, `src/documents/document-comments.ts` (+ spec), `src/workflow/decide.ts` (+ spec),
`src/workflow/router.service.ts`, `test/documents-replies.integration.spec.ts`
**Scope:** M

### Task 17: The sandbox `plan` skill (you commit)

**Description:** SP11, as T10: `.github-agent/skills/plan/SKILL.md` from `planning-and-task-breakdown` (0.6.16,
MIT): tasks in dependency order, vertical slices, each with acceptance, verify and the files it touches (real paths,
read with the tools first), checkpoints, risks; a "When updating" section; dropped as SP11 says. Its notice section.
One paste-ready block.

**Acceptance criteria:**
- [x] The skill passes the header check; nothing in it asks to save a file, enter plan mode or stop a turn
- [x] The notice lists what was kept, changed and dropped

**Verification:**
- [x] Manual: you read the diff, run the block; I check the push (2026-11-23: sandbox `main` at `c8f58d7`)

**Dependencies:** T13 (the Plan frame); pushed before Checkpoint 3
**Files:** in the sandbox clone: `.github-agent/skills/plan/SKILL.md`, `.github-agent/skills/THIRD-PARTY-NOTICES.md`
**Scope:** S (sandbox only)

### Checkpoint 3 — `/approve` and the Plan on the sandbox
- [x] T17 is on the sandbox's `main` (`c8f58d7`)
- [x] Matrix "The Spec": the late comment; `/approve` while the Spec is being written (2026-11-23, sandbox
  `c8f58d7`, my instance: #53 with `grill: skip`, "Q3: actually weekly" and `/approve` written while the Spec call
  ran → after Spec v1 ONE late-comment reply naming `Hugoer` and ONE "written before Spec v1" reply, nothing
  approved; "looks good" after it → no reply)
- [x] Matrix "`/approve` and the Plan": every row except `#F` (Checkpoint 4: its `/refresh` must come before its
  `/approve`, which stops the run) (#48: `/approve please` twice → ONE hint; Spec v1 edited (the outer-spaces
  requirement removed, one matrix row added) → `/approve` → Plan v1, `ready-for-dev`, `approved_text` the edited
  document, `+2 −3`; the Plan names `src/split.ts`, `src/index.ts` and their tests, no task keeps names verbatim (one
  risk row still mentions not trimming); its `/approve` → the `workspace` stop, then `/approve` → ONE "Run 1 is
  stopped". #50: two `/approve` 2 s apart → ONE Plan v1, ONE "written before Plan v1". #54 `spec-code` → "starts
  coding" line, `/approve` → the `workspace` stop, no Plan. #52: its label webhooks were lost (my instance wasn't up
  yet), so its `/approve` got ONE "this issue has no run" reply, a row with no run)
- [x] Matrix "Failures": the injection added to the Spec comment (#49: spec 4's warning once, key
  `spec-<versionId>`; the Plan neither follows nor mentions it)
- [ ] You review and commit

---

## Phase 4 — The commit check and `/refresh`

### Task 18: The refresh texts (pure)

**Description:** Spec "Refresh frame", its output schema (`refresh-output.ts`, with the `superRefine`), the v2 comment
(header "replaces v1 above · read at `main` @ `9e1d0c2` (v1: `4f2c1ab`, [compare](…))", "Refreshed for `bob`'s
`/refresh`. What changed:", the Plan-no-longer-counts line, the document, P1's diff block in `<details>`, dropped above
65,000 with its line), the restored and Plan v2 header variants, and every refresh reply (nothing changed, still up to
date, both up to date, already written at that commit, already approved, deleted → `/restore`, P5's empty, P32's
frame line), and the "Replies where nothing waits" texts for `/refresh` and `/restore` in every status of the spec's
table (`draft` with no run and starting, `grilling`, `executing`, `in-review`, `needs-human`, `code-only`).
P39 (2026-11-23): every reply to a command links that comment as its subject ("[Your `/refresh`](…) …"); the
spec's `/refresh` and `/restore` reply examples are reworded the same way in this task. P40: their no-run replies
name the `workflow:` labels on the issue. P41: the refresh frame's changed paths leave out what the read tools
hide (`isHiddenPath`).

**Acceptance criteria:**
- [ ] The schema: `upToDate` with changes or a document → refused; changed with a blank document or no change line →
  refused; 11 changes → refused; a 60,000-character `document` → refused with P2's schema message
- [ ] Every text matches the spec's examples; a 64,000-character v2 drops its diff with the line; no text has an `@`
  outside backticks

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test` pass

**Dependencies:** T1
**Files:** `src/documents/refresh-frame.ts`, `src/documents/refresh-output.ts`, `src/documents/document-comments.ts`
(+ specs)
**Scope:** M

### Task 19: `/refresh` while the Spec waits

**Description:** Intake: `/refresh` (the whole comment, trimmed, any case) → `REFRESH`, needing a Participant
(`refresh-command.ts`); `answerComments` no longer reads it. decide(): row 32 (`spec-review` → `spec` `refresh`;
`ready-for-dev` `full-sdd` → `spec` `refresh` then `plan` `refresh`, built in T20), row 35 for `REFRESH` → `documents`
`reply` (`refresh-refused`), no run → the gate, closed → RL19's reply (`ClosedCommand` `refresh`). `spec.handler.ts`
op `refresh` in `spec-review` (spec steps 1–6): the waiting Spec's comment now (deleted → SPW23's reply; approved →
the already-approved reply; empty → P5); `prepare('spec')` → B; B equals the starting commit → the nothing-changed
reply, no model call; `changedFiles` (P32 when it fails); the refresh call (four tools at B); up to date →
`checked_commit` = B and the reply with the notes; changed → v(N+1) `refreshed` with its changes, the waiting one
superseded. The `document_actions` `refresh` row (P28) with its result and `log_ids`; the op replays it first (P34);
the event ends as P35 says. A model or GitHub error → the stop at `spec` (SPW7).

**Acceptance criteria:**
- [ ] `main` unchanged → ONE nothing-changed reply, NO new `execution_logs` row
- [ ] A file the Spec read changed → ONE Spec v2 comment (What changed, the diff, both commits, the link); v1
  superseded; an `/approve` written between v1 and v2 → the "written before Spec v2" reply
- [ ] Up to date → the reply, `checked_commit` = B; a second `/refresh` at the same B → nothing changed (SPW11)
- [ ] `/refresh` while grilling, in `code-only`'s `ready-for-dev`, in `needs-human`, in `executing`, in `in-review`,
  in `draft` with a starting run (statuses set in the test database), with no run → one reply each, each text the
  spec's; a closed issue → spec 5's reply; a sender with no access → `unauthorized`, no reply
- [ ] Every outcome has its row (`nothing-changed`, `up-to-date`, `spec-changed`, `deleted`, `already-approved`,
  `empty`; `log_ids` holds the call) and the spec's log line (`/refresh → spec v2`, `→ up to date`, `→ nothing changed`)
- [ ] The refresh call fails → stop at `spec`; `/retry` → ONE v2; the job run again after v2's Tx2 → no second
  comment and no model call (P34); a too-long `document` three times → the stop with P2's schema message

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass
  (`test/documents-refresh.integration.spec.ts`)

**Dependencies:** T12, T15 (a `code-only` run), T16, T18
**Files:** `src/intake/refresh-command.ts` (+ spec), `src/intake/github-payload.ts` (+ spec),
`src/intake/intake.service.spec.ts`, `src/workflow/decide.ts` (+ spec), `src/workflow/workflow-comments.ts` (+ spec),
`src/documents/spec.handler.ts`, `src/documents/documents.handler.ts`, `src/documents/documents.store.ts`,
`test/documents-refresh.integration.spec.ts`, `test/closed-issue.integration.spec.ts`
**Scope:** L

### Task 20: `/refresh` while the Plan waits

**Description:** Spec "In `ready-for-dev`, `full-sdd`". `spec` `refresh` first checks the waiting Plan: deleted
(SPW23's `/restore` reply), empty (P5) or approved → the reply and `IGNORED` `refresh-refused` (P35), which stops the
list before any model call (review, 2026-11-22). Then it starts from the approved Spec's text (SPW17): nothing changed or up to date → recorded on the row, returns nothing; changed → Spec v(K+1) supersedes the
approved v(K) and the waiting Plan (SPW8, the line in its comment) and returns `SPEC_REFRESHED` → `spec-review`.
`plan.handler.ts` op `refresh`: from the Plan's comment now (deleted → the `/restore` reply; empty → P5), knowing the
Spec step's result from the row: B equals the Plan's starting commit → no call, one reply for both; up to date →
"both still up to date"; changed → Plan v(M+1) with "The approved Spec v1 is still up to date." Exactly one comment or
reply answers the `/refresh`.

**Acceptance criteria:**
- [ ] A change that makes the approved Spec wrong → ONE Spec v2 ("Plan v1 … no longer counts"), `spec-review`;
  `/approve` → Plan v2 (`written`, version 2)
- [ ] A change only the Plan's files see → ONE Plan v2 or ONE "both still up to date" reply; status stays
  `ready-for-dev`
- [ ] The Plan's refresh call fails → stop at `plan`; `/retry` → the Spec step makes no second call (P28), ONE answer
- [ ] The Plan comment deleted (or emptied), then `/refresh` → ONE reply, NO model call, no Spec v2
- [ ] Spec v2 posted, then the status write fails → the retried event in `spec-review` returns `SPEC_REFRESHED` from
  the row (P34): no "nothing changed" reply, no second comment
- [ ] The row's result is the last step's (`plan-changed`, `up-to-date`), with both calls in `log_ids`

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T19
**Files:** `src/documents/spec.handler.ts`, `src/documents/plan.handler.ts`, `src/documents/documents.store.ts`,
`test/documents-refresh.integration.spec.ts`
**Scope:** M

### Checkpoint 4 — The commit check and `/refresh` on the sandbox
- [ ] Your sandbox commits for the rows ("Your part", item 5), each pushed before its row and written against the
  files that issue's Spec or Plan actually read (its "Read:" line), since the sandbox's `src/index.ts` holds only
  `LIBRARY_NAME`
- [ ] Matrix "The commit check and `/refresh`": every row but the no-access one (T26)
- [ ] Matrix "`/approve` and the Plan": `#F` in full (Ready to code, `/refresh`'s reply, then `/approve`)
- [ ] You review and commit

---

## Phase 5 — Deleted documents, `/restore`, the run's end

### Task 21: Deleted documents

**Description:** Intake: a deletion on a pull request stays `pr-comment` (checked first, as for `created`);
`issue_comment.deleted` of a comment whose author (`comment.user.login`) is the bot →
`BOT_COMMENT_DELETED` (a Participant; the sender is who deleted it; the body is the comment's last text); no
`comment.user` (spec 2's signed requests) or any other author → `comment-deleted`. decide(): row 33 (`spec-review`,
`ready-for-dev`, `needs-human`, with a run) → `documents` `deleted`; elsewhere `no-transition`; closed → P21.
`documents` op `deleted`: the waiting document (P15), not approved, its comment → `deleted_at`, `deleted_by`,
`deleted_text` (between the markers, `redact()`ed) and one explanation (`doc-deleted:<commentId>`, the stopped-run
sentence in `needs-human`); anything else → `IGNORED` `no-transition`.

**Acceptance criteria:**
- [ ] Edit Spec v1, delete it → ONE explanation naming who deleted it; `deleted_text` has the edit
- [ ] Deleting the explanation, a human comment, an older version, the approved Spec while the Plan waits, the
  go-signal → nothing posted
- [ ] `/approve` after the deletion → the `deleted` reply; `/refresh` → SPW23's reply; deleted while stopped → the
  explanation with the stopped sentence
- [ ] The `deleted` `document_actions` row and the log line (`documents: spec v1 deleted by bob`); the job run again →
  one explanation (P34); a deleted bot comment on a pull request → `pr-comment`

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass
  (`test/documents-restore.integration.spec.ts`)

**Dependencies:** T11, T19
**Files:** `src/intake/github-payload.ts` (+ spec), `test/fixtures/github/payloads.ts`, `src/workflow/decide.ts`
(+ spec), `src/documents/documents.handler.ts`, `src/documents/document-comments.ts`, `src/documents/documents.store.ts`,
`test/documents-restore.integration.spec.ts`
**Scope:** M

### Task 22: `/restore`

**Description:** Intake: `/restore` → `RESTORE` (a Participant, `restore-command.ts`); `answerComments` no longer
reads it. decide(): row 34 (`spec-review`, `ready-for-dev` `full-sdd`) → `documents` `restore`; row 35 for `RESTORE` →
`reply` (`restore-refused`); no run → the gate; closed → RL19's reply (`ClosedCommand` `restore`). The `restore` op
(spec table): deleted, seen → a new row with the same version (`restored`, `based_on_id`, the trigger comment) from
`deleted_text`; deleted, missed (`getComment` → null) → the deletion recorded, the bot's own `text` and the
lost-edits line; still there → the reply with its link; approved → the already-approved reply. No model call; P12,
P24. Its replies link the `/restore` comment as their subject (P39).

**Acceptance criteria:**
- [ ] `/restore` → ONE "**Spec v1** (restored for `alice`'s `/restore`)" comment with the edited line; `/approve`
  after it → counts (the Plan follows)
- [ ] `/restore` again → ONE reply with the link; the restored comment deleted again → a new explanation; a missed
  deletion → the bot's last version and the lost-edits line
- [ ] `/restore` while grilling, in `code-only`, in `needs-human`, `executing`, `in-review`, `draft` with a starting
  run, with no run → one reply each, the spec's texts; a closed issue → spec 5's reply
- [ ] Each result has its `restore` row (`restored`, `restored-last-version`, `nothing-deleted`, `approved`) and the
  log line (`/restore → spec v1 restored (as deleted)`); a retried `/restore` after its Tx2 → no "still on the issue"
  reply, no second comment (P34)

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T15, T21
**Files:** `src/intake/restore-command.ts` (+ spec), `src/intake/github-payload.ts`, `src/workflow/decide.ts` (+ spec),
`src/workflow/workflow-comments.ts` (+ spec), `src/documents/documents.handler.ts`, `src/documents/document-comments.ts`,
`test/documents-restore.integration.spec.ts`, `test/closed-issue.integration.spec.ts`
**Scope:** M

### Task 23: The run-ended line (SPW10)

**Description:** `documents.handler.ts` `onCancel`: the ended run's current Spec and Plan (not superseded, not
deleted, approved or not) → one line linking them (the spec's text; "A new run doesn't use them" for a cancel, "Run 2
doesn't use them" for a replacement; the singular for one document); none, or only a go-signal → null. Built from
the rows only, with no write, so a second call gives the same line. After spec 6's block (P3).

**Acceptance criteria:**
- [ ] Spec v1 waiting, the lane removed → the run-ended comment has the line; switch to `spec-code` with a Plan
  waiting → both linked, run 2 named; during Grill Me → no line
- [ ] The hook called twice → the same line; the documents' comments unchanged

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass
  (`test/documents-run-end.integration.spec.ts`)

**Dependencies:** T13
**Files:** `src/documents/documents.handler.ts`, `src/documents/document-comments.ts` (+ spec),
`test/documents-run-end.integration.spec.ts`
**Scope:** S

### Checkpoint 5 — Deletions, `/restore` and the run's end on the sandbox
- [ ] Matrix "Deleted documents and `/restore`": every row (the missed deletion: I stop my instance, delete with `gh`,
  start it again)
- [ ] Matrix "When the run ends": every row
- [ ] You review and commit

---

## Phase 6 — The invariant script, docs, the verification matrix

### Task 24: `scripts/spec-plan-approvals-invariants.mjs` and its failing test

**Description:** The spec's eight invariants, as spec 11's script: read-only `SELECT`s on the dev database and `gh
api` GETs with your login, the issues as arguments, scoped to rows stored since spec 7 went live (the first
`task_documents` row); PASS / FAIL per invariant, exit 1 on any FAIL. P11: the checks are pure functions exported
from the script, with `scripts/spec-plan-approvals-invariants.spec.mjs`.

**Acceptance criteria:**
- [ ] Each invariant has a fixture that breaks it → FAIL with the issue and row named; the clean fixture passes
- [ ] The script never writes (no `INSERT`, `UPDATE`, `DELETE`, no `gh` method but GET)

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test` pass (Vitest's `include` gains `scripts/**/*.spec.mjs`)

**Dependencies:** T22
**Files:** `scripts/spec-plan-approvals-invariants.mjs`, `scripts/spec-plan-approvals-invariants.spec.mjs`,
`vitest.config.ts`
**Scope:** M

### Task 25: Setup guide, `AGENTS.md`, `README.md`, the sandbox README

**Description:** Spec "Setup & configuration": the guide's section 3 (the real `spec` and `plan` skills, their notice,
the bad-model test branch), a new "When the bot writes a Spec and a Plan" (editing a document, `/approve`, the
warning line and the warning reply, `/refresh`, `/restore`, the replies), "Usage data" (the two tables, example
queries for the spec's "Usage data" questions), "Troubleshooting" (a too-long document, the `workspace` stop until
spec 8), the invariant script. `AGENTS.md` "State" (spec 7 built; next: spec 8); the README. In the sandbox clone, the
README's "Spec / Plan" line → how editing, `/approve`, `/refresh` and `/restore` work (one paste-ready block). The
spec's and this plan's status lines.

**Acceptance criteria:**
- [ ] Every item of the spec's "Setup & configuration" is in the guide; every query in it runs as written on the dev
  database
- [ ] `AGENTS.md` "State" says spec 7 is built and what the bot now does after Grill Me

**Verification:**
- [ ] Manual: you read the diff (both repos)

**Dependencies:** T24
**Files:** `docs/guides/setup-github-agent-local.md`, `AGENTS.md`, `README.md`, the spec, this plan; in the sandbox
clone: `README.md`
**Scope:** S

### Task 26: Run the verification matrix and the success criteria

**Description:** Every row of the spec's matrix not ticked at Checkpoints 2–5 (the bad-model branch, the no-access
`/refresh`), then the invariant script over every issue of the run (once with a wrong issue list that must FAIL),
then the success criteria. Rows the real model may never produce (a too-long answer) stay with their integration test,
as the spec says.

**Acceptance criteria:**
- [ ] Every matrix row ticked in the spec, or written down with why it can't pass and the test that covers it
- [ ] Every invariant passes, scoped to rows stored since spec 7 went live; the wrong-list run fails
- [ ] The success criteria hold; the spec and this plan say "built and verified <date>"

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T25
**Files:** the spec (ticks, status), this plan (status)
**Scope:** M

### Checkpoint 6 — Complete
- [ ] Every acceptance criterion above is met
- [x] You review and commit (`972453c`, 2026-11-23)
- [x] After it (P39): every reply links the comment it answers (2026-11-23, my instance, #55 like #53: "Q3:
  actually weekly" and `/approve` during the Spec call → after Spec v1, "`Hugoer`, [your comment](…)" and "[Your
  `/approve`](…) was written before Spec v1 …", each link to its own comment; `/approve please` → "[Your
  comment](…) isn't an approval …")
- [x] P40 and P41 (2026-11-23): P40's reply on the sandbox (#56 opened while my instance was starting, then
  `/approve` → "[Your `/approve`](…) has nothing to approve: `workflow: full-sdd` is on, but the bot has no run for it
  …"); but the label events weren't lost, only late (delivered 6 s after the `/approve`), so the run started and
  wrote a Spec on #56 after I had closed it → the text now says "yet" and to wait first; #52 and #56 closed. P41 by
  tests only (it needs a `.github-agent/` commit between a Spec and its approval)
- [x] #55 (2026-11-23, your instance): `/approve` → Plan v1 95 s later; the wait looked like nothing happened (an
  earlier `/approve` was sent while no instance ran, then deleted) → P42 (a 👀 on `/approve`) moved to a new spec 13
  `bot-feedback` (overview D33), built after 12

---

## Noticed while planning (not changed)

- The sandbox's `src/index.ts` holds only `LIBRARY_NAME`; the matrix's `split()` example doesn't exist yet. The
  refresh rows change whichever file the Spec read (likely `src/index.ts`).
- `already-approved` is hard to reach before spec 8 (the workspace is never busy, and a re-queued event is processed
  before a newer `/approve`): T11 sets the rows directly; the matrix has no row for it.
- `executing` and `in-review` are never reached before specs 8 and 9: their replies are tested with the status set in
  the test database; the matrix has no row for them.
- GitHub's compare API lists at most 300 files, so `complete` is false at exactly 300 (it can't tell 300 from more).
- `/retry` of the `workspace` stop runs the `/approve` again and stops again at `workspace` until spec 8: expected.
- GitHub's timestamps have one-second resolution: an `/approve` in the same second as its document counts (the
  verdict's `<`).
- Spec 6's `cleanModelText` would drop a document's backticks in one rare case (P31).
- (Checkpoint 2, 2026-11-22) Spec 11's `scripts/skill-discovery-invariants.mjs` invariant 2 ("every Read: line lists
  exactly the call's loaded tool rows") only knows Grill evaluations, so it FAILs on every Spec comment; spec 7's own
  script (T24) doesn't check "Read:" lines. Not changed; to decide with T24.
- (Checkpoint 2) A root listing logs as `list_files  → loaded` (an empty folder name): cosmetic.
- (Checkpoint 3, 2026-11-23) #50's Spec was read at `abf8f2d`; the `plan` skill commit changed two `.github-agent/`
  files before its approval, so `changed_paths` holds them and the Plan's prompt paragraph lists their names (never
  their text). P10 leaves `.github-agent/` out of the read tools only. Decided 2026-11-23: P41.
- (2026-11-23, #56) An issue closed while a step's model call runs: the step still posts its answer (#56's Spec
  v1 came 2 minutes after the close), as spec 5 has it (a close is no event; `open` is read when an event is
  processed). One model call spent on a closed issue; not changed.
- (P39, 2026-11-23) Earlier specs' replies don't link the comment they answer either: spec 5's `/retry` refusals
  ("This `/retry` was written before run 1 stopped …") and closed-issue reply, spec 6's `/approve` and answer
  replies. P39 covers spec 7's replies only; the others keep their texts.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| A task changes a type, a constructor or a table, and a test that builds it sits in a later task | High | The grep above lists each one in the task that changes it; every task runs every suite |
| The payload fixture's old `createdAt` makes every `/approve` "before the document" | High | P23: spec 7's helpers send `createdAt` = now |
| GitHub's web editor saves `\r\n`, so every line counts as changed | Med | P17, with a unit test |
| The real model writes Specs too long for a comment | Med | The frame and the lean skill ask for less; the re-asks; `model: max-spec` (P2) |
| The model doesn't read a repo file in a matrix row | Med | The `spec` and `plan` skills ask to read before writing; rows say what must hold whatever the model writes |
| A refresh rewrites everything | Low | The diff shows it; a human decides with `/approve` (SP5) |
| `gemini-4-carbon` answers `503`, or the Mac sleeps | Med | One plain request to tell the provider from the code; the `pmset` log; lid open |
| The tunnel is down at a checkpoint | Low | `pgrep -fl ngrok` before the first sandbox event; restart it and say so |
| The sandbox commits for the refresh rows change the library | Low | One revert block at the end, your call |

## Open questions

None blocks the plan. P1–P11 and P33 were confirmed on 2026-11-22.

## Review

A general-purpose subagent with no context from this session read the spec, this plan, the overview's sections, and
the code and tests the plan changes (2026-11-22). Verdict: "ready after fixes". I checked every finding against the
code; all held (`setStatus` writes the database before the label, `router.service.ts:553–564`; `SecretScanner` reads
both secrets, `secret-scanner.ts:25–29`; `isIssueEvent` is at `decide.ts:199`). One became a decision with a real
choice (P33, to ask); the others needed none:

| # | Finding | Kind | Applied |
|---|---|---|---|
| 1 | P15 picked "the latest document" whatever the status: a crash after the Plan's Tx2 and before the status write would end a retried `/approve` `done` in `spec-review` with a Plan posted; `needs-human` needs `statusBeforeStop`, which `StepRun` lacks | bug | P15 by status, P14 (`statusBeforeStop`), T2's `waiting()`, T13's crash AC |
| 2 | Only P28 guarded a retry; a retried refresh, restore or reply could post a second answer, and a duplicate `insertAction` would fail the job | bug | P34; T2's two lookups; crash-retry ACs in T11, T16, T19–T22 |
| 3 | T16 turns row 20's `COMMENT` into a reply, but `decide.spec.ts:431–437` expected `ignored`, listed only under T11 | bug | Grep list, under T16 |
| 4 | The Plan prompt lists every changed path, but the table stored only the flagged ones and a count | gap | P33 (to ask), T12, T13's two ACs |
| 5 | P2's refresh case had no mechanism (a refresh answers in a schema) | gap | P2 narrowed: Zod's `max` with its own message; T18, T19 ACs |
| 6 | In `ready-for-dev`, the Spec step ran before anyone checked that the Plan was deleted or emptied (SPW23) | gap | T20 (the check first, P35) and its AC |
| 7 | `#F`'s `/refresh` after its `/approve` would get "Run 1 is stopped" | gap | `#F` in full at Checkpoint 4 |
| 8 | Few ACs checked the `document_actions` rows and the spec's log lines | gap | T11, T12, T16, T19–T22 |
| 9 | Row 35's texts for `draft` with a run, `executing`, `in-review`, and `full-sdd`'s two quick `/approve`, had no AC | gap | T18, T19, T22, T16 |
| 10 | Silent choices: how in-row answers end, the no-run action, the go-signal's `text`, one hint per document | gap | P35–P38 |
| 11 | P31, P14 and P20 change spec lines they didn't list | nit | Their "Spec lines" cells |
| 12 | T12's chain AC could be read as including the Spec's reads | nit | Reworded |
| 13 | `contextLoaderOver`'s `ConfigService` lacks the two secrets the scanner reads | nit | Grep list, T6 |
| 14 | Any permanent compare error counted as "not compared"; a PR comment's deletion; a wrong line number; T19 and T22 need a `code-only` run (T15) | nit | P32, T12, T21, the grep list, T19 and T22 dependencies |
| 15 | `#D`'s invariant at Checkpoint 2 comes before T24's script; `src/index.ts` has no function to rename | nit | Checkpoint 2 uses spec 11's script; Checkpoint 4's commits follow the files the Spec read |

It checked and found fine: the module imports and exports (`SecretScanner` only through `SecretScanModule`,
`GrillService`, `WorkflowModule`'s exports, `ContextLoadService` exported in T12 before use); the dispatch loop (an
outcome stops the list, an empty list ends `DONE`); P3's cancel-hook order (Nest initializes imported modules first,
`cancelBlocks` keeps registration order); every grep item where the plan says; P8's stubs (no older suite sends a spec
7 command where the stubs would turn an ignore into a stop); the APIs assumed (`getComment`, `reads.listing`, the
fake's snapshot per SHA); the bad-model row stops at `spec`; every matrix row has a checkpoint; the overview's D28–D31
and rows 32–36 are already applied.
