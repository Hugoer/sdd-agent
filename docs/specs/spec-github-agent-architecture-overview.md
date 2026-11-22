# Spec #0 — GitHub AI Agent: Architecture Overview

> **Created:** 2026-11-09 · **Status:** approved 2026-11-09 · amended 2026-11-11 (spec 2: D19–D21, approved with
> that spec on 2026-11-11) · amended 2026-11-12 (spec 4 interview: D22, D23; spec 4's
> contract changes in §1, §4 and §6, approved with that spec on 2026-11-12) · amended 2026-11-16 (spec 5
> interview: D24–D26, D1 and D7 annotated, §3 R1/R4/R5 and rows 3, 8, 28, 30, 31, §4 and §6; then its
> follow-up interview: D6 and D26 annotated, rows 6, 7, 28 and the note under row 31; approved with that spec on
> 2026-11-16) · amended 2026-11-16 (spec 5's plan, approved that day: §1 row 5, §3 row 1 and the note under
> row 31, §6 `Run`) · amended 2026-11-17 with spec 6's draft (interview GM1–GM12: D8 annotated; §1 row 6; §3
> lanes, step outcomes, rows 9, 12, 14–16 and the diagram; §4; §5; §6; edge case 6; the verification rows marked
> 6), approved with that spec on 2026-11-17 · amended 2026-11-17 with spec 6's plan (P1: §3 row 16; P2: §6
> `GrillEvaluation`) · amended 2026-11-18 (D27, decided by the user during spec 6's build: a new spec 11
> `skill-discovery`; §1 rows 7, 9–11 and the build order, §4, edge cases 7, 9–11, verification rows 7, 9–11) ·
> amended 2026-11-20 with spec 11's draft (interview 2026-11-19: SD1–SD9; review answers 2026-11-20: SD10–SD13;
> D27 annotated; §1 row 11; §4 the step types and the step-skill contract; §5; §6; edge cases 7–11; the
> verification rows marked 11), approved with that spec on 2026-11-20 · amended 2026-11-22 with spec 7's draft
> (interview 2026-11-21: SP1–SP13; review fixes 2026-11-21; write-time interview 2026-11-22: SPW1, SPW10, SPW13:
> D28–D31, D27 annotated; §1 row 7; §3 inputs, step outcomes, R2, rows 5, 18–20, 27, 32–36 and the diagram; §4;
> §6; edge case 7; the verification rows marked 7), approved with that spec on 2026-11-22
>
> **Why this file exists:** the system is too large for one spec (idea doc §12). This overview is the spine every
> capability spec (#1–#11) loads. It fixes the module boundaries, the status/lane state machine, the shared
> contracts, the config schema and table ownership, so each capability spec can be written in its own session
> with focused context.
>
> **Sources:** `docs/idea/github-ai-agent-master-technical-spec.md` (parts moved here are marked "→ moved to …"
> there) and the interview of 2026-11-09 (decisions D1–D17).
>
> **Normative:** the §3 transition table, §4 contracts, §5 config, §6 table ownership and §7 rules. A change to
> any of them updates this file first, then the affected specs.

## Objective

An MVP GitHub App backend (NestJS on the developer's machine, reached through ngrok) that moves issues of **one
sandbox target repo** through Grill Me → Spec → Plan → Coder → Quality Gate, driven by labels and `/approve`
comments, without acting under the developer's identity or touching their checkout.

- **Actors:** the developer (runs the app, reviews and merges PRs), Participants of the target repo (label
  issues, answer questions), Approvers (the same, plus `/approve`) and the bot (the GitHub App). Levels: D19
  (2026-11-11; was "`write` users").
- **Done when** every capability spec can be written and implemented in build order without contradicting
  another one (see Success criteria).

## Scope

- **In:** capability map and NestJS modules (§1), repositories (§2), state machine (§3), shared contracts (§4),
  config schema (§5), table ownership (§6), cross-cutting rules (§7) and the verification matrix.
- **Out:** how each capability works inside (columns, prompts, algorithms, retry counts, comment texts) →
  specs #1–#11. Post-MVP ideas → idea doc §11 "Future".
- **Setup & configuration:** §2 and §5 here; the living guide `docs/guides/setup-github-agent-local.md` starts
  with spec 1.

## Decisions (interview 2026-11-09, all confirmed)

- **D1 `Task` holds the workflow state.** One row per issue: status (source of truth; the `status: *` label is
  its projection), lane, current run and session lease. Replaces `GrillSession.lockedUntil`. **2026-11-16
  (spec 5, D24):** the run itself is a `Run` row; `Task` points to its current run.
- **D2 Leases renew by heartbeat** while a job runs. `SESSION_LEASE_SECONDS` (was `GRILL_LEASE_SECONDS`) is the
  expiry after a crash, not a time limit. PR events use the lease of their task; there is no separate PR lease.
- **D3 Routing is plain NestJS:** a pure `decide(state, input) → action`, a dispatcher and step handlers
  registered by the step modules. Step outcomes go back through `decide()`, so steps never call each other.
  LangGraph runs only inside the Coder and Quality Gate agent loops.
- **D4 Thin intake:** the controller validates HMAC, stores the event (deduplicated by delivery ID) and replies
  `202`, with no outbound calls. The worker checks the sender. Every event that doesn't reach the router is
  recorded in the events table with a reason. `ExecutionLog` is for LLM runs only. **2026-11-11 (spec 2):** a
  redelivery of a `FAILED` event queues it again; any other redelivery still changes nothing.
- **D5 Lane labels act per event:** removing the run's lane label cancels the run (`draft`); adding a lane label
  starts a run, cancelling the active one first (restart); a lane swap works in either order; with two lane
  labels nothing starts or is cancelled; events received before the current run started are ignored.
- **D6 A restart starts from scratch.** A cancelled run's Grill answers are never reused. If it had answered
  rounds, one cancel comment lists them in a copyable block and says how to carry them over: edit the issue
  description before re-adding the label, paste them into the first answer of the new session, or edit the Spec
  comment before `/approve`. **2026-11-16 (spec 5, RL18):** every cancel and restart now posts one run-ended
  comment ("Run 2 (`full-sdd`) was cancelled …" / "… was replaced by run 3 …"); the answered rounds go into that
  same comment, so a cancel still posts exactly one.
- **D7 `needs-human` exits only through the label restart,** whatever the cause. Every entry posts exactly one
  comment with the cause and the next step. `/retry` → Future. **2026-11-12 (spec 4, L15):** spec 5's interview
  reconsiders `/retry` for causes outside the issue, now that a model call can fail for billing, key,
  model-name or outage reasons. **2026-11-16 (spec 5, D25):** a `needs-human` entered on a failure also exits
  through `/retry`; a stop that is a result of the work (round limit, red, interrupted) still exits only
  through the restart.
- **D8 A Grill round asks 1..K questions,** chosen by the LLM; only questions whose answers don't affect each
  other go together. K = `GRILL_MAX_QUESTIONS_PER_ROUND` (default 3). Output `{ confidence, questions[], gaps }`;
  `GrillRound` = one row per bot comment. **2026-11-17 (spec 6, GM1, GM3, GM5, GM6):** a question goes in only if
  the bot would ask it whatever the answers to the others are, most important first; a model that sends more than
  K gets the first K posted; K may be 1–10. Each question carries the bot's guess; questions are numbered Q1, Q2, …
  across a run's rounds. Output `{ confidence, questions: { question, guess }[], open, gaps }` (`open`: earlier
  questions still unanswered and still needed). Rejected: one question per comment above a confidence level.
- **D9 Step skills are read through the GitHub API** at the base branch (`RepoProvider.readFile`, spec 3);
  spec 4 loads, validates and assembles them. Replaces "read from git". `WORKSPACE_BASE_BRANCH` becomes
  `TARGET_BASE_BRANCH`. **2026-11-10 (spec 3, G7):** a skill is its whole directory (references, scripts), so
  `RepoProvider.listFiles` lists it; spec 4 decides how the files are used.
- **D10 `/approve` counts once,** and only if posted after the document (or go-signal) it approves. Ignored
  during `grilling`. **2026-11-17 (spec 6 GM8):** still nothing is approved during `grilling`, but the `/approve`
  gets one reply (nothing to approve yet, the open questions, how to stop them).
- **D11 Busy workspace:** the approval is recorded, the event waits (`WAITING_WORKSPACE`), one "queued" comment
  is posted, and the retry goes through the lease and the router again.
- **D12 Interrupted Coder job** (crash): `in-review` if its PR was already opened, otherwise `needs-human` +
  comment. The worktree is left as is.
- **D13 Exactly-once side effects:** the two-transaction + hidden-marker pattern applies to every bot comment and
  PR, not only to Grill questions.
- **D14 One target repo per instance** (`TARGET_REPO`); events from any other repo are ignored.
- **D15 Secret scanning** covers everything the bot sends out, including the diff before every push.
- **D16 Failures:** transient errors are retried a bounded number of times, then `needs-human` + comment.
  Never silent. **2026-11-11 (spec 2):** this applies from the router on. A failure at intake, before the sender
  is known to be allowed, ends as a `FAILED` event row with its error and no comment.
- **D17 Bounded loops:** the Coder and Quality Gate agent loops have step caps from config.
- **D18 Step skills are required (2026-11-10).** Every step a run uses needs a skill mapped in `workflow.json`;
  there is no built-in fallback prompt. Checked when the run starts, so nothing is posted or approved first: a
  missing skill → `needs-human` + one comment naming the missing steps (§3 R6). The bot keeps only its own
  prompt frame (output schema, tools, guardrails). Replaces "missing → built-in default prompt". Reason: a silent
  fallback gives weaker documents and can put a green Quality Gate check on a PR, and the steps no longer need a
  second set of method prompts.
- **D19 Two access levels (2026-11-11, spec 2).** A **Participant** (GitHub: Triage or higher) may open issues,
  add or remove `workflow: *` and `grill: skip`, and answer Grill Me. An **Approver** (GitHub: Write or higher)
  may also `/approve`, push to a bot PR and add `model: max-*` labels (D23, 2026-11-12). The contract names the
  levels, never a platform's roles; each adapter
  maps them (`IssueProvider.getAccessLevel`, which replaces `hasWriteAccess`). The same mapping serves personal
  and organization repos: a personal repo has no Triage role, so nobody there is only a Participant. Replaces
  "only `write` users drive the bot". Reason: people without code access (product owner, QA) can take an issue up
  to the Spec or Plan, while code still starts only on an Approver's `/approve`.
- **D20 `/approve` is the whole comment (2026-11-11, spec 2).** Trimmed, upper or lower case; anything else is a
  normal comment. Intake decides it, because the two inputs need different levels (was "exact syntax: spec 7").
- **D21 Answers to refused senders (2026-11-11, spec 2).** A Participant's `/approve` gets one reply per attempt.
  A lane or skip label added by a sender with no access is removed every time, with one comment per issue and
  label. Everything else from a sender with no access is ignored silently. **2026-11-12 (D23):** the same for a
  `model: max-*` label added by anyone below Approver.
- **D22 Gemini through `ChatGoogle` (2026-11-12, spec 4 interview).** The LLM client is `ChatGoogle` from
  `@langchain/google`, the package LangChain recommends for Gemini, with a Google AI Studio key
  (`GOOGLE_API_KEY`). Replaces `@langchain/anthropic` with `claude-sonnet-5-5`. LangGraph (D3) and the stored Grill
  conversation (LangChain messages) don't depend on the provider. (2026-11-17, spec 6 GMW2: no Grill conversation
  is stored; each prompt is rebuilt from the Grill tables, which hold plain text, and `ExecutionLog.prompt` keeps
  what was sent.) `ChatGoogleGenerativeAI`
  (`@langchain/google-genai`) is not used: LangChain says it will be deprecated (it runs on Google's old
  `@google/generative-ai` SDK). Reason: the developer's choice of provider. One bot instance uses one provider
  for every step: providers are never mixed per step. The provider's package is imported in one adapter file of
  `src/llm`; choosing the provider by configuration is Future (idea doc §11).
- **D23 A model per step, chosen by humans (2026-11-12, spec 4 interview).** `workflow.json` names the models in
  two levels, `standard` and `max`; each level has a required `default` and may name any step (§4). Five labels,
  `model: max-grill | max-spec | max-plan | max-code | max-quality-gate`, switch one step of one issue to `max`.
  Only an Approver may add one; one added by anyone else is removed with one comment per issue and label (as
  D21); a removal counts whoever made it, since it can only lower the model. The labels are read from the API at
  the start of every step run (every Grill round too) and never start anything on their own. A missing or invalid
  `models` section → `needs-human` (checked with the skills, §3 R6); model names are not checked against Google's
  list, so an unknown one fails at its first call → `needs-human`. `ExecutionLog` records the model, and every
  text an LLM step posts names it. Replaces "the model is a constant in spec 4". Reason: a human decides when a
  sensitive Spec or a hard coding task needs the most capable model; model names stay in a reviewed file, never in
  issue text or comments.
- **D24 A `Run` table; one active run per issue (2026-11-16, spec 5 interview).** One row per run: a UUID key
  (the run id in `ExecutionLog` and every later table of a run), a number per issue for people ("run 2", spec
  8's branch name), lane, `grill: skip`, the event that started it, start and end, and its latest stop. `Task`
  points to its current run. A new run ends the previous one; older runs and everything tied to them stay for
  traceability and never act again (R1). Reason: Rewind (Future) must find an old run, and the usage data must
  show how runs ended and why.
- **D25 `/retry` after a failure (2026-11-16, spec 5 interview).** A comment whose whole text is `/retry`, from a
  Participant, on an issue in `needs-human` entered on a failure (row 28), received after that stop: the issue
  goes back to the status it had and the failed event is processed again in the **same run**; work already done
  is not redone (markers). The stop comment suggests it next to the restart. Stops that are results of the work
  (rows 14, 25, 26) keep the restart as the only exit. Replaces "`/retry` → Future" (D7). Reason: a run should
  not lose its answers or approved documents because of credits, a key or an outage (spec 4, L15).
- **D26 Closed issues freeze (2026-11-16, spec 5 interview).** Issue events on a closed issue are ignored and
  recorded (`issue-closed`), with no comment; the run is not cancelled. Reopening unfreezes it. PR events are not
  affected. The router reads `open` with the labels (`UnifiedTask.open`, §4). **Same day (spec 5, RL19):** a lane
  label added, `/retry` or `/approve` on a closed issue gets one reply (reopen first); removing the run's own lane
  label still cancels the run, but nothing starts on a closed issue.
- **D27 The target repo's own skills and `AGENTS.md` files are discoverable in every step (2026-11-18, decided by
  the user during spec 6's build; required in the MVP).** A target repo keeps skills for its developers' tools
  (e.g. how to build a component: structure, guides, tests) and `AGENTS.md` files, at the root and in folders (a
  folder's file applies to the files under it). Every LLM step (Grill Me, Spec, Plan, Coder, Quality Gate) sees
  a list of them (each skill's name and description from its `SKILL.md`; each `AGENTS.md` path) and loads the
  ones it needs while it works, including a skill its own step skill tells it to use. Only files named
  `AGENTS.md`: `CLAUDE.md`, `.github/copilot-instructions.md` and the like are never read as instructions ~~(a
  file tool that opens one returns it as repo data)~~ (2026-11-22, spec 7 SPW1: no file tool opens them; D28). Like step skills, they are read at the step's base-branch
  commit, never from the agent branch or the PR head, so the Coder can't change its own rules; they are trusted
  instructions (only people who can merge to the base branch change them) and text only. Reason: a repo's
  conventions live in those files; loading all of them into every prompt doesn't scale, and copying them into a
  step skill means two copies to keep in step. A new spec 11 (`skill-discovery`), built after spec 6, writes the
  shared code and switches Grill Me over; specs 7, 9 and 10 use it from the start (§1). Spec 11 changes §4's
  step-skill contract first; the details are under "Edge cases routed to later specs" (7, 9–11). **Specified
  2026-11-20 in `spec-github-agent-skill-discovery.md`** (interview 2026-11-19, SD1–SD9): `repoSkills` in
  `workflow.json` names the skill folders; the root `AGENTS.md` is in every prompt; the other `AGENTS.md` files and
  the repo skills are listed and loaded on demand with two bot-owned tools (`load_skill`, `load_file`), step-skill
  files too; at most `SKILL_DISCOVERY_MAX_LOADS` files and `SKILL_DISCOVERY_MAX_BYTES` bytes per call, never failing
  a step; a "Read:" line under the comment; every file the model got in `context_loads`, with the provider's token
  count and the bot's estimate.
- **D28 Spec and Plan read the target repo's code (2026-11-21, spec 7 SP2; SPW1 confirmed 2026-11-22).** Two
  read-only tools, `list_files(folder)` and `read_file(path)`, at the step's base-branch commit through GitHub
  (`RepoProvider`; never the workspace, so Spec and Plan never wait for its lease). The file text is untrusted
  data, passes the secret scanner and counts toward spec 11's two limits per call; no code search. They never open
  another tool's instruction file (`CLAUDE.md` in any folder, `GEMINI.md`, `.github/copilot-instructions.md`,
  `.cursorrules`, `.windsurfrules`, `.cursor/`): `not-found`, and left out of listings. Reason: a Spec must know
  what exists to say what changes; a Plan must name real files.
- **D29 Each document records the commit it read; `/approve` compares it with the base branch, `/refresh`
  updates it (2026-11-21, spec 7 SP3–SP5; 2026-11-22, SPW13).** At `/approve` the bot asks the host which files
  changed since that commit; those the document's model read are flagged, stored with the approval and shown with
  a compare link: in the next document's header, or, for the last approval before code, in one reply to that
  `/approve`. It never blocks. `/refresh` (the whole comment, a Participant) brings the waiting document up to date
  without a restart: the Spec first (a changed approved Spec sends the issue back to `spec-review` and its Plan no
  longer counts), a new version as a new comment with the model's "What changed" list and a diff computed by the
  bot, or one "still up to date" reply; no model call when the branch hasn't moved. The bot owns the refresh frame;
  the method still comes from the step skill. Reason (the developer): the Spec is the most important document and
  must never stay stale while only the Plan is updated; a restart is too much for a small change.
- **D30 A deleted waiting document can be restored (2026-11-21, spec 7 SP9).** Deleting the document that waits
  for approval gets one explanation at once (who deleted it; `/restore`, or restart); GitHub's deletion event
  carries the last text, edits included, and the bot stores it. `/restore` (a Participant) posts it again with no
  model call; a missed deletion restores the bot's own last version. Any other deleted comment changes nothing.
  After approval a deletion changes nothing: the approved text is stored and later steps read only that.
- **D31 Documents are issue comments, one per step, and the approved texts become files with the code (2026-11-21,
  spec 7 SP6–SP8; built by spec 9).** A Spec or Plan is one Markdown comment of at most 50,000 characters (a longer
  answer is re-asked twice, then the run stops, retryable); a skill asking for several documents gets sections of
  one. The Coder's first commit adds the approved texts as `<issue>-<slug>.md` under the folders of
  `workflow.json`'s optional `documents` key (default `docs/specs`, `docs/plans`), so they are reviewed in the PR
  and later issues read them with D28's tools. Nothing in `.env`. Rejected: the file on a branch as the document
  (branches before spec 8, left behind by cancelled runs, reading away from the issue).

## Contradictions found in the idea doc

| # | Contradiction or gap | Resolution |
|---|---|---|
| F1 | §9 puts the lease on `GrillSession`; §7 claims a lease per issue/PR before routing; §12 gives the lease to spec 5 and `GrillSession` to spec 6. No `GrillSession` exists for `code-only` or PR events. | D1, D2 |
| F2 | §9 logs unauthorized comments in `ExecutionLog` (spec 4), but spec 2 doesn't depend on spec 4. A permission check in the controller loses events when the GitHub API call fails (GitHub doesn't redeliver failed deliveries). | D4 |
| F3 | §5 says new issues get `status: draft`; §7 never sets it. | Set on `issues.opened` (unknown task) and on cancel. |
| F4 | §7: a `WAITING_WORKSPACE` retry goes straight to the workspace claim, skipping the session lease and the router. | D11 |
| F5 | §10 runs `WORKSPACE_SETUP_COMMAND` before checking out the fetched base, so it installs the old base's dependencies. | Run it after the checkout (spec 8). |
| F6 | §10's `git checkout -B agent/<n>-<slug>` silently resets an existing branch (a red run the developer continues on, or a restart). | The branch name includes the run number; the bot never resets an existing branch (spec 8). |
| F7 | §12: specs 6 and 7 need step skills, but reading them is in spec 8, which neither depends on. | D9 |
| F8 | §12: spec 2's permission check and label revert need the GitHub provider (spec 3), and spec 4 now reads skills through it. | Specs 2 and 4 depend on 3. |
| F9 | §12: spec 1 posts "via the App", but App auth is listed under spec 3. | Spec 1 ships a minimal App client; spec 3 replaces it. |
| F10 | §6: `postComment` returns `void` although §9 stores comment IDs and searches markers; methods take `taskId` although adapters call the API by `externalRef`; `extractWorkflowLabel` can't report two lanes. | Contracts revised (§4). |
| F11 | §10 says the setup guide creates the labels; §12 gives label creation to spec 3. | The bot creates missing labels at startup (spec 3); the guide documents them. |

---

## 1. Capability map

Module ids are stable kebab-case ids and match the spec files (`docs/specs/spec-github-agent-<id>.md`).
Numbers are IDs, not build order.

| # | Module id | NestJS module(s) · folder | Responsibility | Depends on | Effort |
|---|---|---|---|---|---|
| 1 | `walking-skeleton` | `ConfigModule`, `PrismaModule`, `WebhookModule`, `EventsModule` · `src/config`, `src/prisma`, `src/webhook`, `src/events` | Zod env validation, Prisma, `POST /webhooks/github` + HMAC guard, events table, `enqueue()`, polling worker, minimal App client for the "hello" comment | — | high |
| 2 | `intake-authorization` | `IntakeModule` · `src/intake` | Payload → neutral input (`WorkflowInput`), the sender's access level (+ the App's own PR events), target-repo filter, ignore reasons, label revert, `/approve` reply | 1, 3 | xhigh |
| 3 | `github-providers` | `GitHubModule` · `src/github` | App auth (JWT → installation token), GitHub `IssueProvider` + `RepoProvider`, label bootstrap | 1 | high |
| 4 | `llm-foundation` | `LlmModule`, `SecretScanModule` · `src/llm`, `src/secret-scan` | Gemini client (`ChatGoogle`, D22), model per step (D23), Zod output + re-ask, `ExecutionLog` (prompt, answer, usage), input guard, secret scanner at the ports, step-skill loader + prompt assembly | 1, 3 | xhigh |
| 5 | `router-session-lease` | `WorkflowModule` · `src/workflow` | `Task` and `Run` state + label projection, lease service (claim, heartbeat, release), `decide()`, dispatcher + handler registry, run start, cancel/restart, stale events, closed issues, `needs-human` + `/retry` (2026-11-16) | 2, 3, 4 (2026-11-16, spec 5 plan: the run-start check and the injection warning) | xhigh |
| 6 | `grill-me` | `GrillModule` · `src/grill` | Grill rounds (1..K questions), `GrillSession`/`GrillRound`, bursts, limit, skip, cancel comment; 2026-11-17: `GrillEvaluation`/`GrillAnswer`, 👀 on comments with nothing to add, the answers block | 4, 5; 2026-11-17 (spec 6): also 2 (answer comments read with intake's rules) and 3 (the issue port) | max |
| 7 | `spec-plan-approvals` | `DocumentsModule` · `src/documents` | Spec/Plan generation, `/approve` rules, approved snapshots; 2026-11-18 (D27): through spec 11's discovery; 2026-11-21 (spec 7): the go-signal, the read-only repo tools (D28), the commit check and `/refresh` (D29), deletions and `/restore` (D30) | 6, 11 (2026-11-18); 2026-11-21 (spec 7): also 2, 3, 4, 5 (changes to their code) | xhigh |
| 8 | `workspace-git` | `WorkspaceModule` · `src/workspace` | git runner (`execFile`), bot worktree, workspace lease + queue, setup command, bot identity, per-command token | 3, 5 | max |
| 9 | `coder` | `CoderModule` · `src/coder` | Coder agent loop (LangGraph), file tools, command allowlist, lint/test gate, commit/push/PR, red and interrupted runs; 2026-11-18 (D27): spec 11's discovery in the loop, a folder's `AGENTS.md` for the files it works on | 4, 7, 8, 11 (2026-11-18) | xhigh |
| 10 | `quality-gate` | `QualityGateModule` · `src/quality-gate` | Quality Gate agent loop (LangGraph) on bot PRs, `report-only`, PR comment + check run; 2026-11-18 (D27): spec 11's discovery, the `AGENTS.md` files of the changed files | 4, 9, 11 (2026-11-18) | xhigh |
| 11 | `skill-discovery` (2026-11-18, D27) | `LlmModule` · `src/llm` (extends spec 4's module) | The target repo's skills and `AGENTS.md` files discoverable in every step: their lists in the prompt, a tool that loads one at the step's base-branch commit, a bounded tool loop for the steps without an agent loop (Grill Me, Spec, Plan), what each call loaded ~~in `ExecutionLog`~~ (2026-11-20: in `ContextLoad`); switches Grill Me over. 2026-11-20 (spec 11): the root `AGENTS.md` always in the prompt, step-skill files loaded on demand too, two tools (`load_skill`, `load_file`), two limits, `ContextLoad`, one `ExecutionLog` row per model request, token counts | 3, 4, 6 | xhigh |

**Build order:** 1 → 3 → 2 → 4 → 5 → 6 → 11 → 7 → 8 → 9 → 10 (2026-11-18: spec 11 added, D27). Specs 2 and 4 can
swap; spec 8 only needs 3 and 5.

**Module rules**
- Imports follow the "Depends on" column, with no cycles. Step modules (6, 7, 9, 10) register their handlers in
  `WorkflowModule`; `WorkflowModule` never imports them.
- Only `WorkflowModule` writes `Task.status` and the `status: *` label. Only `WorkspaceModule` runs `git`. Only
  `GitHubModule` imports Octokit (spec 3 removes spec 1's hello client). Only `CoderModule` and
  `QualityGateModule` use LangGraph.
- Only `src/llm/google` imports the LLM provider's package (D22). `SecretScanModule` depends on nothing but
  config; `GitHubModule` imports it and wraps both providers with the scanner, so no module can get a port that
  doesn't scan (spec 4, 2026-11-12).
- A table is written only through its owner module's services (§6).

**Project structure**

```text
src/
  main.ts, app.module.ts
  contracts/                        §4 types + DI tokens (ISSUE_PROVIDER, REPO_PROVIDER), no logic
  config/ prisma/ webhook/ events/  spec 1
  intake/                           spec 2
  github/                           spec 3
  llm/ secret-scan/                 spec 4
  workflow/                         spec 5
  grill/ documents/                 specs 6, 7
  workspace/                        spec 8
  coder/ quality-gate/              specs 9, 10
prisma/                             schema.prisma + migrations (each spec adds its own)
test/                               integration and e2e tests; unit tests sit next to the code (*.spec.ts)
docs/                               idea/, specs/, plans/, guides/
```

Step modules ship only their bot-owned prompt frame (output schema, tools, guardrails); the method always comes
from the target repo's skill (D18, 2026-11-10; was "their own built-in default prompts").

## 2. Repositories

| | Bot repo [`Hugoer/sdd-agent`](https://github.com/Hugoer/sdd-agent) (this repo, was `cn_ai` until 2026-11-10) | Target repo (sandbox) [`Hugoer/sdd-agent-sandbox`](https://github.com/Hugoer/sdd-agent-sandbox) |
|---|---|---|
| What | The NestJS app. The bot never writes code here. | New demo repo (small TypeScript project, ESLint + Vitest) where issues live and the bot codes. |
| Contains | `src/`, `prisma/`, the steps' prompt frames (D18), tests, `docs/`, `AGENTS.md`, `.env.example` (`.env` is gitignored) | Issues and labels, `.github-agent/workflow.json` (skills and models per step, D23), step skills (e.g. `.claude/skills/*`), the product code, `agent/*` branches, bot PRs and check runs, optional branch protection |
| On the developer's machine | The developer's checkout; runs the app | The developer's clone (`WORKSPACE_REPO_PATH`) and the bot worktree (`WORKSPACE_WORKTREE_PATH`: shares history, only the bot writes there) |
| GitHub App | Not installed | Installed (only here) |
| Created by | The developer, manually | The developer, manually; spec 1's setup covers it |

- **GitHub App** (one, owned by the developer): permissions `issues`, `pull_requests`, `contents`, `checks`
  (write) and `metadata` (read), spec 3; webhook events `issues`, `issue_comment`, `pull_request`, spec 2;
  webhook URL = the ngrok tunnel → `POST /webhooks/github`; secret = `GITHUB_WEBHOOK_SECRET`.
- **Labels** (created by the bot at startup if missing, spec 3):
  `status: draft | grilling | spec-review | ready-for-dev | executing | in-review | needs-human` (bot only);
  `workflow: full-sdd | spec-code | code-only` and `grill: skip` (humans only);
  `model: max-grill | max-spec | max-plan | max-code | max-quality-gate` (Approvers only, D23, 2026-11-12).
- **State:** the local PostgreSQL holds all workflow state; GitHub only shows its projection (labels, comments,
  PRs, check runs).

## 3. State machine

### States, runs and lanes

- **States** = `Task.status`, shown as the `status: *` label: `draft` (no run; also any issue without a `Task`
  row), `grilling`, `spec-review`, `ready-for-dev`, `executing`, `in-review`, `needs-human`.
  "Run state" = any state except `draft`.
- **Run:** started by a lane label. It owns its lane, Grill session, documents, approvals and PR, and ends only
  when cancelled. A restart cancels the run and starts a new one from scratch (D6). **2026-11-16 (D24, D25):**
  one `Run` row per run; `needs-human` stops a run without ending it, and `/retry` continues a run stopped on a
  failure.
- **Lanes** (✋ = `/approve`): `full-sdd` = Grill → Spec ✋ → Plan ✋ → Coder → Quality Gate ·
  `spec-code` = Grill → Spec ✋ → Coder → Quality Gate · `code-only` = go-signal ✋ → Coder → Quality Gate.
  `grill: skip` drops Grill Me from the first two and is read ~~only~~ when a run starts; **2026-11-17 (spec 6,
  GM8):** added while the bot is asking questions, it stops them and the run moves on to the Spec (row 16); GM15:
  the label is read whenever the bot would ask (a run start, also a retried one, and every comment while
  grilling), so one added while the run was stopped or the issue closed still counts; its own event counts only
  if the label is still on.

### Inputs

| Input | Source |
|---|---|
| `ISSUE_OPENED` | `issues.opened` |
| `LANE_ADDED(l)`, `LANE_REMOVED(l)` | `issues.labeled` / `issues.unlabeled` with `workflow: l` |
| `SKIP_ADDED` | `issues.labeled` with `grill: skip` |
| `COMMENT` | `issue_comment.created` on the issue that isn't a command |
| `APPROVE` | `issue_comment.created` whose whole text is `/approve` (D20, 2026-11-11; was "exact syntax: spec 7") |
| `RETRY` | `issue_comment.created` whose whole text is `/retry` (D25, 2026-11-16) |
| `REFRESH`, `RESTORE` | `issue_comment.created` whose whole text is `/refresh` or `/restore` (D29, D30, 2026-11-21, spec 7) |
| `BOT_COMMENT_DELETED` | `issue_comment.deleted` of a comment the bot wrote on the issue; the sender is who deleted it (D30, 2026-11-21, spec 7) |
| `PR_UPDATED` | `pull_request.opened` / `synchronize` on a bot PR |
| Step outcomes | Grill `ASKED`, `CLEAR`, `LIMIT` (an evaluation that only waits returns nothing, 2026-11-17, spec 6) · workspace `WS_BUSY`, `WS_DIRTY`, `WS_CLAIMED` · Coder `GREEN`, `RED` · `INTERRUPTED` · `FAILED(cause)` · 2026-11-21 (spec 7): `SPEC_REFRESHED` (a Spec v2 posted while the Plan waited) |

The first ~~seven~~ nine rows (2026-11-21, spec 7) are the `WorkflowInput` type of §4, produced by intake (spec 2).
`RETRY` needs a Participant (2026-11-16); so do `REFRESH`, `RESTORE` and `BOT_COMMENT_DELETED` (2026-11-21, spec 7).

**Ignored at intake** (recorded with a reason, never routed; the reasons: spec 2): other repos; senders below the
level the input needs (D19: `APPROVE` and a human's `PR_UPDATED` need Approver, every other input Participant;
D21 says which refusals get a comment); the bot's own events, except `PR_UPDATED` on its own PR; comment edits and
deletes (2026-11-21, spec 7: except a bot comment's deletion, `BOT_COMMENT_DELETED`); comments on PRs; PRs not opened by the bot; `status: *` label changes; `grill: skip` removal; `model: max-*` label changes (D23, 2026-11-12: the next step run
reads them from the API; one added below Approver is removed with one comment); a label
event without a label (the label was deleted from the repo); invalid payloads; any other event type or action.
(2026-11-11: was "senders without `write` (a lane or skip label they added is removed + one comment)".)

### Per-event pipeline

1. **Controller:** HMAC check (`401` if invalid) → store, deduplicated by delivery ID → `202`. No outbound calls.
2. **Worker** (oldest pending first): intake; ignored events stop here.
3. **Lease:** claim the task's session lease (PR events: the task of the bot PR). Taken → the event stays pending.
4. **Route:** load `Task`, read lane/skip labels from the API when the input needs them → `decide()` → handler →
   outcome → `decide()` … until the job ends.
5. **Finish:** release the lease; mark the event done, ignored, waiting or failed.

### Rules applied before the table

- **R1 Stale events:** an event received before the current run started is ignored. **2026-11-16 (spec 5,
  RL10):** precisely, an event received before the **event that started** the issue's latest run is stale; the
  run's own start event never is (so a retried run start still works).
- **R2 Valid `/approve`:** posted after the document or go-signal the current status points to, and that document
  isn't approved yet (the event that recorded the approval may be retried). **2026-11-21 (spec 7):** the document
  is the run's current version (not superseded); its comment must still be there and hold text between its
  markers (the go-signal checks only the time and the approval). An invalid `/approve` gets one reply with the
  reason (row 20); an event that already approved an earlier document of the run (retried after the next step
  started) ends with no reply.
- **R3 One job per task:** while a job holds the lease, the task's other events wait, then run against the new
  state.
- **R4 Failures:** after bounded retries, any step failure becomes `FAILED(cause)`: invalid `workflow.json`,
  missing skill, unknown model (D23), guardrail block, API error, rejected push, …, and (2026-11-16, spec 5) a
  step whose handler isn't registered (`step-not-built`). A failure stops only a running run; with no run, or a
  run already stopped, the event is only `FAILED`.
- **R5 `needs-human`:** every entry posts exactly one comment with the cause and "restart: remove and re-add the
  `workflow:*` label". The restart is the only exit. **2026-11-16 (D25):** an entry on a failure (row 28) also
  suggests `/retry`, which is a second exit for it.
- **R6 Skills check (D18, 2026-11-10):** a run goes on to rows 9–11 only if every step it will use has a skill in
  `workflow.json`: `full-sdd` → `grill`, `spec`, `plan`, `code`, `qualityGate`; `spec-code` → the same without
  `plan`; `code-only` → `code`, `qualityGate`; with `grill: skip` → without `grill`. Otherwise the run is created
  and fails at once with `FAILED(missing skills: …)` (row 28); nothing else is posted. Each step checks again
  when it loads its skill. **2026-11-12 (D23):** the same check needs a valid `models` section; otherwise
  `FAILED(invalid workflow.json)`.

### Transition table (normative)

| # | State | Input | Action | Next |
|---|---|---|---|---|
| 1 | draft | `ISSUE_OPENED` | If no `Task` row exists: create it, set `status: draft`. 2026-11-16 (spec 5 plan P6): precisely, while no status label is shown yet and the issue never had a run; a row a lane event created first is used as is, and a retried `opened` whose label failed sets it then | draft |
| 2 | draft | `LANE_ADDED`, exactly one lane label on the issue | Start a run (rows 9–11) | per lane |
| 3 | draft | `LANE_ADDED`, two or more lane labels | One comment: keep exactly one `workflow:*` label (2026-11-16: one per conflict, not per event) | draft |
| 4 | draft | `LANE_REMOVED`, exactly one lane label left | Start a run with it (rows 9–11) | per lane |
| 5 | draft | anything else | Ignored. 2026-11-21 (spec 7): `APPROVE`, `REFRESH`, `RESTORE` → one reply (row 36) | draft |
| 6 | run state | `LANE_REMOVED` of the run's lane | Cancel the run: close the Grill session (kept), cancel comment if it had answered rounds (D6). Exactly one lane label left → start a run with it. 2026-11-16: wins over row 8 whatever is left; one run-ended comment always (RL18); with two or more lanes left, a fresh reminder | draft or per lane |
| 7 | run state | `LANE_ADDED`, exactly one lane label now | Cancel as in row 6, then start a run with it (restart). 2026-11-16 (RL12): only for a lane other than the run's own; adding the run's own lane is ignored, so a swap handled late gives one new run | per lane |
| 8 | run state | any other lane-label change (two or more lanes, or another lane removed) | Ignored; the run continues. 2026-11-16: with two or more lanes, one reminder per conflict (the run keeps its lane; how to switch), and a fresh one whenever the set of labels changes (spec 5 plan, Checkpoint 2) | unchanged |
| 9 | ↳ run start | `full-sdd` / `spec-code`, no `grill: skip` | Open a Grill session, first evaluation (2026-11-17, spec 6 GM4: comments written meanwhile are read before it acts) | rows 12–14 |
| 10 | ↳ run start | `full-sdd` / `spec-code` + `grill: skip` | `GrillSession` SKIPPED + skip comment → generate and post the Spec | spec-review |
| 11 | ↳ run start | `code-only` | Go-signal comment | ready-for-dev |
| 12 | ↳ Grill outcome | `ASKED` | Post 1..K questions (two transactions + marker); 2026-11-17 (spec 6 GM1, GM5): numbered Q1, Q2, … across the run, each with the bot's guess | grilling |
| 13 | ↳ Grill outcome | `CLEAR` (≥ threshold) | If no question was asked: comment with the score. Generate and post the Spec | spec-review |
| 14 | ↳ Grill outcome | `LIMIT` (max rounds, below threshold) | One summary comment (confidence + gaps; 2026-11-17, spec 6 GM9: plus three numbered steps to continue, which replace the generic restart line) | needs-human |
| 15 | grilling | `COMMENT` | Grill round with the merged answer (every comment since the last question). 2026-11-17 (spec 6 GM4, GM6, GM12): every answer comment not read yet, also those written while the run was stopped; a comment already read → nothing; nothing new to ask while questions are open → 👀 on the comments, keep waiting (no round) | rows 12–14, or grilling |
| 16 | grilling | `APPROVE`, `SKIP_ADDED` | ~~Ignored (force continue is Future)~~ 2026-11-17 (spec 6 GM8): `APPROVE` → one reply (nothing to approve yet, the open questions, how to stop them); `SKIP_ADDED` → close the Grill session (`STOPPED`) + one comment → generate and post the Spec, only while the label is still on (GM15; ~~otherwise ignored~~ otherwise read like a `COMMENT`, row 15, which usually finds nothing new: 2026-11-17, spec 6 plan P1). A `COMMENT` with `grill: skip` on the issue takes this path too. Once Grill Me has ended, a later Grill call of the run posts its missing closing comment and goes on to the Spec without a model call (spec 6 plan P1) | grilling (`APPROVE`), spec-review (`SKIP_ADDED`) |
| 17 | spec-review (`full-sdd`) | valid `APPROVE` | Snapshot the approved Spec → generate and post the Plan | ready-for-dev |
| 18 | spec-review (`spec-code`) | valid `APPROVE` | Snapshot the approved Spec → claim the workspace. 2026-11-22 (spec 7, SPW13): files it read changed on the base branch → one warning reply first | rows 21–23 |
| 19 | ready-for-dev | valid `APPROVE` | `full-sdd`: snapshot the approved Plan (2026-11-22, spec 7 SPW13: with row 18's warning reply). Then claim the workspace | rows 21–23 |
| 20 | spec-review, ready-for-dev | `COMMENT`, `SKIP_ADDED`, invalid `APPROVE` | ~~Ignored~~ 2026-11-21 (spec 7): invalid `APPROVE` → one reply with the reason (R2); a near-miss `/approve` → one hint per document; a comment written while the bot wrote the run's first Spec → one reply (SP12); anything else ignored | unchanged |
| 21 | ↳ workspace claim | `WS_BUSY` | Approval recorded; event marked `WAITING_WORKSPACE`; one "queued" comment. Retried oldest first through the whole pipeline once the workspace is free | unchanged |
| 22 | ↳ workspace claim | `WS_DIRTY` | Comment; release the workspace lease | needs-human |
| 23 | ↳ workspace claim | `WS_CLAIMED` | Start the Coder job (heartbeat on) | executing |
| 24 | executing | `GREEN` | Commit as the bot, push, open the PR; detach the worktree; release the workspace lease | in-review |
| 25 | executing | `RED` (after `CODER_MAX_FIX_ATTEMPTS`) | Local commit only; comment with trimmed, scanned output + branch name; detach; release | needs-human |
| 26 | executing | `INTERRUPTED` (the job's own event retried after a crash) | PR already opened → finish as `GREEN`. Otherwise comment, leave the worktree as is, release the workspace lease | in-review or needs-human |
| 27 | in-review, needs-human | `COMMENT`, `APPROVE`, `SKIP_ADDED` | Ignored. 2026-11-21 (spec 7): `APPROVE` → one reply (row 36) | unchanged |
| 28 | any with a running run | `FAILED(cause)` | One comment naming the run, the step and the cause, with `/retry` and the restart (2026-11-16); the stop is saved first; release held leases. A failing `/retry` event never stops the run (RL13) | needs-human |
| 29 | any (the task has a bot PR) | `PR_UPDATED` | Quality Gate on the newest head commit (older heads skipped) → PR comment + check run | unchanged |
| 30 | needs-human, entered on a failure (row 28) | `RETRY` received after the stop (2026-11-16, D25) | Back to the status before the stop; process the failed event again in the same run | status before the stop |
| 31 | needs-human, entered as a result of the work (rows 14, 25, 26) | `RETRY` received after the stop (2026-11-16) | One reply per `/retry`: a restart is needed | needs-human |
| 32 | spec-review (any lane), ready-for-dev (`full-sdd`) | `REFRESH` (2026-11-21, spec 7, D29) | Refresh: the Spec first; a Spec v2 while the Plan waits → `SPEC_REFRESHED`; otherwise a new version or one reply | spec-review or unchanged |
| 33 | spec-review (any lane), ready-for-dev (`full-sdd`), needs-human stopped from one of them | `BOT_COMMENT_DELETED` of the waiting document, not approved (2026-11-21, spec 7, D30) | Record it + one explanation; any other deleted bot comment → ignored | unchanged |
| 34 | spec-review (any lane), ready-for-dev (`full-sdd`) | `RESTORE` (2026-11-21, spec 7, D30) | Restore the waiting document if its comment is gone and it isn't approved; otherwise one reply | unchanged |
| 35 | grilling, ready-for-dev (`code-only`), executing, in-review, needs-human, draft with a run | `REFRESH`, `RESTORE` (2026-11-21, spec 7) | One reply why | unchanged |
| 36 | draft, executing, in-review, needs-human | `APPROVE` (2026-11-21, spec 7) | One reply why | unchanged |

`RETRY` in any other case does nothing but gets one reply saying why (no run, not stopped, written before the
stop; 2026-11-16, RL20). Closed issues are handled before this table (D26). The event that started the current
run is checked before rows 6–8: running → it continues the run, stopped → ignored (RL14). 2026-11-16 (spec 5
plan P15): rows 2–5 apply only while the issue has no current run, and rows 6–8 whenever it has one, even in
`draft` (before the first step sets a status, or after `/retry` of a stop at the first step). A run is never
created beside a current one, except by a restart, which ends the current run first.

Informative view (the table wins if they differ):

```mermaid
stateDiagram-v2
    state "draft" as draft
    state "grilling" as grilling
    state "spec-review" as specReview
    state "ready-for-dev" as readyForDev
    state "executing" as executing
    state "in-review" as inReview
    state "needs-human" as needsHuman

    [*] --> draft: issue opened
    draft --> grilling: lane label, full-sdd or spec-code
    draft --> specReview: lane label with grill skip, or issue already clear
    draft --> readyForDev: lane label, code-only
    draft --> needsHuman: lane label, a needed skill is missing
    grilling --> grilling: answer, next round or wait
    grilling --> specReview: confidence reached or grill skip added, Spec posted
    grilling --> needsHuman: round limit
    specReview --> readyForDev: /approve full-sdd, Plan posted
    specReview --> executing: /approve spec-code
    readyForDev --> executing: /approve
    readyForDev --> specReview: /refresh full-sdd, Spec v2 posted
    executing --> inReview: lint and tests green, PR opened
    executing --> needsHuman: red, failure or crash
    specReview --> needsHuman: dirty worktree or failure
    readyForDev --> needsHuman: dirty worktree or failure

    note right of draft
        Removing the run's lane label cancels the run (back to draft).
        Adding a lane label starts a run, or restarts an active one.
    end note

    note left of needsHuman
        After a failure, /retry goes back to the status before the stop (D25).
    end note
```

## 4. Shared contracts

Types and DI tokens live in `src/contracts` (no logic). GitHub implementations: spec 3. Jira / Azure DevOps: Future.
A spec that needs another method adds it here first.

```ts
export type Platform = 'GITHUB' | 'JIRA' | 'AZURE_DEVOPS';
export type Lane = 'full-sdd' | 'spec-code' | 'code-only';
export type TaskStatus =
  | 'draft' | 'grilling' | 'spec-review' | 'ready-for-dev' | 'executing' | 'in-review' | 'needs-human';
/** What a user may do with the bot, lowest first (D19, added 2026-11-11). Never a platform's role name. */
export type AccessLevel = 'none' | 'participant' | 'approver';

/** DB identity = platform + id. externalRef is what adapters call the API with; it may change. */
export interface TaskRef {
  platform: Platform;
  id: string;          // stable platform ID (GitHub: issue.id)
  externalRef: string; // e.g. "owner/repo#123", "PROJ-123"; refreshed from every event
}

export interface UnifiedTask extends TaskRef {
  title: string;
  description: string;
  labels: string[];    // always read from the API, never from a webhook payload
  author: string;
  url: string;
  open: boolean;       // false when the issue is closed (added 2026-11-16, spec 5, D26)
}

export interface CommentRef { id: string; url: string; createdAt: Date }

export interface IssueProvider {
  getTaskDetails(task: TaskRef): Promise<UnifiedTask>;
  /** body carries its hidden marker; the port redacts secrets before sending (spec 4, 2026-11-12;
   *  was "body is already secret-scanned") */
  postComment(task: TaskRef, body: string): Promise<CommentRef>;
  getComment(task: TaskRef, commentId: string): Promise<{ body: string; createdAt: Date } | null>;
  /** exactly-once recovery: the bot's comment carrying this marker, if it was already posted */
  findCommentByMarker(task: TaskRef, marker: string): Promise<CommentRef | null>;
  /** projection of Task.status: sets this status label and removes any other `status: *` label */
  setStatusLabel(task: TaskRef, status: TaskStatus): Promise<void>;
  /** only to revert a lane/modifier label added by a sender with no access (D21),
   *  or a model label added below Approver (D23, 2026-11-12) */
  removeLabel(task: TaskRef, label: string): Promise<void>;
  /** the user's level on the task's repo or project, asked on every call (replaces hasWriteAccess, 2026-11-11).
   *  GitHub: Write or higher → 'approver', Triage → 'participant', anything else or unknown user → 'none' */
  getAccessLevel(task: TaskRef, login: string): Promise<AccessLevel>;
  /** true when login is the bot's own account (added 2026-11-11, spec 2) */
  isSelf(login: string): boolean;
  /** marks a human comment as read, with nothing to add (GitHub: the 👀 reaction); doing it twice changes
   *  nothing, and a comment that no longer exists is not an error (added 2026-11-17, spec 6 GM6) */
  acknowledgeComment(task: TaskRef, commentId: string): Promise<void>;
  /** platform label names → neutral controls; returns every lane found, so callers can detect two */
  readControls(task: UnifiedTask): { lanes: Lane[]; grillSkip: boolean; maxModelSteps: StepName[] };
  // maxModelSteps: the steps whose `model: max-*` label is on the task (D23, spec 4, 2026-11-12)
  /** creates missing status / workflow / modifier / model labels (startup) */
  ensureLabels(): Promise<void>;
}

export interface PullRequestRef { platform: Platform; repo: string; number: number; url: string }

export interface PushCredentials {
  authorName: string;  // "<app>[bot]"
  authorEmail: string;
  remoteUrl: string;   // explicit HTTPS URL; the developer's `origin` is never used or changed
  token: string;       // short-lived installation token: passed per command, never persisted
                       // (spec 3, G8: target repo only, contents: write only, new on every call)
  expiresAt: Date;
}

/** Added 2026-11-10 (spec 3, G7). */
export interface RepoFile {
  path: string;        // relative to the repo root
  size: number;        // bytes
  executable: boolean; // git mode 100755
}

export interface RepoProvider {
  getPushCredentials(): Promise<PushCredentials>;
  /** file content at a ref on the code host (step skills: always the base branch); null = missing */
  readFile(ref: string, path: string): Promise<string | null>;
  /** every regular file under dir at a ref, at any depth (a step skill is its whole directory);
   *  null = no such directory (added 2026-11-10, spec 3, G7) */
  listFiles(ref: string, dir: string): Promise<RepoFile[] | null>;
  /** the commit SHA a branch or ref points to now, so a skill is read at one commit; unknown ref →
   *  permanent ProviderError (added 2026-11-12, spec 4) */
  resolveRef(ref: string): Promise<string>;
  /** the paths changed between two commits (both sides of a rename); complete = false when the host cut the
   *  list; unknown commit → permanent ProviderError (added 2026-11-21, spec 7, D29) */
  changedFiles(from: string, to: string): Promise<{ paths: string[]; complete: boolean }>;
  /** a page people can open to see the change between two commits (GitHub: /compare/<from>...<to>;
   *  added 2026-11-21, spec 7) */
  compareUrl(from: string, to: string): string;
  openPullRequest(branch: string, base: string, title: string, body: string): Promise<PullRequestRef>;
  /** recovery after a crash between opening the PR and recording it */
  findPullRequest(branch: string): Promise<PullRequestRef | null>;
  postPullRequestComment(pr: PullRequestRef, body: string): Promise<CommentRef>;
  setQualityResult(pr: PullRequestRef, commitSha: string,
    result: 'success' | 'neutral' | 'failure', summary: string): Promise<void>;
}

export type StepName = 'grill' | 'spec' | 'plan' | 'code' | 'qualityGate';

export type ModelLevel = 'standard' | 'max';

/** What a target-repo skill contributes to a step: instructions, nothing else. Text files only, read at one
 *  base-branch commit; nothing is executed (replaces StepSkill, 2026-11-12, spec 4). 2026-11-20 (spec 11):
 *  SKILL.md goes into the prompt, the other text files are listed and loaded on demand. */
export interface LoadedSkill {
  step: StepName;
  path: string;   // directory mapped in .github-agent/workflow.json
  commit: string; // commit SHA everything was read at
  // ~~files: { path: string; text: string }[]; // SKILL.md first, then by path~~ (spec 4)
  instructions: string;  // SKILL.md (spec 11)
  files: ListedFile[];   // the other text files, repo paths, sorted; never SKILL.md (spec 11)
}
export interface ListedFile { path: string; bytes: number } // a repo path, from the listing (spec 11)

/** A skill of the target repo, found under a `repoSkills` folder (added 2026-11-20, spec 11). */
export interface RepoSkill { name: string; description: string; path: string; files: ListedFile[] }
/** What the target repo offers a step besides its step skill, at the same commit (added 2026-11-20, spec 11). */
export interface RepoContext {
  rootAgents: { text: string; bytes: number } | null; // the root AGENTS.md, always in the prompt
  skills: RepoSkill[];                                 // listed; never the step's own skill
  agents: ListedFile[];                                // every other AGENTS.md, listed
}

/** The model a step run uses (D23) and what the run was read with (added 2026-11-12, spec 4). */
export interface ResolvedModel { provider: string; name: string; level: ModelLevel }
export interface StepSetup { commit: string; skill: LoadedSkill; model: ResolvedModel; repo: RepoContext } // repo: spec 11

/** Added 2026-11-10 (spec 3, G5). Every provider failure. The worker retries `transient` and fails
 *  `permanent` at once; providers never retry a call themselves. */
export class ProviderError extends Error {
  constructor(message: string, readonly kind: 'transient' | 'permanent',
    readonly detail: { status?: number; retryAfterSeconds?: number } = {}) { super(message); }
}

/** Added 2026-11-12 (spec 4). A model call failed; the worker treats it like a ProviderError. */
export type LlmErrorCode = 'rate-limited' | 'provider-unavailable' | 'bad-api-key' | 'access-denied'
  | 'credits-exhausted' | 'unknown-model' | 'answer-blocked' | 'answer-cut' | 'bad-request' | 'invalid-answer';
export class LlmError extends Error {
  constructor(message: string, readonly kind: 'transient' | 'permanent', readonly code: LlmErrorCode,
    readonly detail: { retryAfterSeconds?: number } = {}) { super(message); }
}
/** Added 2026-11-12 (spec 4). workflow.json, a skill or a model entry is wrong: always permanent. */
export class StepConfigError extends Error {}

/** Added 2026-11-11 (spec 2). What intake hands to the router: one authorized event, platform-neutral. */
export interface TaskComment { id: string; body: string; createdAt: Date; url?: string } // body is untrusted data; url: 2026-11-17, spec 6
export type WorkflowInput = {
  deliveryId: string; // WebhookEvent.deliveryId
  receivedAt: Date;   // when the controller stored the event ("received" in §3 R1)
  sender: string;     // login; the bot's own login only on PR_UPDATED
} & (
  | { type: 'ISSUE_OPENED' | 'SKIP_ADDED'; task: TaskRef }
  | { type: 'LANE_ADDED' | 'LANE_REMOVED'; task: TaskRef; lane: Lane }
  | { type: 'COMMENT' | 'APPROVE' | 'RETRY' | 'REFRESH' | 'RESTORE'; task: TaskRef; comment: TaskComment }
  // RETRY: 2026-11-16, D25; REFRESH, RESTORE: 2026-11-21, spec 7
  | { type: 'BOT_COMMENT_DELETED'; task: TaskRef; comment: TaskComment } // body: its text when deleted (spec 7, D30)
  | { type: 'PR_UPDATED'; pr: PullRequestRef; headSha: string }
);
```

### Step-skill contract

| Step (`workflow.json` key) | Output, Zod-validated (bot-owned) | Tools (bot-owned) | Limits |
|---|---|---|---|
| Grill Me (`grill`) | ~~`{ confidence: 0–100, questions: string[] (0..K), gaps: string[] }`~~ 2026-11-17 (spec 6): `{ confidence: 0–100, questions: { question, guess }[] (the bot posts at most K), open: number[], gaps: string[] }` | ~~none~~ 2026-11-20 (spec 11): `load_skill`, `load_file` (repo skills, step-skill files, folder `AGENTS.md` files, at the base-branch commit), offered only when something can be loaded | `GRILL_MAX_ROUNDS`, `GRILL_MAX_QUESTIONS_PER_ROUND`, `GRILL_CONFIDENCE_THRESHOLD`; `SKILL_DISCOVERY_MAX_LOADS`, `SKILL_DISCOVERY_MAX_BYTES` per call (spec 11) |
| Spec (`spec`), Plan (`plan`) | ~~Markdown document (shape: spec 7)~~ 2026-11-21 (spec 7): one Markdown document of at most 50,000 characters (D31); a refresh `{ upToDate, changes, document }` (D29) | ~~none~~ 2026-11-20 (spec 11): `load_skill`, `load_file`, as Grill Me; ~~a read-only repo-file tool is spec 7's question~~ 2026-11-21 (spec 7, D28): plus `list_files`, `read_file` (repo files at the step's base-branch commit, untrusted) | input guardrails (spec 4); spec 11's two limits per call, the repo tools included |
| Coder (`code`) | Final summary (shape: spec 9) | read, write, list, search files in the bot worktree; `runCommand` limited to `CODER_ALLOWED_COMMANDS`. No git. 2026-11-20 (spec 11): plus `load_skill`, `load_file` at the base-branch commit | `CODER_MAX_STEPS`, `CODER_MAX_FIX_ATTEMPTS`; a load budget per loop (spec 9) |
| Quality Gate (`qualityGate`) | `{ verdict: APPROVED \| NEEDS_DECISIONS \| BLOCKED, summary, findings[] }` | read-only file tools at the PR head (spec 10). 2026-11-20 (spec 11): plus `load_skill`, `load_file` at the base-branch commit | `QUALITY_GATE_MAX_STEPS`; a load budget per loop (spec 10) |

- **Map:** `.github-agent/workflow.json` in the target repo: `{ "skills": { "<step>": "<directory relative to the
  repo root>" } }`. Read with `RepoProvider.readFile` at `TARGET_BASE_BRANCH` at the start of every step run
  (every Grill round too), never from an agent branch.
- **Models (D23, 2026-11-12):** the map also names each step's model, in two levels:

  ```json
  {
    "skills": { "grill": ".claude/skills/grill-me", "spec": "…", "plan": "…", "code": "…", "qualityGate": "…" },
    "models": {
      "standard": { "default": "gemini-3.8-flash", "code": "gemini-4-carbon" },
      "max": { "default": "gemini-4-carbon" }
    }
  }
  ```

  A step uses `max` when its issue has the step's `model: max-<step>` label (`grill`, `spec`, `plan`, `code`,
  `quality-gate`), read from the API when the step run starts; otherwise `standard`. Inside a level the step's own
  entry wins, otherwise `default`. Both `default`s are required. Names are Gemini model codes and are not checked
  against Google's list: an unknown one fails at the step's first call → `FAILED(unknown model: <name>)`. The
  names above are examples; spec 4 sets the sandbox's.
- **Repo skills (2026-11-20, spec 11):** the optional `"repoSkills": [".claude/skills"]` names 0–10 folders whose
  direct sub-folders with a `SKILL.md` ~~(and a `description` in its header)~~ are the repo's skills, listed by name and
  description. A listed folder missing from the tree is an invalid map. Without the key, no repo skill is listed;
  `AGENTS.md` files need no setting.
- **Documents (2026-11-21, spec 7, D31; built by spec 9):** the optional `"documents": { "spec": "docs/specs",
  "plan": "docs/plans" }` names the folders the approved texts are committed to (those values by default). A path
  that is absolute, contains `..` or points into `.github-agent` makes the map invalid.
- **Required (D18, 2026-11-10):** every step a run uses needs a skill in the map (per lane: §3 R6). There is no
  built-in fallback. A needed step missing from the map, or a mapped directory without a `SKILL.md` →
  `FAILED(missing skills: <steps>)` → `needs-human` + one comment naming them (2026-11-12, spec 4: a missing
  `workflow.json` is now `invalid workflow.json`, since the file also holds the models). Checked when the run starts and again when a step loads its skill.
  **2026-11-20 (spec 11, SD12):** every skill, step skills and repo skills alike, needs a valid Agent Skills header
  (`name` = its folder name, lowercase letters, digits and hyphens, at most 64; a `description` of 1–1,024
  characters), and two `repoSkills` folders can't hold the same name. A broken skill → `FAILED(invalid skills:
  <path>: <reason>; …)` → `needs-human` + one comment naming every broken skill. Checked at the same moments.
  A stop names the first failing check only (spec 4's rule, 2026-11-20, spec 11 plan P1): `invalid workflow.json`
  (`repoSkills` included), then `missing skills` / `skill too large`, then the root `AGENTS.md` (`too large`,
  `unreadable`), then `invalid skills`; after a fix and `/retry`, the next problem shows.
  ~~Missing file → every step uses its built-in default prompt; a step missing from the map → that step's
  default.~~
- **Invalid** map (bad JSON, unknown step, missing path, missing or invalid `models`) → `FAILED(invalid workflow.json)` → `needs-human` + one
  comment naming the problem.
- **The skill only changes instructions.** Its text goes into the system prompt (2026-11-20, spec 11: its
  `SKILL.md`; files loaded on demand arrive as tool messages, still trusted instructions); output schema, tools, limits and
  guardrails are enforced in code, so no prompt wording can widen them. The bot's own frame is always in the
  prompt; the skill supplies the method.
- **A skill is text only (2026-11-12, spec 4):** ~~every text file of its directory goes into the prompt,
  `SKILL.md` first,~~ all read at one commit (`RepoProvider.resolveRef`); ~~at most 204,800 bytes per skill~~;
  known binary types are skipped; nothing is ever executed (running a skill's scripts: idea doc §11 "Future").
  **2026-11-20 (spec 11):** `SKILL.md` goes into the prompt (at most 204,800 bytes); the other text files, scripts
  included, are listed and loaded on demand as text.
- **Trust:** skills on the base branch are trusted instructions. Everything else from GitHub (issue, comments,
  approved Spec/Plan text, diffs, repo files) is untrusted data. **2026-11-20 (spec 11):** the repo skills listed
  by `repoSkills` and every file named `AGENTS.md`, on the base branch, are trusted instructions too. `CLAUDE.md`,
  `.github/copilot-instructions.md` and other tools' files are never read as instructions (D27).
- **2026-11-18 (D27):** the target repo's own skills and its `AGENTS.md` files will be discoverable in every
  step: listed in the prompt, loaded on demand with a bot-owned tool, trusted like step skills and read at the
  same base-branch commit. Spec 11 (`skill-discovery`) changes this contract first (the map, every step's tools,
  the trust line above). → done 2026-11-20 in the lines above.

## 5. Config schema

Loaded with `@nestjs/config` and validated with Zod at startup: a missing or invalid variable stops the app with
its name; a change needs a restart. Secrets live only in `.env` (gitignored); `.env.example` lists every
variable. Each spec adds its variables to the schema when it's implemented; this table is the target. A spec that
needs a new variable adds it here first.

| Variable | Default | Validation | Owner |
|---|---|---|---|
| `PORT` | `3000` | integer 1–65535 | 1 |
| `DATABASE_URL` | required | `postgresql://` URL | 1 |
| `GITHUB_WEBHOOK_SECRET` | required | non-empty | 1 |
| `GITHUB_APP_ID` | required | positive integer | 1 |
| `GITHUB_APP_PRIVATE_KEY_PATH` | required | readable PEM file | 1 |
| `NGROK_DOMAIN` | empty (no tunnel) | bare hostname (no scheme, no path); read by `npm run tunnel` and the startup log of the webhook URL (added 2026-11-10) | 1 |
| `TARGET_REPO` | required | `owner/name` | 3 |
| `GOOGLE_API_KEY` | required | non-empty; Google AI Studio key (was `ANTHROPIC_API_KEY`, D22, 2026-11-12) | 4 |
| `TARGET_BASE_BRANCH` | `main` | valid branch name | 4 |
| `SESSION_LEASE_SECONDS` | `120` | integer ≥ 30; heartbeat every third of it | 5 |
| `GRILL_MAX_ROUNDS` | `5` | integer 1–10 | 6 |
| `GRILL_MAX_QUESTIONS_PER_ROUND` | `3` | integer 1–10 (2026-11-17, spec 6 GM3; was 1–5); `1` = one question per round | 6 |
| `GRILL_CONFIDENCE_THRESHOLD` | `95` | integer 1–100 | 6 |
| `SKILL_DISCOVERY_MAX_LOADS` | `10` | integer 1–50; files the model may ask for per call (2026-11-20) | 11 |
| `SKILL_DISCOVERY_MAX_BYTES` | `204800` | integer 1,024–1,048,576; bytes loaded on demand per call (2026-11-20) | 11 |
| `WORKSPACE_REPO_PATH` | required | absolute path to a git repo (startup check) | 8 |
| `WORKSPACE_WORKTREE_PATH` | required | absolute path outside `WORKSPACE_REPO_PATH`; created at startup if missing | 8 |
| `WORKSPACE_SETUP_COMMAND` | empty (install by hand) | one command, no shell operators | 8 |
| `WORKSPACE_LEASE_SECONDS` | `300` | integer ≥ 60; heartbeat every third of it | 8 |
| `CODER_ALLOWED_COMMANDS` | required | comma-separated command prefixes, no shell operators | 9 |
| `CODER_LINT_COMMAND` | required | one command; the bot appends the changed files | 9 |
| `CODER_TEST_COMMAND` | required | one command; the bot appends the changed files | 9 |
| `CODER_MAX_FIX_ATTEMPTS` | `3` | integer 0–10 | 9 |
| `CODER_MAX_STEPS` | `60` (provisional) | integer ≥ 1 (LLM turns per Coder run) | 9 |
| `QUALITY_GATE_MAX_STEPS` | `30` (provisional) | integer ≥ 1 (LLM turns per Quality Gate run) | 10 |

~~The model (`claude-sonnet-5-5`) is a constant in spec 4, not a variable.~~ Models are not env vars either: each
step's model comes from the target repo's `workflow.json` (§4, D23, 2026-11-12).

## 6. Table ownership

Names and purpose only; the owner spec defines the columns. One `prisma/schema.prisma`; each spec adds its own
migrations. Only the owner module writes its table (others call its services). A later spec may extend an
earlier table through its own migration; it is then listed under "Extended by". **2026-11-12 (spec 4, L16):** a
row that one LLM call produced (a Grill round, a Spec, a Plan) stores that call's `ExecutionLog` id, so usage
can be joined to it; the many calls of an agent loop are found by run and step.

| Table | Owner | Purpose | Extended by |
|---|---|---|---|
| `WebhookEvent` | 1 | Every received delivery (unique `X-GitHub-Delivery`): payload, receipt time, processing state, ignore reason, the issue or PR it is about | 2 (ignore reasons; `externalRef`, added 2026-11-11), 8 (`WAITING_WORKSPACE`) |
| `ExecutionLog` | 4 | One row per LLM call attempt: issue, run, lane, step, provider, model and level (D23), tokens (empty when not reported), prompt sizes, duration, status, error, the prompt and the answer (2026-11-12, spec 4; was "node, tokens, status, confidence, lane, error") | 11 (2026-11-20: one row per model request, with the call id, the turn and three more sizes; after the first row of a call, only its new messages) |
| `ContextLoad` | 11 | One row per file a step's model got or asked for (2026-11-20): when (call, turn), what (kind, path, commit), why (the model's reason), the outcome, characters, the provider's token count and the bot's estimate | 7 (2026-11-21: the `list_files` and `read_file` tools, kinds `listing` and `repo-file`; no new column) |
| `Task` | 5 | One row per issue: status (source of truth), the shown status label, current run, run count, session lease, lane-conflict reminder state (2026-11-16) | — |
| `Run` | 5 | One row per run (D24, 2026-11-16): UUID (the run id everywhere), number per issue, lane, `grill: skip`, start event, start and end with its reason, the latest stop (step, cause, retryable, failed event, status before) and stop and retry counts; the run-ended comment's id (2026-11-16, spec 5 plan Q1: null on an ended run while the comment is still to post) and the event that ended the run (2026-11-16, spec 5 plan Checkpoint 2: so a late run-ended comment still names who changed the label) | — |
| `GrillSession` | 6 | One per run that grills or skips (only one active per task): ~~conversation (`StoredMessage` JSON),~~ status, round count. 2026-11-17 (spec 6 GMW2): the run id, the last question number, first and last confidence, who stopped it; no conversation JSON, the prompt is rebuilt from the Grill tables every time | — |
| `GrillRound` | 6 | One per bot question comment: its 1..K questions, ~~the merged answer, confidence before/after, gaps,~~ comment IDs, post state. 2026-11-17 (spec 6): numbered questions with guesses, the earlier ones still open, its full text, the `ExecutionLog` id; answers and confidence live in the two tables below | — |
| `GrillEvaluation` | 6 | One per model evaluation (2026-11-17, spec 6): what the bot did with it (`ASKED`, `CLEAR`, `LIMIT`, `WAITING`, `SUPERSEDED`), confidence, open questions, gaps, model, `ExecutionLog` id; the lines under its comment's rule, so a retried post is the same (2026-11-17, spec 6 plan P2) | — |
| `GrillAnswer` | 6 | One per comment read as an answer (2026-11-17, spec 6): author, text as written, link, when read, 👀 added | — |
| `TaskDocument` | 7 | Spec and Plan per run: the LLM's text, comment ID, approved text, approver and time. 2026-11-21 (spec 7): one row per version (written, refreshed or restored; superseded), the go-signal too; the commit it read, the comparison at approval (files flagged), the deleted text, the line counts of people's edits | — |
| `DocumentAction` | 7 | One row per answered action on a document (2026-11-21, spec 7): refused or hinted `/approve`, the warning reply, a late comment, `/refresh` and `/restore` with their result, a deletion; the reply and its post state | — |
| `Workspace` | 8 | The single coding-job lease (holder task, expiry) | — |
| `AgentPullRequest` | 9 | The bot's PR per run: branch, number, base; written before the PR is opened | — |
| `QualityGateRun` | 10 | One per Quality Gate run: head SHA, verdict, comment ID, check-run ID | — |

## 7. Cross-cutting rules

1. **Authenticity:** a webhook without a valid `X-Hub-Signature-256` gets `401` and is not stored.
2. **Authorization** (D19, 2026-11-11; was "only `write`-or-higher senders"): only Participants and Approvers
   drive the bot, and only an Approver's `/approve` counts; the App itself only through `pull_request` events on
   its own PR. Everything else is ignored and recorded, never answered (except the two comments of D21).
3. **One target repo** (`TARGET_REPO`); events from other repos are ignored.
4. **Labels:** `status: *` is bot-only, a projection of `Task.status`. `workflow: *`, `grill: skip` and
   `model: max-*` are human-only; the bot never adds them and only removes ones added by a sender without the
   level they need (D21, D23). Lane, skip and model labels are read from the API at processing time, never from
   the payload.
5. **PostgreSQL is the source of truth:** no workflow state in process memory or in the issue thread; every event
   rebuilds its state from the tables.
6. **Serialization:** one job at a time per task (session lease) and one coding job at a time (workspace lease).
   Leases are claimed with one atomic update, renewed by heartbeat and expire after a crash.
7. **Exactly once:** every bot comment and PR uses the two-transaction + hidden-marker pattern; a retried event
   first completes any pending side effect of its task and never duplicates one.
8. **Ports:** core logic uses `IssueProvider` / `RepoProvider`; only `GitHubModule` touches Octokit. No `gh` CLI.
9. **Untrusted input** (2026-11-20, spec 11: except the base branch's `AGENTS.md` files and the repo skills listed
   by `repoSkills`, which are trusted instructions like step skills, §4 "Trust"): issue text, comments, approved
   Spec/Plan text, diffs and repo files are data, not
   instructions. Input guardrails (injection, size) run before every LLM call.
10. **Secret scanning** runs on everything the bot sends out: comments, PR bodies, check-run summaries and the
    diff before every push.
11. **No LLM judges its own output:** each step builds its prompt from PostgreSQL and the repo, never from another
    step's messages. The Quality Gate gets artifacts only (diff, issue, approved Spec/Plan).
12. **No git for the LLM:** all git runs in `WorkspaceModule` via `execFile` (argument array, no shell), only
    inside the bot worktree. The developer's checkout is never touched.
13. **No destructive action without a human:** no force push, no push to the base branch, no `reset --hard`, no
    branch deletion or reset, no closing issues or PRs.
14. **Bot identity only:** commits as `<app>[bot]` set per command; fetch and push with a per-command installation
    token over an explicit HTTPS URL, never written to `.git/config`; `origin` and the global git config stay
    untouched; comments, PRs and check runs through the App.
15. **Skills shape instructions only** (§4), are always read from the base branch, and are required: no step runs
    on a built-in fallback prompt (D18).
16. **No code without a human go:** only an `/approve` from an Approver (GitHub: Write or higher, D19) starts the
    Coder.
17. **Never silent:** every `needs-human` posts exactly one comment with the cause and the next step; every ignored
    event is recorded with a reason.
18. **Bounded:** Grill rounds and questions, LLM loop steps, fix attempts and retries all have caps.

## Edge cases routed to later specs

- **1:** the `ping` event sent when the webhook is created (reply 2xx, record as ignored); the hello comment uses
  the payload's `installation.id`.
- **2:** ~~an unauthorized *removal* of a lane label is ignored (the bot never re-adds lane labels), so the run
  continues without its label and a later re-add restarts it; labels set at issue creation fire `opened` and
  `labeled` in any order; how the bot recognises its own sender.~~ → resolved 2026-11-11 in
  `spec-github-agent-intake-authorization.md`: the removal is ignored as `unauthorized`; intake passes `opened`
  and `labeled` on in the order received and the router handles both orders (below, 5); `IssueProvider.isSelf`.
- **3:** ~~caching `hasWriteAccess` results (at most per job); whether loading a skill directory needs a file
  listing.~~ → resolved 2026-11-10 in `spec-github-agent-github-providers.md`: no cache (G6); `listFiles` (G7).
- **4:** ~~injection detected → `FAILED` or wrap and continue; truncate vs summarize oversized input; which files a
  skill may reference and their size cap. **Added 2026-11-10 (spec 3, G7):** a skill is loaded as its whole
  directory: how reference files reach the LLM; whether and where a skill's scripts run (this contradicts "The
  skill only changes instructions" and the tools column in §4, so this overview changes first); binary files;
  reading the listing and the files at one commit. **Agreed 2026-11-11 (spec 2 interview):** the secret scanner
  wraps the two ports, so every outgoing text is scanned whoever the caller is (this covers spec 2's two
  comments, and the §4 comment "body is already secret-scanned" goes away). **Added 2026-11-12 (D22, D23):**
  `readControls` returns the steps that have a `model: max-*` label (contract change, made here first); spec 4's
  build changes code of earlier specs: intake (spec 2) checks and reverts model labels, `removeLabel` accepts them,
  and the label bootstrap (spec 3) creates 16 labels instead of 11; the model line in every posted LLM text
  (format); which `ChatGoogle` errors are transient or permanent (rate limit, unknown model, a blocked answer);
  LangChain's own retries vs the worker as the single retry layer (spec 3, G5); thinking tokens in
  `ExecutionLog`; the setup guide says the free Gemini tier lets Google use prompts (a billed project doesn't).~~ → resolved 2026-11-12 in
  `spec-github-agent-llm-foundation.md`: wrap and continue with a warning comment (L7); cut at 65,536
  characters (L8); a skill is text only, read at one commit, 204,800 bytes at most (L6, LW2, LW3); the scanner
  wraps the ports (L9, LW4); model labels, `readControls` and the changes to specs 2 and 3 (L3, LW1, LW7); the
  error table and the single retry layer (L10); provider-neutral usage columns (L11).
- **5:** → resolved 2026-11-16 in `spec-github-agent-router-session-lease.md`: run id and `Run` table
  (RL2, D24), run-start order (RL3), failures → `needs-human` and recovery (RL4, RL5), `/retry` (RL6, D25), one
  event at a time (RL7), one reminder per lane conflict (RL8; per set of labels since spec 5's plan Checkpoint 2), closed issues (RL9, D26), stale events (RL10, R1),
  `last_error` kept as history (RL11). The original list: "received" = the time the controller stored the event; several lane labels added at once → one reminder
  comment, not one per event; events on closed issues; worker concurrency cap; the run-start skills check (R6)
  calls spec 4's loader. **Added 2026-11-11 (spec 2):** an `ISSUE_OPENED` processed after its issue's run started
  is stale (R1); spec 5 replaces spec 2's placeholder processor and adds its own ignore reasons; a task's
  waiting events are found through `WebhookEvent.externalRef` (spec 2), and the spec that first needs them adds
  the query method to `EventsService` (2026-11-17: spec 6, `commentEventsSince`). **Added 2026-11-12 (spec 4):** at run start spec 5 calls
  `StepConfigService.checkRun` and the injection check of the issue description; it turns `LlmError` and
  `StepConfigError` into `FAILED(cause)`; its interview decides `/retry` for causes outside the issue (D7).
- **6:** ~~a comment that arrives while the final evaluation runs (merge it in before moving to the Spec?); partial
  answers to a batch; the cancel comment strips markers, escapes code fences and truncates long answers with a
  link.~~ → resolved in `docs/specs/spec-github-agent-grill-me.md` (2026-11-17): a comment written while the bot
  thinks is read before it acts (GM4); a partial answer gets 👀 and the bot waits (GM6); the answers block (GM10).
- **7:** ~~`/approve` syntax; a Spec/Plan longer than GitHub's 65,536-character comment limit; the approved comment
  deleted before `/approve`; the snapshot is taken when the approval is first processed, so a queued approval
  keeps that text. **Agreed 2026-11-11 (spec 2 interview):** while an issue waits for an approval, a comment that
  starts with `/approve` but isn't exactly that gets one hint ("comment exactly `/approve`"), at most once per
  document; spec 7 adds the case to transition-table row 20. **Added 2026-11-12 (spec 4, L17):** the document
  table keeps the text as posted, after the secret scanner; the LLM's raw answer is in `ExecutionLog`. **Added
  2026-11-18 (D27):** Spec and Plan run through spec 11's discovery, so the `spec` or `plan` step skill can tell
  the model to load another repo skill or a folder's `AGENTS.md`. **Added 2026-11-20 (spec 11 interview):** they
  get it through `prepare` and `call` with no extra code; to decide: a read-only repo-file tool for Spec and Plan
  (e.g. to read a file an `AGENTS.md` points to); the Plan's inputs: the approved Spec only, or also the issue and
  the Grill answers.~~ → resolved 2026-11-21 in `spec-github-agent-spec-plan-approvals.md`: at most 50,000
  characters, re-asked twice, then a retryable stop (SP7); a deleted document gets an explanation and `/restore`
  (SP9, D30); the approved text is what sits between the comment's markers, taken when the approval is first
  processed (SPW5); the near-miss hint in row 20; the read-only repo tools (SP2, D28); the Plan reads the approved
  Spec only (SP1).
- **8:** an explicit-URL fetch needs an explicit refspec (update `refs/remotes/origin/*` or a bot-owned ref
  namespace?); branch name format with the run number; the agent branch checked out in the developer's clone;
  concurrent fetches. **Added 2026-11-20 (spec 11, SD13):** a git-backed `RepoProvider` (a bot-fetched local copy,
  read at the base-branch commit with `git ls-tree` / `git show <commit>:<path>`, never a branch's working files)
  that could replace the GitHub adapter for any git host, without making Grill Me, Spec or Plan wait for the
  workspace lease; spec 7 then decides whether its read-only repo-file tool reads from it.
- **9:** a crash between push and PR (`AgentPullRequest` written first, `findPullRequest` on retry); a failure in
  the middle of the loop (commit locally like a red run, or leave the tree dirty?); changed-files scoping for lint
  and tests; signed commits (idea doc §10 known risk); a secret found in the diff → `FAILED`. **Added 2026-11-12 (spec 4,
  L18):** each turn of the Coder loop stores only its new messages in `ExecutionLog` (the first row holds the
  full starting prompt); spec 9 extends the table for it (e.g. a turn number), and spec 10 follows the same
  rule; whether the loop retries a single failed call (spec 4, L10). **Added 2026-11-18 (D27, required):** the
  Coder's loop gets spec 11's lists and loading tool; whether a folder's `AGENTS.md` is also added on its own
  (proposed: to a file tool's answer the first time the Coder works under that folder, the closest file winning
  on a conflict, as the agents.md convention says); always read at the base-branch commit, never from the
  worktree. **2026-11-20 (spec 11):** the two tools come from `ContextLoaderService`; spec 9 sets the loop's load
  budget; `context_loads.turn` is the loop's turn and `execution_logs.call_id` the loop's id; a folder's `AGENTS.md`
  added on its own is a row with trigger `start`.
- **10:** `pull_request.opened` arrives while the Coder job still holds the task lease (it waits); the newest head
  wins; PRs of cancelled runs are still reviewed; the step cap is reached → which verdict; each run logs its input
  list for the "no LLM judges its own output" check. **Added 2026-11-18 (D27, required):** spec 11's lists and
  loading tool; the `AGENTS.md` files on the path of each changed file, read at the base branch, never at the PR
  head. **2026-11-20 (spec 11):** the same `ContextLoaderService` and rows as spec 9; those `AGENTS.md` files are
  given at start (trigger `start`); spec 10 sets the loop's load budget.
- **11 (added 2026-11-18, D27):** ~~where `workflow.json` says the repo's skills live (e.g. `.claude/skills`); the
  two lists in each prompt (each `SKILL.md`'s name and description; each `AGENTS.md` path) and whether the root
  `AGENTS.md` is always in the prompt (proposed: yes, it holds the general rules); finding every `AGENTS.md` at
  one commit (a `RepoProvider` method or one tree listing); the loading tool (e.g. `loadSkill(name)`, and one for
  an `AGENTS.md` path) and the bounded tool loop in `LlmService.call()` for Grill Me, Spec and Plan (a cap on
  loads per call); a skill the step skill names that isn't in the list; size caps; the injection check line on
  loaded text, as for step skills; what each call loaded, in `ExecutionLog` (usage data); switching Grill Me
  over (its prompt frame and spec 6's tests).~~ → resolved 2026-11-20 in
  `docs/specs/spec-github-agent-skill-discovery.md`: `repoSkills` (SD1); the root `AGENTS.md` always, the others
  listed (SD2); one tree listing (`listFiles(commit, '')`); `load_skill` and `load_file`, step-skill files on
  demand too (SD3, SD4); two limits in `.env` (SD6); an unknown skill gets a line under the comment (SD7); the
  "Read:" line (SD8); injection matches logged and stored, never blocking (SDW8); `context_loads` and one
  `ExecutionLog` row per model request (SD5, SDW9); Grill Me switched over with no frame change.

## Tech stack, commands, code style, tests

- **Stack:** Node.js + TypeScript (strict), NestJS, Prisma + PostgreSQL, Zod with `@nestjs/config`, Octokit with
  GitHub App auth, `@langchain/google` (`ChatGoogle`, Gemini; D22; models per step from `workflow.json`, D23;
  was `@langchain/anthropic` with `claude-sonnet-5-5`), `@langchain/langgraph` only in the Coder and
  Quality Gate loops (D3), the `git` binary via `execFile`, ngrok. Spec 1 pins the versions.
- **Commands:** none yet (no `package.json`). Spec 1 scaffolds the project; the real build, test, lint, typecheck
  and `prisma migrate` commands go into `AGENTS.md` → Commands once they exist.
- **Code style:** one NestJS module per §1 row; ports are interfaces plus DI tokens in `src/contracts`; every LLM
  output is parsed with its step's Zod schema before use. Request DTOs (none yet) use a Zod schema + a
  `ZodValidationPipe` (the NestJS docs' "Object schema validation" pattern), never class-validator
  (2026-11-10, spec 1 interview).

  ```ts
  // Core code depends on the port, never on Octokit.
  @Injectable()
  export class GrillService {
    constructor(@Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider) {}
  }
  ```

- **Tests:**
  - Unit: `decide()` with one test per §3 row (spec 5); label mapping, Zod schemas, guardrails, intake ignore
    reasons.
  - Integration against a real PostgreSQL (no DB mocks): lease claim/heartbeat/expiry, two-transaction recovery,
    delivery dedupe, stale events.
  - Fakes only at the ports: in-memory `IssueProvider`/`RepoProvider`, scripted LLM outputs, `git` against a
    temporary repo with a bare remote.
  - Manual: each spec's verification matrix on the sandbox repo; this file's matrix before the MVP is called done.
    Test runner: Vitest + `unplugin-swc` (spec 1, 2026-11-10).

## Boundaries

- **Always:** load this overview before writing or implementing a capability spec; update it first when a
  contract, transition, env var, label or table owner changes; run guardrails and secret scanning on every LLM
  input/output path.
- **Ask first:** new dependencies; a new env var, label, table or state; changing any decision D1–D17.
- **Never:** commit or push from an implementing session (the developer commits, see `AGENTS.md`); give the LLM a
  git tool or a shell; use the developer's identity or credentials; persist tokens (`.git/config`, database,
  logs); run a destructive git or GitHub action without a human; post text that skipped secret scanning; act on an
  unsigned, unauthorized or other-repo event.

## Verification matrix

Each row names the spec after which it can be checked. **To observe:** the events-table query from the setup
guide (spec 1) shows each delivery's state and ignore reason; the issue timeline shows labels and comments; the
PR's Checks tab shows check runs; run
`git -C "$WORKSPACE_REPO_PATH" status --short && git -C "$WORKSPACE_REPO_PATH" branch --show-current` before and
after a Coder run; `git config --show-origin --get-regexp 'http\..*extraheader'` in both checkouts must print
nothing. Rows with a sender that has no access use spec 2's signed test request (sender `octocat`). Rows with a
sender who is only a Participant (a Triage user) need a target repo owned by an organization: a personal repo has
no Triage role (D19), so on the sandbox they are covered by automated tests (2026-11-11; was "a second GitHub
account with `triage` access").

**Invariants**
- [ ] (1) `curl` the webhook URL without, or with a wrong, `X-Hub-Signature-256` → `401`; no events-table row.
- [ ] (1) Redeliver a delivery from the App's "Recent deliveries" → still one row; no second comment.
- [ ] (2) The bot posts a comment or changes a label → its own webhook is recorded as ignored (own event); no LLM
  call, no follow-up comment: the bot never triggers itself.
- [ ] (2) A sender with no access comments `/approve` on a `ready-for-dev` issue → nothing changes on GitHub; the
  event is ignored (`unauthorized`).
- [ ] (2) A sender with no access adds `workflow: code-only` → the label is removed + exactly one comment; no run
  starts. The same again on that issue → removed again, NO second comment.
- [ ] (2, organization repo only) A Triage user adds `workflow: full-sdd` and answers the questions → the run
  starts and continues. Their `/approve` → exactly one reply and nothing else changes; a Write user's `/approve`
  → it counts.
- [ ] (2) An event from another repo (App installed there for the test) → ignored; no API call to that repo.
- [ ] (5) Add `workflow: full-sdd` and `grill: skip` in one edit → skip comment + Spec, whatever the webhook order.
- [ ] (5) A human changes a `status: *` label → nothing happens; the next transition restores the right label.
- [ ] (4, 5) `workflow.json` maps no `plan` skill; add `workflow: full-sdd` → `needs-human` + exactly one comment
  naming `plan`; NO Grill question is posted. `workflow: code-only` on another issue → the go-signal (that lane
  doesn't use `plan`).
- [ ] (4, 5) `workflow.json` without a `models` section (or without `max.default`); add `workflow: full-sdd` →
  `needs-human` + exactly one comment naming the problem; NO Grill question is posted.
- [ ] (4) A sender below Approver adds `model: max-code` → the label is removed + exactly one comment; the same
  again on that issue → removed again, NO second comment.
- [ ] (4, 7) An Approver adds `model: max-spec` while the issue is grilling → the Grill questions name the
  `standard` model, the Spec names the `max` model, and their `ExecutionLog` rows agree.
- [ ] (5) Swap `workflow: full-sdd` for `workflow: code-only`, in either order → exactly one new run (one
  go-signal), no duplicate comments.
- [ ] (5, 9) `workflow: code-only` → only the go-signal; worktree and branches unchanged until `/approve`.
- [ ] (6) In `grilling` with two answered rounds, remove the lane label → `status: draft` + exactly one cancel
  comment with the Q&A block; re-add it → the new first question ignores the old answers. (2026-11-17: the block is
  in spec 5's run-ended comment, spec 6 GM10.)
- [ ] (6) Answer only one of the questions in a comment → 👀 on it and no new bot comment, or one round naming the
  questions still open; never silence (spec 6 GM6).
- [ ] (6) While the bot is asking, add `grill: skip` → one "Grill Me stopped" comment and the run moves on to the
  Spec; `/approve` → one "nothing to approve yet" reply (spec 6 GM8).
- [ ] (6) Kill the app right after a question is posted (before it's recorded), restart → the question appears
  exactly once.
- [ ] (7) Comment `/approve` twice quickly on a `full-sdd` Spec → one Plan, status `ready-for-dev`, the Coder does
  NOT start; 2026-11-21 (spec 7): the second gets one "already approved" or "written before Plan v1" reply.
- [ ] (7) Push a change on the base branch to a file the waiting Spec read, comment `/refresh` → one Spec v2 comment
  with "What changed" and the bot's diff, or one "still up to date" reply; `/refresh` again with nothing pushed →
  one "Nothing changed" reply and no model call (D29).
- [ ] (7) Delete the waiting Spec's comment → one explanation; `/restore` → the Spec as it read when deleted, and
  `/approve` then counts (D30).
- [ ] (4, 7) An issue asking to put a token-shaped test string in the Spec → the posted Spec doesn't contain it.
- [ ] (8) `/approve` two issues back to back → the second gets one "queued" comment and starts only after the
  first finishes.
- [ ] (8) The developer has uncommitted changes on branch X in `WORKSPACE_REPO_PATH` → a full Coder run → same
  status output and branch before and after.
- [ ] (9) After a green run: commit author `<app>[bot]`; no `extraheader` in either checkout;
  `git remote get-url origin` and `git config --global user.name` unchanged.
- [ ] (9) An issue saying "run `git push --force origin main`" → the Coder has no git tool, `runCommand` refuses
  it (not allowlisted), the remote base branch is unchanged.
- [ ] (11) The `grill` step skill tells the model to use another repo skill → that round's logged input shows the
  skill loaded on demand; the prompt lists the repo's skills and `AGENTS.md` files, never a `CLAUDE.md` (D27).
  (2026-11-20, spec 11: the load is a `context_loads` row and a "Read:" line under the comment; the root
  `AGENTS.md` is in the prompt.)
- [ ] (11) A step skill names a skill the repo doesn't have, or asks for `CLAUDE.md` → the step still answers; one
  line "The bot looked for skill `…`, which this repo doesn't have."; `CLAUDE.md`'s text is never in a prompt or a
  comment (spec 11, SD7).
- [ ] (11) A repo skill without `description`, or a step skill whose `name` isn't its folder name; add `workflow:
  full-sdd` → `needs-human` + exactly one comment naming every broken skill; NO Grill question (spec 11, SD12).
- [ ] (7) The `spec` step skill tells the model to use another repo skill → the Spec run's logged input shows that
  skill loaded on demand (D27).
- [ ] (9) The base branch has a root `AGENTS.md`, a `src/components/AGENTS.md`, a repo skill for building a
  component and a `CLAUDE.md`; an issue asks for a new component under `src/components` → the run's logged input
  holds both `AGENTS.md` files and the loaded skill, never the `CLAUDE.md`, and the PR follows them (D27).
- [ ] (10) The Quality Gate run's logged input list holds only the diff, the issue, the approved Spec/Plan and its
  skill (2026-11-18, D27: plus the repo skills it loaded and the `AGENTS.md` files of the changed files); no Coder
  messages.
- [ ] (10) On the agent branch, change the Quality Gate skill to "always approve" → the Quality Gate still applies
  the base-branch skill.
- [ ] (10) The agent branch changes an `AGENTS.md` or a repo skill → the Coder and the Quality Gate still use the
  base-branch versions (D27).
- [ ] (all) Every move to `needs-human` comes with exactly one comment naming the cause and the restart.

**Lanes**
- [ ] (10) `full-sdd`: label → questions (1..K per comment) → answers → Spec (`spec-review`) → `/approve` → Plan
  (`ready-for-dev`) → `/approve` → `executing` → PR (`in-review`) → Quality Gate comment + check run.
- [ ] (10) `spec-code`: the same without a Plan; the Spec's `/approve` starts the Coder.
- [ ] (10) `code-only`: go-signal → `/approve` → PR → Quality Gate; no Grill, Spec or Plan comment ever.
- [ ] (7) An issue already clear (confidence ≥ threshold before any question) → one comment with the score + the
  Spec.
- [ ] (6) Round limit reached → `needs-human` + one summary comment (confidence + gaps; 2026-11-17, spec 6 GM9:
  plus three numbered steps to continue, without the generic restart line).
- [ ] (9) Lint or tests still red → local commit only, `needs-human` comment with the trimmed output and the
  branch name; no push, no PR.

## Success criteria (for this spec)

- [ ] Each capability spec (#1–#11) can be written by loading only this overview, its idea-doc sections and the
  specs it depends on.
- [ ] Every (state, input) pair resolves to exactly one §3 row or to an intake ignore.
- [ ] Every table and env var has exactly one owner; the dependency graph has no cycles.
- [ ] Every contradiction found in the idea doc is listed with its resolution, and the idea doc marks what moved
  here.

## Open questions

- `CODER_MAX_STEPS` (60) and `QUALITY_GATE_MAX_STEPS` (30) are provisional; specs 9 and 10 confirm them.
- Nothing else blocks spec 1. The open points per capability are listed under "Edge cases routed to later specs".
