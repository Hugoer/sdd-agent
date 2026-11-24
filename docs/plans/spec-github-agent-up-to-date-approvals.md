# Implementation Plan — Spec #14: Up-to-date Approvals

> **Created:** 2026-11-23 · **Status:** approved 2026-11-23, not built; fresh-context review 2026-11-23, its fixes
> applied (see "Review"); UP1, UP2 and UP20 confirmed one at a time the same day, all as recommended
>
> **Why this file exists:** turns the approved spec `docs/specs/spec-github-agent-up-to-date-approvals.md` (spec 14,
> `up-to-date-approvals`, approved and committed 2026-11-23 in `896a772`) into ordered, verifiable tasks (skill
> `agent-skills:planning-and-task-breakdown`). The spec stays normative: this plan adds order, slicing and build-time
> decisions only. The task checklist lives here (repo placement rules override the skill's `tasks/todo.md`). It is the
> one plan for everything the spec changes, including the code that spec 7 (`spec-plan-approvals`) built in
> `src/documents` and the small parts of spec 5 (`router-session-lease`, `src/workflow/decide.ts`) and spec 1
> (`walking-skeleton`, `src/config/env.schema.ts`) it touches. Spec 7's text keeps describing the code as built until
> then; its dated notes already point here.
>
> **Also read:** spec 7 "`/approve`", "Approving", "The document comment", "Refresh frame", its plan P4, P16, P32–P34,
> P39, P41; overview §3 R2 and rows 17–20 (already updated for spec 14 on 2026-11-23).
>
> **Build effort:** high (overview §1, row 14; spec UAW1).

## Overview

Today (spec 7) an `/approve` always counts: when `main` changed files the document read, the bot approves anyway and
only tells people afterwards (a ⚠️ line in the Plan's header, a warning reply after the last approval). Spec 14 moves
the check before the next step. When files the document read changed on `main` since its **starting point** (where
it was written, last found up to date by `/refresh`, or last asked about), the `/approve` doesn't count yet: the bot
posts one **question** (a reply naming the files, a compare link, and two ways on: `/refresh`, or `/approve` again).
GitHub not able to compare, and more changed files than `APPROVAL_LARGE_CHANGE_FILES` (15 by default), ask too. An
`/approve` written before the question was posted doesn't count either (`before-question`). `/refresh` learns one
sentence for a changed step skill. The ⚠️ line and the warning reply go. Plain code, no model call.

Built in 11 tasks (T0–T10), 4 checkpoints:

0. **Before any code:** this plan's decisions in the spec (T0).
1. **Foundations and the Plan header** (T1–T3): the migration and the store, the setting, the Plan without its ⚠️
   line. Nothing new on GitHub except the Plan header's missing line.
2. **The question** (T4–T6): its texts and decision (pure), `/approve` asks first, the time rule.
3. **`/refresh` and a changed method** (T7).
4. **The invariant script, the docs, the last matrix rows** (T8–T10).

You review and commit at each checkpoint (I never commit). Every code task ends with `npm run typecheck && npm run
lint && npm test && npm run test:integration` green.

## Build-time decisions (not in the spec; to confirm with this plan)

Each told as what happens on GitHub. UP1 changes something you can see and had a real choice (Question 1 of 1). UP2
(a column you didn't list) and UP20 (from the review) change nothing on GitHub but had a real choice (Write-time
decisions 1 and 2 of 2). All three confirmed 2026-11-23 as recommended. UP3–UP19 and UP21 follow from a rule named in
their row.

| # | On GitHub | My guess (and the alternative) | Spec lines it changes |
|---|---|---|---|
| UP1 | 12:00 `bob`'s `/approve` on Spec v1 gets a question (`src/index.ts` changed). 12:10 `carol` deletes the Spec comment by mistake; 12:15 `/restore` posts Spec v1 again (spec 7: a new row, at the original's commit, with no `checked_commit`). 12:20 `bob` comments `/approve`. | **Confirmed 2026-11-23. The restored version starts fresh, as spec 7's restore does today:** it compares from where Spec v1 was written, so `bob` gets the same question again (`src/index.ts`) and one more `/approve` counts. No new code. *Alternative:* the restore carries the question over (`asked_commit` and the link "since [the bot asked](…)"), so 12:20 counts at once; the lookups of "the version's last question" then follow `basedOnId` back through restores, and so does the invariant "an approved stale version has an `approve-asked` row for its version" (the row stays on the deleted version). | "Edge cases" (one line: a question, then the document deleted and restored) |
| UP2 | No difference. | **Confirmed 2026-11-23. `document_actions.reply_comment_url`** (text, nullable), recorded with `reply_comment_id` and `reply_posted_at` when a reply is posted (spec 7 stores `task_documents.comment_url` the same way; spec 7 plan P12's rule: what a later post repeats is stored). Three texts link the bot's last question: the `before-question` reply ("[the bot's question](…)"), a second question ("since [the bot asked](…)") and the `not-compared` text ("the commit of [the bot's question](…)"). *Alternatives:* the bot finds the question again by its marker each time (`findCommentByMarker` already answers the URL: no contract change, but one more GitHub read, a page through the issue's comments, per such reply); `IssueProvider.getComment` also returns the URL (one more read and a provider contract change); or the bot builds `…/issues/<n>#issuecomment-<id>` itself (GitHub's URL format in core code, which `IssueProvider` exists to keep out). | "Owned tables" (`DocumentAction`, one row) |
| UP3 | A Plan gets a `not-compared` or `large-change` question (the spec shows only the Spec's texts). | **The Plan's forms name both readers and both documents, as the spec's `stale` Plan text does** (spec 7 plan P4; `/refresh` while the Plan waits checks the Spec first, then the Plan): "[Your `/approve`](…) didn't count yet: since Plan v1 was written (`9e1d0c2`), 42 files changed on `main` ([compare](…)), none of them one it or the approved Spec read. A change this size may still affect them. Comment `/refresh` to check Spec v1 and Plan v1 against today's `main`, or `/approve` again to approve Plan v1 as it is." and "… the bot couldn't compare `9e1d0c2`, where Plan v1 was written, with `main` (…), so it can't tell whether files it or the approved Spec read changed. Comment `/refresh` to check Spec v1 and Plan v1 against today's `main`, or `/approve` again to approve Plan v1 as it is." | "The question" (two Plan examples); the matrix row `#H` large-change ("none of them one it or the approved Spec read") |
| UP4 | A question names a file of a step skill. | **It names the skill the file belongs to** (spec UAW6): a Spec: "… up to date with `main` and its `spec` skill"; a Plan: "… bring Spec v1 and Plan v1 up to date with `main` and the `plan` skill" (or "the `spec` skill", or "the `spec` and `plan` skills" when both changed). | "The question" (one line) |
| UP5 | No difference. | **Which read files belong to a step skill comes from `context_loads`** (`kind` `step-skill` and its `skill`), which `ContextLoadService.loadedPaths` then returns too, never from `workflow.json` at the approval: the question stays "GitHub's compare and PostgreSQL" (spec "Boundaries"), with no extra GitHub read. The refresh's method sentence (UAW7) uses the step skill's folder from the refresh's own `prepare` (`StepSetup.skill.path`), which it already reads. | — |
| UP6 | No difference. | **The pure parts sit in spec 7's files:** the starting point and the decision (`stale` / `not-compared` / `large-change` / none) in `commit-check.ts`, every text and marker in `document-comments.ts` (spec 7's rule: each text next to its marker). | — |
| UP7 | No difference. | **One new integration suite, `test/up-to-date-approvals.integration.spec.ts`,** for the new flows (spec 7 plan P30: one file per slice); spec 7's suites change only where they assert what spec 14 changes (listed below). | — |
| UP8 | No difference. | **A retried approval does nothing more** (UAW8): the approve ops' "this event's approval already recorded" branch returns at once (`postPendingWarning` goes with the warning reply). | — |
| UP9 | No difference. | **The approval's full range reuses the decision's list** when both start at the same commit (no question before): one compare, as spec 7. After a question: the decision compares from the question's commit (or not at all when `main` didn't move), then one more compare for the full range. | — |
| UP10 | Only for a Plan written after a `/retry` of an approval stored before spec 14 went live. | **The Plan's paragraph reads its range from `approved_from_commit`, or `checked_commit ?? commit` when that is empty** (approvals stored before the migration). Not compared = `changed_complete` empty while that start differs from `approved_commit`. | — |
| UP11 | No difference. | **`planFrame`'s `changes` becomes `PlanChanges \| 'not-compared' \| null`**, and `refreshFrame` gains an optional `method` (`'changed' \| 'may-have-changed'`, absent = no sentence): spec 7's test inputs stay as they are. | — |
| UP12 | No difference. | **No index on `document_actions.document_id`:** a question lookup per `/approve` scans a table of a few hundred rows in the MVP; the dashboard spec can add one (spec 7 plan P38 kept indexes to what its lookups need). | — |
| UP13 | `APPROVAL_LARGE_CHANGE_FILES=14` → the app doesn't start: "- APPROVAL_LARGE_CHANGE_FILES: must be an integer from 15 to 150". | **Spec 6's `integerFromTo(15, 150).default(15)`**, the env schema's helper for integer settings (the spec's contract line says the same with plain Zod). `test/test-env.ts` pins `'15'` so a developer's `.env` can't change what the suites expect (spec 6's and 11's settings do the same). | "Contracts" (`env.schema.ts`, one line) |
| UP14 | No difference (the reason in `npm run db:events` only). | **The approve ops return `APPROVE_ASKED`** (`{ type: 'IGNORED', reason: 'approve-asked' }`, next to `APPROVE_REFUSED` in `document-posts.ts`): spec 7 plan P6's mechanism, so the router stops the step list (no Plan, no `workspace`) and writes no status. | — |
| UP15 | No difference. | **T5 is one task, scope L:** the question replaces the warning reply in one change, and the suites that assert the warning reply or an approval of a stale document (listed below) change in the same task, or they go red (spec 11's plan lesson). The deletions of the warning's code go with it. | — |
| UP16 | No difference. | **You run `npm run db:migrate` on the dev database at Checkpoint 1** (spec 7 plan P25: the migration is created against the test database). Spec 14 goes live there: the invariant script counts rows from that migration's `finished_at`. | — |
| UP17 | No difference. | **Spec 7's invariant script stays as it is** (UAW11): its "one answer per command" check doesn't count `approve-asked` replies; spec 14's invariant 1 checks that a question's `/approve` got no other reply. | — |
| UP18 | No difference. | **`DocumentActionName` drops `approve-warning`** (nothing writes it any more; old rows keep it, and the schema comment says "spec 7, no longer written"). | — |
| UP19 | No difference. | **Log lines** in spec 7's form: `#43 run 1 spec: v1 /approve asked (stale, 1 file read changed since 4f2c1ab)`, `(not-compared)`, `(large-change, 42 files)`; `#43 run 1 documents: /approve refused (before-question)`. | "Logging" (the examples) |
| UP20 | No difference. | **Confirmed 2026-11-23 (review finding 3). Invariants 2 and 3 read only the given issues' rows; 1 and 4 keep reading every row since the migration.** You migrate the dev database at Checkpoint 1 (UP16), but until T5 the code there still approves stale documents and writes `approve-warning` rows, so any use of the dev bot between Checkpoints 1 and 2 would fail invariants 2 ("every stale approval had a question") and 3 ("no `approve-warning` row") at the end. Scoped to `#A`–`#H`, they check exactly the matrix's issues; a wrong issue list still fails invariant 1 (a question whose reply isn't among the given issues' comments). *Alternatives:* every invariant starts at the first `approve-asked` row (when the question code first ran; nothing before it is checked); or you don't use the dev bot between Checkpoints 1 and 2 (fragile: you test on the sandbox during builds). | "Verification matrix" → "Invariants" (the scope line) |
| UP21 | A retried `/approve` that had stored its question finds the run stopped (another event failed meanwhile) or ended. Today's code would answer "Run 1 is stopped" (or "nothing to approve") and never post the question. | **Every `/approve` reply path posts this event's stored question first** (UAW2: "whatever happened to the document since"; review finding 4): `DocumentsHandler.reply` for `APPROVE` (statuses the gate isn't asked in, e.g. `needs-human`) and `DocumentsGate.replyWithoutRun` (no run) look up `approve-asked` for the comment, post it if needed and end `IGNORED` `approve-asked`; the `/approve` gets no second reply. | "Retries and failures" (one row) |

**Fixes to the spec with no choice (applied in T0):**
- Matrix `#H`, the `not-compared` row: the quoted text becomes the spec's own wording ("couldn't compare `0000000`,
  where Spec v1 was written, with `main`"); the row had "the commit Spec v1 read".
- Matrix `#H`, the same row: "the Plan's prompt has no 'files changed' paragraph" becomes "the Plan's prompt has the
  'couldn't list the files changed' paragraph (UAW3), with no list": UAW3 gives the Plan that paragraph exactly when
  the approval couldn't compare.

## Existing tests and code this plan changes (grep, 2026-11-23)

Every behavior, text and construction the plan changes, grepped across `src/**/*.spec.ts`, `test/**` and `scripts/**`
(the warning reply, the Plan's ⚠️ line, `approve-warning`, `approveWarningReply`, the `{ last }` option,
`approvalVerdict(` calls, `new DocumentApprovals(` (none), `toEqual` over `task_documents` or `document_actions` rows
(none: every row assertion is `toMatchObject`, and the index list is unchanged), the env schema tests, `.env.example`).
Each row belongs to the task named; a task isn't done until its rows pass.

**Types, constructions and signatures:**
- `ApprovalRecord.approvedFromCommit` (T1): set at `src/documents/document-approval.ts:116` (spec 7's `from`) and
  `src/documents/go-signal.handler.ts:83` (`null`).
- `DocumentsStore.markReplyPosted(lease, id, commentId)` → `(lease, id, posted)` (T1): `src/documents/document-posts.ts:88`;
  `test/documents-store.integration.spec.ts:279`.
- `envSchema` (T2): `src/config/env.schema.spec.ts:43–57` (`toEqual` of the defaults gains
  `APPROVAL_LARGE_CHANGE_FILES: 15`), `:58–74` (accepted 15 and 150), `:118–145` (rejected 14, 151, `abc`, `2.5`);
  `test/test-env.ts` (pins `'15'`); `.env.example`.
- `planComment({ warning })`, `SpecWarning`, `specWarningLine`, `CommentParts.warningLines` (T3):
  `src/documents/plan.handler.ts:135–142` (`warningOf`), `:303–310`; `src/documents/documents.handler.ts:216–220` (the
  restored Plan); `src/documents/document-comments.spec.ts:278` (the shared input), `:304–354` (three ⚠️ tests:
  removed), `:554`.
- `planFrame({ changes })` (T3): `src/documents/plan.handler.ts:100` (`changesOf`, `:383–393`);
  `src/documents/plan-frame.spec.ts` (inputs unchanged, UP11; one new case).
- `chainReads` returns the step skill of a load (T4): `src/documents/commit-check.spec.ts:12–43` (its `toEqual`
  outputs gain the field); `flaggedFiles` and `FlaggedFile` stay `{ path, readers }` (the spec's `files` shape), so
  `:44–66` is unchanged; `ContextLoadService.loadedPaths` (`src/llm/context-load.service.ts:110`) returns `kind` and
  `skill` (its only caller is `document-approval.ts:186`; no test calls it directly).
- `PlanHandler`'s `REPO_PROVIDER` injection (T3): `src/documents/plan.handler.ts:57`; its only use is `warningOf`'s
  `compareUrl` (`:370`), so it goes with it (review finding 8).
- `DocumentApprovals.approve(context, doc, { last })` → `approve(context, doc)` answering `ApprovalResult` (T5):
  `src/documents/spec.handler.ts:155–160`, `src/documents/plan.handler.ts:165–170`; `postPendingWarning`
  (`document-approval.ts:162`, called at `spec.handler.ts:156`, `plan.handler.ts:166`): removed.
- `DocumentsStore.approve(lease, id, record, warning)` → `approve(lease, id, record)` answering the row (T5): its
  callers `document-approval.ts:116`, `go-signal.handler.ts:83` (ignores the answer).
- `approveWarningReply`, `ApproveWarning`, `approveWarningMarker`, `ApproveWarningInput` (T5): removed from
  `src/documents/document-comments.ts:336–379`; `src/documents/document-comments.spec.ts:5` (import), `:356–434` (the
  describe: removed; its "who read each file" case moves to the question's tests in T4).
- `RouterIgnoreReason` gains `approve-asked` (T5): `src/workflow/decide.ts:118`; `src/workflow/decide.spec.ts:686–697`
  (the `IGNORED` reasons list gains it).
- `ApprovalVerdict` gains `before-question` (T6): `src/workflow/decide.ts:133`; `src/workflow/decide.spec.ts:482–500`
  (the refusal verdicts list gains it); `ApproveRefusal` (`document-comments.ts:298`).
- `approvalVerdict(waiting, approve, comment, thisEvent)` → six parameters (T6, the spec's contract):
  `src/documents/approval-check.ts:120`; `src/documents/approval-check.spec.ts:22, 26, 31, 36, 41, 46, 50, 55, 57,
  62, 63, 68, 69, 73` (every call gains `false, null`).
- `refreshFrame({ …, method })` (T7): `src/documents/document-refresh.ts:105`; `src/documents/refresh-frame.spec.ts`
  (calls unchanged, UP11; new cases).

**Behaviors and texts asserted by spec 7's suites:**
- `test/documents-plan.integration.spec.ts:135–161` "a file the Spec read changed before its approval → the Plan's ⚠️
  line …": T3 → no ⚠️ line, the prompt's paragraph unchanged; T5 → the `/approve` gets a question first, a second
  `/approve` writes the Plan.
- `test/documents-plan.integration.spec.ts:163–185` "the Spec's approval couldn't compare → the not-compared line; no
  paragraph": T3 → no ⚠️ line, the prompt has the "couldn't list" paragraph; T5 → a `not-compared` question first
  (the 404 is mocked for both compares, or the Spec's `commit` is set to an unknown SHA, so the second `/approve`'s
  full range still fails).
- `test/documents-plan.integration.spec.ts:270–433`, the describe "The last approval before code: the warning reply
  and the `workspace` stop" (T5): `:316` → a question naming `src/w-plan.ts`, then `/approve` again → the `workspace`
  stop and no other reply; `:355` (P4) → a question naming "which the approved Spec read"; `:367` → no reply, only
  the stop (its helper's marker becomes `approve-asked:`); `:381` (`spec-code`) → a question, no Plan, ever; `:401` →
  a crash between the question's transaction and its post (UAW9), and `/retry` of the `workspace` stop → no question.
  The describe is renamed for the question.
- `test/documents-plan.integration.spec.ts:113` (`not.toContain('⚠️')`): unchanged, still true.
- `test/documents-approve.integration.spec.ts:276–299` "a file the Spec read changed → in `stale_files` …" (T5): a
  question first; the second `/approve` stores `stale_files`, `changed_paths`, `approved_from_commit`; two compares in
  all (the decision's, the full range's), not one.
- `test/documents-approve.integration.spec.ts:301–324` "GitHub doesn't know the commit (404) → not compared, the
  approval counts (SPW22, P32)" (T5): a `not-compared` question; `/approve` again counts with `changed_complete` null.
  Its 404 is mocked once today (`:304`); the second `/approve`'s full-range compare starts from the Spec's `commit`,
  which the fake knows, so the test mocks the 404 for both compares or sets the Spec's `commit` to an unknown SHA
  (review finding 5).
- `test/documents-approve.integration.spec.ts:326–341` (a 403 → the stop at `spec`): unchanged (the decision's compare
  is the first and passes the 403 through).
- `test/documents-refresh.integration.spec.ts:568–598` (`#144`: `/approve` after `src/f-spec.ts` changed, then
  `/refresh`) (T5): the first `/approve` gets a question; a second `/approve` writes the Plan; the rest unchanged.
- Unchanged, checked: `documents-replies` `:236`, `:256` (two `/approve` a second apart, `main` unmoved);
  `documents-refresh` `:122` (`before-document` wins, spec 7's verdicts first), `:455` (Spec v2 at today's commit);
  `documents-restore` (no `/approve` after a change to a read file); `documents-store` `:126` (the index list);
  `scripts/spec-plan-approvals-invariants.mjs` and its spec (UP17); `scripts/skill-discovery-invariants.mjs` (a question
  has no "Read:" line, like spec 7's other replies).

## Dependency graph

```
T0 decisions in the spec
 └─ T1 migration + DocumentsStore ──┬─ T3 Plan: no ⚠️ line, its prompt's range
    T2 APPROVAL_LARGE_CHANGE_FILES ─┤
                                    └─ T4 question texts + decision (pure)
                                         └─ T5 /approve asks first (stale, not-compared, large-change)
                                              └─ T6 the time rule (before-question), a pending question, this event's own
                                                   └─ T7 /refresh: the method sentence, asked_commit cleared
                                                        └─ T8 invariant script ─ T9 docs ─ T10 matrix
```

T3 needs only T1 (`approved_from_commit`); T5 needs T2–T4. Nothing runs in parallel: every task after T1 touches
`src/documents`.

## Phase 0 — Before any code

### Task 0: This plan's decisions in spec 14 (on approval, before any code)

**Description:** The spec changes first where a decision changes a rule, a text or a table: the "Spec lines" column
for every confirmed decision (UP1–UP4, UP13, UP19–UP21), each dated with its plan number, plus the two matrix fixes
above. The overview needs nothing (its rows were updated with the spec).

**Acceptance criteria:**
- [x] Every confirmed decision with a "Spec lines" entry is in the spec, dated
- [x] The two `#H` matrix fixes are in; every matrix row can be checked as written

**Verification:**
- [ ] Manual: you read the spec's diff (Checkpoint 1)

**Dependencies:** your approval of this plan
**Files:** `docs/specs/spec-github-agent-up-to-date-approvals.md`
**Scope:** XS

---

## Phase 1 — Foundations and the Plan header

### Task 1: The migration and `DocumentsStore`

**Description:** Spec "Owned tables (changes)". Migration `prisma/migrations/<ts>_up_to_date_approvals`:
`task_documents.asked_commit`, `approved_from_commit` (text, nullable); `document_actions.from_commit`, `to_commit`
(text), `files` (jsonb), `changed_files` (int), `files_complete` (bool), `reply_posted_at` (timestamptz),
`reply_comment_url` (text, UP2), all nullable. Schema comments: `action` lists `approve-asked` and "`approve-warning`
(spec 7, no longer written)". `DocumentsStore`:
- `ApprovalRecord.approvedFromCommit`: spec 7's approval stores the commit it compared from (`checked_commit ??
  commit`), the go-signal `null`;
- `markReplyPosted(lease, id, posted)` records the reply's id, URL and GitHub creation time (`DocumentPosts.postReply`
  passes the comment it found or posted), so every reply from now on has `reply_posted_at` (UAW9);
- `ActionRecord` gains the question's optional fields (`fromCommit`, `toCommit`, `files`, `changedFiles`,
  `filesComplete`);
- `ask(lease, documentId, askedCommit, action)`: the version's `asked_commit` and the `approve-asked` row in one
  transaction (UAW9);
- `lastQuestion(documentId)`: the version's newest `approve-asked` row, or null;
- `markUpToDate` and `finishRefresh`'s `checked` also clear `asked_commit` (UAW3: a refresh that moves
  `checked_commit` closes the question).

**Acceptance criteria:**
- [x] The migration applies to the test database; `prisma migrate diff` from the migrations to the schema is empty;
  rows stored before it keep nulls
- [x] `ask` writes both or nothing (without the lease: nothing); a second question for the same comment is refused
  (unique `action`, `source_comment_id`); `lastQuestion` answers the newest of two
- [x] `markUpToDate` and `finishRefresh` with `checked` clear `asked_commit`; `markReplyPosted` records the time and the
  URL
- [x] A Spec approval stores `approved_from_commit` (`commit`, or `checked_commit` after an up-to-date refresh); the
  go-signal's is null

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T0
**Files:** `prisma/schema.prisma`, `prisma/migrations/<ts>_up_to_date_approvals/migration.sql`,
`src/documents/documents.store.ts`, `src/documents/document-posts.ts`, `src/documents/document-approval.ts`,
`src/documents/go-signal.handler.ts`, `test/documents-store.integration.spec.ts`
**Scope:** M

### Task 2: `APPROVAL_LARGE_CHANGE_FILES`

**Description:** Spec "Configuration" (UAW5, UP13). `src/config/env.schema.ts`: `integerFromTo(15, 150).default(15)`
with its comment line; `.env.example` gains `APPROVAL_LARGE_CHANGE_FILES=15` with a one-line comment ("Spec 14: an
`/approve` asks first when more files than this changed on the base branch, none of them read (integer 15–150)");
`test/test-env.ts` pins `'15'`.

**Acceptance criteria:**
- [x] Unset → 15; `15` and `150` accepted; `14`, `151`, `abc`, `2.5` → `validateEnv` names the variable and "must be
  an integer from 15 to 150"

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass (`src/config/env.schema.spec.ts`)

**Dependencies:** T0
**Files:** `src/config/env.schema.ts`, `src/config/env.schema.spec.ts`, `test/test-env.ts`, `.env.example`
**Scope:** XS

### Task 3: The Plan: no ⚠️ line; its prompt's range from the approval

**Description:** Spec UA4, UAW3 (the Plan's prompt), UP10, UP11. `document-comments.ts`: `planComment` loses its
`warning` input, the header's ⚠️ line in both forms (`SpecWarning`, `specWarningLine`, `warningLines`).
`plan.handler.ts`: `warningOf` goes, and with it the `REPO_PROVIDER` injection it alone used; `changesOf` reads the
range from `approved_from_commit` (UP10) and answers `'not-compared'` when the approval couldn't compare. `plan-frame.ts`: that case gets UAW3's paragraph ("The Spec was
written at commit {specCommit}; the bot couldn't list the files changed on the base branch since. Where the Spec's
facts about the code no longer hold, follow the code at {commit}; what to build still comes from the Spec.").

**Acceptance criteria:**
- [x] A Plan written after an approval that flagged files, or couldn't compare, has no ⚠️ line; the rest of its
  header is unchanged (a refreshed or restored Plan: as before)
- [x] The prompt's "files changed" paragraph names `approved_from_commit` as the Spec's commit; an approval that
  couldn't compare → the "couldn't list" paragraph; nothing changed → no paragraph (as before)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass (`plan-frame.spec.ts`,
  `document-comments.spec.ts`, `test/documents-plan.integration.spec.ts:135`, `:163`)

**Dependencies:** T1
**Files:** `src/documents/document-comments.ts` (+ spec), `src/documents/plan.handler.ts`, `src/documents/plan-frame.ts`
(+ spec), `src/documents/documents.handler.ts`, `test/documents-plan.integration.spec.ts`
**Scope:** M

### Checkpoint 1 — Foundations

- [x] All four suites pass; `npm run build` passes
- [x] You run `npm run db:migrate` on the dev database (UP16)
- [x] Matrix `#H`, the config row: my instance (port 3101, the test database) with `APPROVAL_LARGE_CHANGE_FILES=14`,
  then `=151` → it doesn't start, the log names the setting and "must be an integer from 15 to 150"; unset → it
  starts (that the default is 15 shows in `#H`'s 16-file row at Checkpoint 2)
- [ ] You review and commit

---

## Phase 2 — The question

### Task 4: The question's texts and decision (pure)

**Description:** Spec "The question", "Written before the question", UAW4–UAW6, UP3–UP6. `commit-check.ts`:
- `startOf(doc)` → the starting point and how to name it: `asked_commit` (the question), else `checked_commit` (last
  checked), else `commit` (written) (UAW3);
- `questionFor({ changed, reads, threshold })` → `stale` (the read files that changed, with their readers and step
  skills, the list's completeness), `not-compared`, `large-change` (the count, the completeness) or none, in that
  order: read files first, then more than `threshold` paths (UAW5: GitHub's cut list, 300, is always above it);
- `chainReads` carries a load's step skill (UP5; `ContextLoadService.loadedPaths` returns `kind` and `skill`); the
  question's skill wording is derived beside the flagged files (`FlaggedFile` stays `{ path, readers }`, the spec's
  `files` shape).

`document-comments.ts`: `approveAskedMarker(commentId)` (`approve-asked:<commentId>`); `approveAskedReply(input)` with
every form of the spec's section (Spec and Plan, UP3; the three starting points with "since [the bot asked](…)"; the
skill wording, UP4; 5 files and "and N more"; "… and possibly more"; "more than 300 files changed … none of the 300
GitHub lists is one it read"; hidden paths named; no compare link for `not-compared`); `approveRefusedReply`'s
`before-question` text with the question's link. The "which it read" grouping (`readFiles`) is reused.

**Acceptance criteria:**
- [x] Every text in the spec's "The question" and "Written before the question", verbatim as unit tests, plus UP3's
  two Plan texts and UP4's skill forms; no `@` outside backticks in any of them
- [x] `questionFor`: a read file changed → `stale` even with more than `threshold` files; none read and `threshold + 1`
  files → `large-change`, `threshold` → none; a cut list with a read file → `stale` with "possibly more", without →
  `large-change`; not compared → `not-compared`
- [x] `startOf`: `asked_commit` over `checked_commit` over `commit`

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test` pass (`commit-check.spec.ts`, `document-comments.spec.ts`)

**Dependencies:** T1
**Files:** `src/documents/commit-check.ts` (+ spec), `src/documents/document-comments.ts` (+ spec),
`src/llm/context-load.service.ts`
**Scope:** M

### Task 5: `/approve` asks first

**Description:** Spec "The `/approve` on a Spec or a Plan" (UA1–UA3, UA7, UAW2, UAW3, UAW5, UAW8–UAW10), UP8, UP9,
UP14, UP15. `DocumentApprovals.approve(context, doc)` answers the spec's `ApprovalResult`:
1. this `/approve` already asked (`actionFor('approve-asked', commentId)`, a retried event) → its reply posted if it
   isn't yet → `asked`, with no compare and no second read of the comment (UAW9);
2. the comment read again (spec 7 plan P16): gone or empty → spec 7's refusal → `refused`;
3. `resolveRef`; `startOf(doc)`; `main` didn't move since → counts; else `changedSince(start, now)` and
   `questionFor(…, APPROVAL_LARGE_CHANGE_FILES)`;
4. a question → `ask` (the version's `asked_commit` = now; the row with its result, every flagged file with its
   readers, both commits, the count and completeness, the reply), the log line, the reply posted → `asked`;
5. counts → the full range from `checked_commit ?? commit` (UP9; a 404 or 422 there is stored as not compared),
   stored with `approved_from_commit`; the log line → `approved`. No warning reply, ever.

The approve ops (`spec.handler.ts`, `plan.handler.ts`): a retried approval → nothing (UP8); `asked` → `APPROVE_ASKED`;
`refused` → `APPROVE_REFUSED`. `decide.ts`: the ignore reason `approve-asked`. Removed: the `{ last }` option,
`postPendingWarning`, `approveWarningReply` and its types, `DocumentsStore.approve`'s warning parameter (UP18).

**Acceptance criteria** (`test/up-to-date-approvals.integration.spec.ts`, real handlers, the scripted model, the fake
repo scripted per compare):
- [x] Spec v1, a file it read changed, `/approve` → ONE question (the spec's text, the compare link `<A>...<now>`);
  `IGNORED` `approve-asked`; `spec-review` stays; no Plan, no new `execution_logs` row; `asked_commit` = now; the
  `approve-asked` row (`stale`, `files`, both commits, `changed_files`, `files_complete`, `reply_posted_at`); the log
  line. `/approve` again → Plan v1 (no ⚠️ line), NO reply to it; `stale_files` holds the file, `approved_from_commit`
  = the Spec's commit
- [x] `main` moves after a question (another read file) → a second question naming only that file, "since [the bot
  asked](…)", `from_commit` = the first's `to_commit`; then an unrelated change → counts, `stale_files` holds both
  (the full range)
- [x] Only an unrelated change since the Spec → counts at once, no question
- [x] The Plan waits; a file only the approved Spec read changed → ONE question "which the approved Spec read",
  offering "`/refresh` to bring Spec v1 and Plan v1 up to date"; `/approve` again → the `workspace` stop, no other
  reply, no `approve-warning` row
- [x] `spec-code`: a question, then `/approve` again → the `workspace` stop and no other reply; `/retry` of that stop
  after another read file changed → the same stop, NO question; `code-only`: any change, `/approve` on the go-signal
  → the stop, NO question
- [x] An unknown starting commit → ONE `not-compared` question (no compare link); `/approve` again → counts,
  `changed_complete` null when the full range also can't be compared
- [x] 16 changed files, none read → ONE `large-change` question "16 files changed on `main`"; 15 → counts; a cut list
  (300, `complete` false) with none read → "more than 300 files changed"; with a read file → `stale` "… and possibly
  more"
- [x] A crash after the question's transaction (its post fails) → the retried event posts ONE reply and compares
  nothing
- [x] Every row of "Behaviors and texts asserted by spec 7's suites" marked T5 above passes as changed there

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T2, T3, T4
**Files:** `src/documents/document-approval.ts`, `src/documents/spec.handler.ts`, `src/documents/plan.handler.ts`,
`src/documents/document-posts.ts`, `src/documents/documents.store.ts`, `src/documents/document-comments.ts` (+ spec:
deletions), `src/workflow/decide.ts` (+ spec), `test/up-to-date-approvals.integration.spec.ts` (new),
`test/documents-approve.integration.spec.ts`, `test/documents-plan.integration.spec.ts`,
`test/documents-refresh.integration.spec.ts`
**Scope:** L (UP15: one behavior; the test edits are mechanical)

### Task 6: The time rule, a pending question, this event's own question

**Description:** Spec UA5, UAW2, UAW9, "Retries and failures" row 1. `approvalVerdict` gains `thisEventAsked` and
`lastQuestion` (the spec's contract): this event asked → `valid` (its approval posts the stored question, T5's step
1); then spec 7's verdicts; then `before-question` when the `/approve` was written before the version's last question
was posted, while it is open (`asked_commit` set; the same second counts). `DocumentsGate.verdict`: this event's
`approve-asked` row; else the version's last question posted first if it is stored but not posted (UAW9); then the
verdict. `decide.ts`: `ApprovalVerdict` `before-question` (decide() already sends every refusal to the `documents`
reply). The refusal: `document_actions` `approve-refused`, result `before-question`, the reply linking the question
(UP2's URL), the log line. UP21: `DocumentsHandler.reply` (an `/approve` in a status the gate isn't asked in) and
`DocumentsGate.replyWithoutRun` (no run) post this event's stored question first and end `IGNORED` `approve-asked`.

**Acceptance criteria:**
- [x] Unit: the verdict table: written before the question → `before-question`; the same second → `valid`; a closed
  question (`asked_commit` empty) → `valid`; this event's own question → `valid` whatever else holds; spec 7's
  verdicts before `before-question` (a deleted document → `deleted`)
- [x] Two `/approve` written while the lease is held → ONE question and ONE `before-question` reply linking it; no
  Plan; then an `/approve` → Plan v1
- [x] A question stored but not posted (its post failed, the event waits), then another `/approve` → the question is
  posted first, then that `/approve` gets `before-question`; the first event's retry posts nothing more
- [x] A retried asking event after the document was deleted → only its question, no `deleted` reply
- [x] A retried asking event after the run stopped (`needs-human`) or ended → only its question, posted once; no
  "Run 1 is stopped" or "nothing to approve" reply (UP21)

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T5
**Files:** `src/documents/approval-check.ts` (+ spec), `src/workflow/decide.ts` (+ spec),
`src/documents/document-posts.ts`, `src/documents/documents.handler.ts`, `test/up-to-date-approvals.integration.spec.ts`
**Scope:** M

### Checkpoint 2 — The question on the sandbox

- [x] All four suites pass; `npm run build` passes
- [x] Matrix rows on the sandbox (plan "Verification matrix on the sandbox" below): `#A` (2 rows), `#B` (4), `#E`
  (2), `#F` (2), `#G` (1), `#H` (`not-compared`, `large-change`)
- [ ] You review and commit

---

## Phase 3 — `/refresh` and a changed method

### Task 7: `/refresh`: the method sentence; the question closed

**Description:** Spec "`/refresh` and a changed method" (UA1, UAW7), UP11. `refresh-frame.ts`: the optional `method`,
its sentence after "If the method below says how to update a {kind}, follow it." (`changed`: "The method below
changed since the {kind} was written. Where the {kind} no longer follows it, change that too, even when that adds,
renames or removes a section; keep everything else as written."; `may-have-changed`: the same with "may have
changed"). `DocumentRefreshes.check`: `changed` when a listed path is under the refreshed kind's step-skill folder
(`setup.skill.path`, UP5); `may-have-changed` when GitHub couldn't compare, or cut the list with none of the skill's
files in it. The files line is unchanged (it never names those paths). T1's store already clears `asked_commit`;
this task proves it end to end.

**Acceptance criteria:**
- [x] Unit: the sentence present, absent, "may have changed"; only hidden paths changed → "None of the files you can
  read changed since." and the sentence; no `.github-agent/` path in the frame
- [x] A question, then `/refresh` → Spec v2 → `/approve` → Plan v1 at once, NO question
- [x] A question, then `/refresh` finds it up to date → `asked_commit` empty, `checked_commit` = now; an `/approve`
  written before the question and processed after the refresh → counts (the question no longer applies)
- [x] The Plan waits: a question, `/refresh` → "both still up to date", the Plan's `asked_commit` empty → `/approve` →
  the `workspace` stop, NO question
- [x] The Spec's step skill changed → the question names its `SKILL.md` "which it read" with "and its `spec` skill";
  `/refresh` → the frame has the method sentence; while the Plan waits with only the `plan` skill changed → only the
  Plan's refresh gets it

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T6
**Files:** `src/documents/refresh-frame.ts` (+ spec), `src/documents/document-refresh.ts`,
`test/up-to-date-approvals.integration.spec.ts`
**Scope:** S

### Checkpoint 3 — `/refresh` on the sandbox

- [x] All four suites pass; `npm run build` passes
- [x] Matrix rows on the sandbox: `#C` (2 rows), `#D` (2 rows)
- [ ] You review and commit

---

## Phase 4 — The invariant script, the docs, the last rows

### Task 8: `scripts/up-to-date-approvals-invariants.mjs` and its failing test

**Description:** Spec "Commands", UAW11, the matrix's "Invariants". Read-only, as spec 7's script: SELECTs on the dev
database and `gh api` GETs with your own login on `TARGET_REPO`; rows since the `finished_at` of the
`%_up_to_date_approvals` migration in `_prisma_migrations` (invariants 2 and 3: only the given issues' rows, UP20);
comments of the issues given; `APPROVAL_LARGE_CHANGE_FILES` from `.env` (default 15). Its four checks are pure functions, exported; `scripts/up-to-date-approvals-invariants.spec.mjs`
breaks each with a fixture and expects it to fail, and passes a clean one.

**Acceptance criteria:**
- [ ] The four invariants as the spec words them, each with a failing fixture and the clean one passing
- [ ] Usage line and exit 1 on a missing argument or variable; exit 1 when any invariant fails

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test` pass (Vitest already includes `scripts/**/*.spec.mjs`)

**Dependencies:** T7
**Files:** `scripts/up-to-date-approvals-invariants.mjs`, `scripts/up-to-date-approvals-invariants.spec.mjs`
**Scope:** M

### Task 9: The setup guide, `AGENTS.md`, `README.md`

**Description:** Spec "Setup & configuration". The guide's "When `main` changed files a document read" becomes the
question: what it names, `/refresh` or `/approve` again, `before-question`, the method sentence, the large-change
setting; "Usage data" gains the new columns and an example query (questions by result, and what followed); the
invariant script's command. `AGENTS.md` (State): spec 14 built; next: spec 12 (`bot-data-protection`) and spec 13
(`bot-feedback`) interviews, then 8. `README.md`: one phrase on the question where it describes `/approve`.

**Acceptance criteria:**
- [ ] No text in the guide, `AGENTS.md` or the README still says the bot "never blocks" or posts a warning reply or a
  ⚠️ line
- [ ] The example query runs on the dev database

**Verification:**
- [ ] Manual: you read the diff

**Dependencies:** T8
**Files:** `docs/guides/setup-github-agent-local.md`, `AGENTS.md`, `README.md`
**Scope:** S

### Task 10: The invariants, the undo, the success criteria

**Description:** The matrix's "Invariants" on `#A`–`#H` (and once with a wrong issue list, which must fail); the
sandbox's test commits undone in one commit back to `cf0e08c`'s files (`bulk/` and `notes/` removed,
`.github-agent/skills/spec/SKILL.md`, `src/index.ts` and `src/index.test.ts` as they were); every row ticked in the
spec; the spec's and this plan's status lines "built and verified <date>".

**Acceptance criteria:**
- [ ] The four invariants pass on `#A`–`#H`; a wrong issue list fails
- [ ] The sandbox's `main` has `cf0e08c`'s files (checked with `git ls-remote` and the files at the new commit)
- [ ] Every matrix row ticked or written down with why (a row the real model doesn't follow after 2–3 tries, with
  the integration test that covers it)

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass

**Dependencies:** T9
**Files:** `docs/specs/spec-github-agent-up-to-date-approvals.md`, this plan
**Scope:** S

### Checkpoint 4 — Complete

- [ ] Every success criterion of the spec holds
- [ ] You review and commit

---

## Verification matrix on the sandbox

Sandbox `main` is at `cf0e08c` (2026-11-23); the last issue is `#70`, so `#A`–`#H` will be new issues from `#71` on.
Each issue asks for a small feature in `split-the-bill` whose Spec reads `src/index.ts` and `src/index.test.ts` (both
hold only `LIBRARY_NAME`), so one commit to either file reaches every waiting Spec. Every row is written against the
files that issue's document actually read (its "Read:" line), as at spec 7's Checkpoint 4.

| Checkpoint | Rows | Issues | Sandbox commits to `main` (made with `gh` as you, one per step, when you say so) |
|---|---|---|---|
| 1 | `#H` config | none (my instance on 3101, test DB) | none |
| 2 | `#A` ×2, `#B` ×4, `#E` ×2, `#F` ×2, `#G` ×1, `#H` `not-compared` and `large-change` | `#A`, `#B`, `#E`, `#H` `full-sdd`; `#F` `spec-code`; `#G` `code-only` | a new `notes/spec-14.md` (unrelated); a comment line in `src/index.ts`; one in `src/index.test.ts`; a change to a file only `#B`'s Spec read (picked from the two "Read:" lines); 16 small files under `bulk/` in one commit (Git Data API); `#H`'s `commit` set to `0`×40 with SQL; `#E`'s lease held with SQL |
| 3 | `#C` ×2, `#D` ×2 | `#C`, `#D` `full-sdd`, opened at Checkpoint 3 | in `src/index.ts`, rename `LIBRARY_NAME` (makes `#C`'s Spec wrong, its issue names it); a comment line in a file `#C`'s Plan read; `.github-agent/skills/spec/SKILL.md` asks for a "## Risks" section |
| 4 | Invariants ×4 | `#A`–`#H` | one commit back to `cf0e08c`'s files |

Order at Checkpoint 2, so one commit serves several issues and no row sees a commit meant for another (review
finding 1). Open the six issues and wait until every Spec (and `#G`'s go-signal) is posted. Then:
1. `notes/spec-14.md` (new) → `#A` `/approve`: Plan v1 at once, no question.
2. A comment line in `src/index.ts`, then every row that needs exactly that change: `#B` `/approve` (the first
   question); `#E` with the lease held, two `/approve` (question and `before-question`), then `/approve` (Plan v1);
   `#F` `/approve` (question), `/approve` again (the `workspace` stop, no other reply); `#G` `/approve` (the stop, no
   question); `#A`'s Plan `/approve` (a question naming it, if it is on the Plan's "Read:" line; else one more commit
   to a file that is, first), `/approve` again (the stop).
3. A comment line in `src/index.test.ts` → `#B` `/approve` (the second question, naming only it); `#F`'s `/retry` of
   its stop (the same stop, no question).
4. An edit to `notes/spec-14.md` → `#B` `/approve` counts: Plan v1, no ⚠️ line, both files in `stale_files`.
5. A change to a file only `#B`'s approved Spec read (picked from the two "Read:" lines) → `#B`'s Plan `/approve`
   (the question "which the approved Spec read").
6. `#H` last: the SQL, `/approve` (`not-compared`), `/approve` again (Plan v1); then the 16 files under `bulk/` →
   `/approve` (`large-change`), `/approve` again (the stop). Last, because 16 new files would make every other waiting
   document's next `/approve` a `large-change` question.

Order at Checkpoint 3 (review finding 2): open `#C` only; the `LIBRARY_NAME` rename → `#C`'s question, `/refresh`
(Spec v2), `/approve` (Plan v1); the comment line in a file `#C`'s Plan read → question, `/refresh` ("both still up
to date"), `/approve` (the stop). Then open `#D` (its Spec is written after both commits, so its question names
`SKILL.md` only), push the `SKILL.md` change, and run `#D`'s rows. The `SKILL.md` change comes after `#C`, or `#C`'s
refresh would get the method sentence and might add a "Risks" section.

**Your part** (as in spec 7's build): at Checkpoint 1, `npm run db:migrate` (UP16). At Checkpoints 2 and 3, stop `npm
run dev` (the tunnel stays) so my instance runs on port 3000 with the dev database; I check the tunnel is up first,
log to `node_modules/.cache/sdd-agent-logs/` (a fresh file per start), and say when you can restart `npm run dev`.
Per checkpoint I ask once whether I do the sandbox steps (issues, labels, comments, commits) with `gh` as you.

## Noticed while planning (not changed)

- **A `/refresh` while a question isn't posted yet** (its post failed and the worker waits): the refresh answers
  first, and the question appears after it when the first event is retried. UAW9 has only the next `/approve` post a
  pending question; rare (a GitHub failure plus a quick `/refresh`), so left as the spec says.
- **The fake repo's commit is a hash of its files:** a revert gives back the earlier SHA (GitHub makes a new commit).
  The compare is empty either way, so no test depends on it.
- **The large-change count counts both sides of a rename** (spec UAW5), so it can be one more than GitHub's compare
  page shows.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| T5 changes the approval and four suites at once | Med | It comes after the pure pieces (T4) and the Plan header (T3); its test list above is exhaustive, from the grep |
| The real model's Spec doesn't read the file a row needs (`#B`'s "only the Spec read") | Low | Pick the file from the actual "Read:" lines; after 2–3 tries, write the row down with the integration test that covers it |
| A busy sandbox day: other commits move `main` during a row | Low | Only I push to the sandbox during the matrix; rows check `from_commit` / `to_commit` |
| A real `/approve` asks more often than expected (every call reads the root `AGENTS.md` and `package.json`) | Med | Expected by UA7; the usage data shows it; files that never ask are a later setting (spec "Out of scope") |

## Open questions

None. UP1, UP2 and UP20 were asked one at a time on 2026-11-23 and confirmed as recommended. The plan was approved
the same day; T0 writes its decisions into the spec before any code.

## Review

A general-purpose subagent with no context from this session read the spec, this plan, and the code and tests the
plan changes (2026-11-23). Verdict: "ready after fixes". I checked every finding against the code; all held. One
became a decision with a real choice (UP20, to ask); the others needed none:

| # | Finding | Kind | Applied |
|---|---|---|---|
| 1 | Checkpoint 2's order put `#F`'s second `/approve` and `#A`'s Plan rows after the `src/index.test.ts` commit (another read file: a second question instead of the stop); `#E`'s third `/approve` had no place | bug | The six-step order under "Verification matrix on the sandbox" |
| 2 | Checkpoint 3: `#D`'s Spec written before the rename would name `src/index.ts` too; the `SKILL.md` commit before `#C`'s refresh would give it the method sentence | gap | The Checkpoint 3 order |
| 3 | The dev database is migrated at Checkpoint 1, but until T5 its code still writes stale approvals and `approve-warning` rows: any dev-bot use in between fails invariants 2 and 3 | gap | UP20 (to ask), T8 |
| 4 | A retried asking event that finds the run stopped or ended never reaches the gate: its question is never posted and the `/approve` gets a second reply | gap | UP21 (rule: UAW2), T6 and its AC; one "Noticed" line removed |
| 5 | The reworked `documents-approve:301` test mocks the 404 once; the second `/approve`'s full range would compare fine | bug | The grep list's line for `:301` |
| 6 | Where the step skill travels was unsaid; on `FlaggedFile` it would break `commit-check.spec.ts:44–66` | nit | T4 (derived beside the flagged files) and the grep list |
| 7 | `loadedPaths` named in T4 and T5 | nit | T4 only |
| 8 | `PlanHandler`'s `REPO_PROVIDER` is unused once `warningOf` goes | nit | T3 and the grep list |
| 9 | UP2 missed an alternative: `findCommentByMarker` already answers the URL | mismatch | UP2's alternatives |
| 10 | UP1's alternative would also need the invariant to follow `basedOnId` | nit | UP1's alternative |
| 11 | UP19's log form differs from the spec's "Logging" examples but wasn't sent to T0 | nit | UP19's "Spec lines", T0 |

It checked and found fine: the gate has the lease and `DocumentPosts` to post a pending question; an `IGNORED`
outcome from the first call stops the step list and the status write (`router.service.ts:315–326`); `before-question`
needs only the type in decide() (`decide.ts:441–446`); "already approved" and "already asked" can't both hold for one
`/approve`; the fakes support every named test (a list cut at 300, an unknown SHA's 404, a failed post retried with
`drainDueNow`, a later event processed while a failed one waits); the grep list is complete, each item in the task
that changes it; every integration test that sends `/approve` after a change to a read file is handled; UP17 holds;
UP5 and T7 have the data they need; UP13 matches `integerFromTo`'s message; the two `#H` fixes are right; every
Testing-strategy item and "Retries and failures" row has an acceptance criterion, and every matrix row a checkpoint.
