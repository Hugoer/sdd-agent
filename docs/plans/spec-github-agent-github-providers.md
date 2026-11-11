# Implementation Plan — Spec #3: GitHub Providers

> **Created:** 2026-11-10 · **Status:** approved 2026-11-11 (including P1–P9) · built and verified 2026-11-11
>
> **Why this file exists:** turns the approved spec `docs/specs/spec-github-agent-github-providers.md` into
> ordered, verifiable tasks (skill `agent-skills:planning-and-task-breakdown`). The spec stays normative: this plan
> adds order, slicing and build-time decisions only. The task checklist lives here (repo placement rules override
> the skill's `tasks/todo.md`).
>
> **Also read:** `docs/specs/spec-github-agent-architecture-overview.md` §4 (contracts) and §7 (rules).

## Overview

Replace spec 1's hello client with `GitHubModule`: App auth on `TARGET_REPO`, fail-fast startup with the label
bootstrap, every `IssueProvider` and `RepoProvider` method, a neutral `ProviderError`, the hello comment through
the port, in-memory fakes for later specs and a dev-only smoke script. Built in 16 tasks across 4 phases. Real
GitHub is reached at the end of phase 1, so the main external risk is tested first. You review the work and commit
at each checkpoint (I never commit).

## Build-time decisions (not in the spec; please confirm)

| # | Decision | Why |
|---|---|---|
| P1 | `GitHubClient` takes an optional `GITHUB_CLIENT_OPTIONS` value (`{ fetch?, timeoutMs? }`, injected with `@Optional()`). Production doesn't provide it. Unit tests build the client directly with a scripted `fetch` (`test/fakes/fake-github-fetch.ts`) and an RSA key generated in the test. | Spec G13 (fake `fetch`, no new package) needs one seam; this one adds no test-only branch to the code. |
| P2 | Errors are mapped in one place: `GitHubClient.request()` throws `ProviderError`, `requestOrNull()` turns a `404` into `null`. The timeout wraps `fetch` with a new `AbortSignal.timeout` per request. | `@octokit/request` reports a network failure or an abort as status `500` **without a response** (checked in `node_modules`), so "no response" and a real `5xx` are told apart once, there. |
| P3 | Integration harness (`test/app.ts`): `ISSUE_PROVIDER` and `REPO_PROVIDER` are replaced by the fakes and `GitHubClient` by a stub that sends nothing. The real `GitHubStartup` still runs. | Tests stay offline, and "startup calls `ensureLabels()` once, before the worker" is tested. |
| P4 | `vitest.config.ts` also includes `test/fakes/**/*.spec.ts`. | The spec puts the fakes in `test/fakes/` and wants them unit-tested; today the unit run only sees `src/`. |
| P5 | `src/contracts` has three files: `issue-provider.ts` and `repo-provider.ts` (types + DI token each) and `provider-error.ts`. | Small and easy to find. `StepName` / `StepSkill` join with spec 4. |
| P6 | `github:smoke` = `nest build && node dist/github/smoke/github-smoke.js`. `nest build` empties `dist/`, so the smoke runs with the app stopped. The checks live in a `runSmoke(issues, repo, options, print)` function, unit-tested against the fakes. | NestJS decorators can't run through Node's type stripping, so the script must be compiled. Testing the runner on the fakes finds script bugs before it writes to the sandbox. |
| P7 | Unknown ref: `readFile` reads GitHub's `404` message (`No commit found for the ref …` against `Not Found`; both seen on the sandbox on 2026-11-10). `listFiles` learns it from its first call (`GET …/commits/{ref}`). | Spec A3 without an extra request. If GitHub changes the wording, the smoke check "missing ref → error" fails, so it can't go unnoticed. |
| P8 | `readFile` uses the Contents API's default JSON form (base64, files up to 1 MB) and decodes with `TextDecoder('utf-8', { fatal: true })`. | The JSON form says what the path is (file, directory, submodule) and gives the spec's 1 MB limit for free. |
| P9 | A startup failure is a `GitHubStartupError`. `main.ts` prints its message without a stack trace and exits with code 1. | Spec: "one message". Today an error during boot prints a stack. |

## Dependency graph

```text
T1 contracts + TARGET_REPO
 ├── T2 in-memory fakes ───────────────────────────────┐
 └── T3 GitHubClient (auth, requests, errors, timeout) │
        └── T4 labels + ensureLabels + readControls    │
               └── T5 startup checks + messages        │
                      └── T6 GitHubModule wired in ────┘ (the test harness needs T2)
                             └── T7 issue read + comment methods
                                    └── T8 hello through the port
                                           └── T9 worker: permanent + rate-limit errors
                                                  └── T10 issue labels + permissions
                                                         └── T11 smoke script (issue checks)
                                                                └── T12 readFile + listFiles
                                                                       └── T13 getPushCredentials
                                                                              └── T14 PR + check run
                                                                                     └── T15 docs → T16 matrix
```

T12, T13 and T14 don't depend on each other, but they edit the same files, so they run one after another.

**Your part (the build stops for these):**

1. **After T1:** add `TARGET_REPO=Hugoer/sdd-agent-sandbox` to `.env` (I don't edit your `.env`).
2. **Before Checkpoint 3** (the labels exist after Checkpoint 1), in the sandbox repo:
   - open a test issue and add the labels `grill: skip` and `bug`;
   - from your clone, push to `main` a directory `smoke-skill/` with `SKILL.md`, `references/a.md` and
     `scripts/run.sh` (`git update-index --chmod=+x smoke-skill/scripts/run.sh`);
   - in the GitHub UI, create the branch `smoke/spec-3` from `main` and commit one small edit on it.
3. **T16:** the Wi-Fi rows and the redelivery, one step per message.

---

## Phase 1 — Contracts, client and startup (real GitHub first)

### Task 1: Contracts and `TARGET_REPO`

**Description:** `src/contracts` (P5) with the overview §4 types the providers need, `ProviderError` and the
tokens `ISSUE_PROVIDER` / `REPO_PROVIDER`. `TARGET_REPO` joins the env schema, `.env.example` and the test
environment.

**Acceptance criteria:**
- [x] The types match overview §4 signature by signature (including `listFiles` and `RepoFile`); the folder has no
  logic besides the `ProviderError` constructor
- [x] `TARGET_REPO` missing or not `owner/name` → the env error names it (unit-tested)

**Verification:**
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass
- [x] Manual: after you add `TARGET_REPO` to `.env`, `npm run dev` starts as before

**Dependencies:** None
**Files:** `src/contracts/issue-provider.ts`, `src/contracts/repo-provider.ts`, `src/contracts/provider-error.ts`,
`src/config/env.schema.ts` (+ `.spec.ts`), `.env.example`, `test/test-env.ts`
**Scope:** M (small files)

### Task 2: In-memory fake providers

**Description:** `InMemoryIssueProvider` and `InMemoryRepoProvider` in `test/fakes/`: the full contracts with the
spec's rules, helpers to seed issues, labels, comments, collaborators and files, a call log, and `failNext(error)`.
Unit run widened to `test/fakes/` (P4).

**Acceptance criteria:**
- [x] Same rules as the spec's tables: the marker matches only bot comments (oldest first); a status label is
  added then the others removed, other labels kept; the `removeLabel` guard; `null` results; `listFiles` recursion;
  one check run per commit; `findPullRequest` returns only bot PRs
- [x] `failNext()` makes the next call reject with the given `ProviderError`; every call is recorded

**Verification:**
- [x] `npm test` runs the fakes' specs and passes

**Dependencies:** T1
**Files:** `test/fakes/in-memory-issue-provider.ts` (+ `.spec.ts`), `test/fakes/in-memory-repo-provider.ts`
(+ `.spec.ts`), `vitest.config.ts`
**Scope:** M

### Task 3: `GitHubClient`

**Description:** The only Octokit import. `App` built on an `Octokit` with the retry and throttling plugins off
and the options seam (P1). `connect()` finds the installation of `TARGET_REPO` (App JWT) and keeps the
installation client. `target(task)` and its PR twin parse the reference and refuse another repo. `request()`,
`requestOrNull()` and a paginating helper map every failure to `ProviderError` (P2) with a 30 s timeout. Writes
are logged without bodies. Includes the scripted fake `fetch` helper for all later adapter tests.

**Acceptance criteria:**
- [x] Every row of the spec's error table maps as written, including `retryAfterSeconds` from `retry-after` and
  from `x-ratelimit-reset`; the message holds method, route, status and GitHub's message, nothing else
- [x] A `500` on a write → exactly one request; a request that never answers → `transient` after the timeout
- [x] A `TaskRef` or `PullRequestRef` outside `TARGET_REPO` → permanent error with zero requests

**Verification:**
- [x] `npm test` (client spec), `npm run typecheck`, `npm run lint` pass

**Dependencies:** T1
**Files:** `src/github/github-client.ts` (+ `.spec.ts`), `test/fakes/fake-github-fetch.ts`
**Scope:** M

### Task 4: Labels, `ensureLabels` and `readControls`

**Description:** `labels.ts` with the 11 label definitions and the label name ↔ `Lane` / `TaskStatus` mapping.
`GitHubIssueProvider` starts with `ensureLabels()` and the pure `readControls()`.

**Acceptance criteria:**
- [x] Exactly the missing labels are created with the spec's name, color and description; names are compared
  case-insensitively; two pages of existing labels are read
- [x] No `PATCH` or `DELETE` is ever sent; a `422` "already exists" counts as present
- [x] `readControls`: no lane, one, two (fixed order), skip, letter case, unknown `workflow: *` ignored

**Verification:**
- [x] `npm test` passes

**Dependencies:** T3
**Files:** `src/github/labels.ts`, `src/github/github-issue.provider.ts` (+ `.spec.ts`)
**Scope:** S

### Task 5: Startup checks and failure messages

**Description:** `connect()` gains the permission check (A1) and the bot identity (login, user ID).
`GitHubStartup.onModuleInit()` runs connect → `ensureLabels()` → the ready line (two log lines in all, spec updated 2026-11-11), and turns each failure into a
`GitHubStartupError` with the spec's message (P9).

**Acceptance criteria:**
- [x] Each cause in the spec's startup table gives its message (unit-tested): `401`, `404`, missing permissions
  (named), `403` on label creation, no response / `5xx`
- [x] No message or log line holds a token, the JWT or the key
- [x] No retry: each failing call is sent once

**Verification:**
- [x] `npm test` passes

**Dependencies:** T4
**Files:** `src/github/github-client.ts` (+ `.spec.ts`), `src/github/github-startup.ts` (+ `.spec.ts`)
**Scope:** M

### Task 6: `GitHubModule` wired into the app

**Description:** `GitHubModule` provides the client, the startup and `ISSUE_PROVIDER`, and exports the token.
`EventsModule` imports it. `main.ts` prints a `GitHubStartupError` as one line and exits with code 1. The
integration harness boots offline (P3). The old hello client still posts the hello until T8.

**Acceptance criteria:**
- [x] The app listens and the worker starts only after startup succeeded; on failure: exit code 1, port closed
- [x] Integration tests boot with the fakes: `ensureLabels` called once, no request to GitHub
- [x] All spec 1 integration tests still pass

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass
- [x] Manual (real GitHub): `npm start` → the log names `<app>[bot]`, the repo and "11 created"; the sandbox's
  Labels page shows the 11 labels

**Dependencies:** T2, T5
**Files:** `src/github/github.module.ts`, `src/events/events.module.ts`, `src/main.ts`, `test/app.ts`,
`test/github-startup.integration.spec.ts`
**Scope:** M

### Checkpoint 1 — Startup on real GitHub
- [x] `typecheck`, `lint`, `test`, `test:integration` green
- [x] The 11 labels exist in the sandbox with the spec's colors and descriptions; the repo's own labels unchanged
- [x] `TARGET_REPO=Hugoer/sdd-agent` → the app exits with the "not installed" message; port closed
- [x] Opening an issue still gets the hello (old client)
- [x] You review and commit

---

## Phase 2 — Hello through the port

### Task 7: Issue read and comment methods

**Description:** `getTaskDetails`, `postComment`, `getComment` and `findCommentByMarker` on
`GitHubIssueProvider`.

**Acceptance criteria:**
- [x] Requests and mappings as in the spec's table (IDs as strings, `''` for a null body, `createdAt` as a `Date`);
  the comment body reaches GitHub unchanged
- [x] `getComment` → `null` for a `404` and for a comment of another issue
- [x] `findCommentByMarker` reads all pages, returns the oldest comment written by the App, ignores a human
  comment holding the marker; an empty marker throws

**Verification:**
- [x] `npm test` passes

**Dependencies:** T6
**Files:** `src/github/github-issue.provider.ts` (+ `.spec.ts`)
**Scope:** S

### Task 8: Hello through `ISSUE_PROVIDER`

**Description:** `EventProcessor` injects the port and the config: target repo → `postComment` with the `TaskRef`;
another repo → `IGNORED` `other-repo`. `no-installation` and `src/events/hello/` are removed. Unit and integration
tests move from the fake hello service to the in-memory provider; the payload fixture gains `full_name` and
`issue.id`.

**Acceptance criteria:**
- [x] Target repo → one `postComment` with `{ platform: 'GITHUB', id: <issue.id>, externalRef: '<full_name>#<n>' }`
  and spec 1's text; row `DONE`
- [x] Another repo → `IGNORED` `other-repo`; zero provider calls
- [x] `src/events/hello/` no longer exists; Octokit is imported only under `src/github/`

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` pass
- [x] Manual: open a sandbox issue → one hello from `<app>[bot]`; row `DONE`

**Dependencies:** T7
**Files:** `src/events/event-processor.ts` (+ `.spec.ts`), `src/events/events.module.ts`, `test/app.ts`,
`test/worker.integration.spec.ts` (and `test/webhook.integration.spec.ts` if it uses the fixture);
deletes `src/events/hello/*`
**Scope:** M

### Task 9: Worker: permanent and rate-limit errors

**Description:** The worker's failure rule reads `ProviderError`: `permanent` fails at once; `transient` and any
other error keep spec 1's retries; `retryAfterSeconds` sets a minimum wait (A2).

**Acceptance criteria:**
- [x] Permanent error → `FAILED` after the first attempt, `lastError` set; the next event is still processed
- [x] Transient or any other error → 3 attempts, 5 s then 30 s, as before
- [x] `retryAfterSeconds: 120` → the next attempt is due about 120 s later

**Verification:**
- [x] `npm run test:integration` passes

**Dependencies:** T8
**Files:** `src/events/events.worker.ts`, `test/worker.integration.spec.ts`
**Scope:** S

### Checkpoint 2 — Real hello through the port
- [x] All four commands green
- [x] Open a sandbox issue → one hello; the hello's own webhook → `IGNORED` `not-handled`
- [x] Signed request for `someone/other-repo` → `IGNORED` `other-repo`, no comment
- [x] Signed request with `N=999999` → `FAILED` at once, `attempts = 1`, `last_error` shows the `404`
- [x] You review and commit

---

## Phase 3 — Remaining methods, each proven by the smoke script

### Task 10: Issue labels and permissions

**Description:** `setStatusLabel`, `removeLabel` and `hasWriteAccess` on `GitHubIssueProvider`.

**Acceptance criteria:**
- [x] `setStatusLabel`: the `POST` comes before any `DELETE`; no write when the issue is already right; other
  labels untouched; two status labels are reduced to one
- [x] `removeLabel`: only `workflow: *` and `grill: skip` (anything else throws with zero requests); a `404` is
  success
- [x] `hasWriteAccess`: `admin` / `write` → `true`; `read`, `none`, `404` → `false`; one request per call

**Verification:**
- [x] `npm test` passes

**Dependencies:** T7
**Files:** `src/github/github-issue.provider.ts` (+ `.spec.ts`)
**Scope:** S

### Task 11: Smoke script with the issue checks

**Description:** `npm run github:smoke` (P6): a Nest application context with config and `GitHubModule` only,
argument parsing with `util.parseArgs`, one `PASS` / `FAIL` line per check, exit code. First group: the spec's
issue checks.

**Acceptance criteria:**
- [x] `--issue N` runs the issue checks through the two tokens only (no Octokit import in the script); exit code 0
  only if every line is `PASS`
- [x] Without `--issue` → a usage message and exit code 1; no token is ever printed
- [x] `runSmoke` passes against the fakes and reports `FAIL` when a fake is made to misbehave (unit-tested)

**Verification:**
- [x] `npm test`, `npm run typecheck`, `npm run lint` pass
- [x] Manual (needs your test issue): the spec's "Smoke script — issue" rows

**Dependencies:** T10
**Files:** `src/github/smoke/github-smoke.ts`, `src/github/smoke/run-smoke.ts` (+ `.spec.ts`), `package.json`
**Scope:** M

### Task 12: `readFile` and `listFiles`

**Description:** `GitHubRepoProvider` starts with the two read methods (P7, P8); `REPO_PROVIDER` joins the module
and the harness. The smoke gains the repo checks (`--base`, `--dir`).

**Acceptance criteria:**
- [x] `readFile`: the text of a file; `null` for a missing path, a directory, a submodule; permanent error for an
  unknown ref, over 1 MB, invalid UTF-8 or an unsafe path
- [x] `listFiles`: nested regular files sorted by path, `executable` from mode `100755`, symlinks and submodules
  left out; `null` for a missing directory; permanent error for an unknown ref or a truncated tree
- [x] The smoke prints the file, the listing and the `null` / error cases

**Verification:**
- [x] `npm test`, `npm run test:integration` pass
- [x] Manual (needs your `smoke-skill/` push): the spec's "Smoke script — skill directory" row

**Dependencies:** T11
**Files:** `src/github/github-repo.provider.ts` (+ `.spec.ts`), `src/github/github.module.ts`, `test/app.ts`,
`src/github/smoke/run-smoke.ts`
**Scope:** M

### Task 13: `getPushCredentials`

**Description:** The narrowed push token (G8) and the bot's commit identity. The smoke gains the credential
checks, including the comment attempt that must be refused.

**Acceptance criteria:**
- [x] The request goes out as the App (JWT) with `repositories: [<repo>]` and `permissions: { contents: 'write' }`;
  one request per call; name, noreply email, HTTPS URL and expiry as in the spec
- [x] The token appears in no log line and no error message (unit test on the captured logs)
- [x] Smoke: two different tokens (lengths only) and `PASS` for "push token cannot comment (403)"

**Verification:**
- [x] `npm test` passes
- [x] Manual: the spec's "Smoke script — push credentials" row

**Dependencies:** T12
**Files:** `src/github/github-repo.provider.ts` (+ `.spec.ts`), `src/github/smoke/run-smoke.ts`
**Scope:** S

### Task 14: Pull request and check-run methods

**Description:** `openPullRequest`, `findPullRequest`, `postPullRequestComment` and `setQualityResult`. The smoke
gains the PR checks (`--branch`, `--sha`).

**Acceptance criteria:**
- [x] `openPullRequest` → a non-draft PR and its `PullRequestRef`; GitHub's `422` → permanent error, no lookup
- [x] `findPullRequest` → the newest PR of the branch opened by this App, any state; a human's PR → `null`
- [x] `setQualityResult` → creates `Quality Gate` the first time and updates the same check run for the same
  commit; `postPullRequestComment` behaves as `postComment`

**Verification:**
- [x] `npm test` passes
- [x] Manual (needs your branch `smoke/spec-3`; I read its head SHA with a read-only `gh api`): the spec's "Smoke
  script — PR and check run" rows, including the second run

**Dependencies:** T13
**Files:** `src/github/github-repo.provider.ts` (+ `.spec.ts`), `src/github/smoke/run-smoke.ts`
**Scope:** M

### Checkpoint 3 — Every method proven on the sandbox
- [x] All four commands green
- [x] Every smoke group prints `PASS`; exit code 0; a second run opens no second PR and adds no second check run
- [x] `grep` the smoke output for `ghs_` → no match
- [x] You review and commit

---

## Phase 4 — Docs and full verification

### Task 15: Setup guide and `AGENTS.md`

**Description:** The guide changes listed in the spec ("Setup & configuration"): `TARGET_REPO` in step 5, the
first start and its failure messages, the labels reference, the smoke section, the troubleshooting line.
`AGENTS.md`: `github:smoke` in Commands and the State line. `README.md` only if it repeats something that
changed.

**Acceptance criteria:**
- [x] Every command in the guide exists in `package.json`; the labels table matches `labels.ts`
- [x] `AGENTS.md` says spec 3 is built and names the next spec (2, `intake-authorization`)

**Verification:**
- [ ] Manual: you read the changed guide sections once

**Dependencies:** T14
**Files:** `docs/guides/setup-github-agent-local.md`, `AGENTS.md`, `README.md` (if needed)
**Scope:** S

### Task 16: Run the verification matrix and the success criteria

**Description:** Every row of the spec's matrix. I run what I can (config rows, signed requests, the smoke, the
database, log greps) with the app in the background and its log in the scratchpad. You do the Wi-Fi rows, the
GitHub UI steps and the redelivery, one step per message. Results are ticked in the spec; spec and plan status
lines are set.

**Acceptance criteria:**
- [x] Every matrix row is ticked or reported as failing with its output (no silent skips)
- [x] The spec's success criteria are checked, including the Octokit import `grep`

**Verification:**
- [x] `npm run typecheck && npm run lint && npm test && npm run test:integration` green

**Dependencies:** T15
**Files:** `docs/specs/spec-github-agent-github-providers.md` and this plan (checkboxes and status only), plus
fixes if a row fails
**Scope:** S (more if a row fails)

### Checkpoint 4 — Complete
- [x] The spec's "Success criteria" are all checked
- [ ] You review and commit; spec 2 (`intake-authorization`) is next in the build order

---

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The plugin switches (`retry` / `throttle` `enabled: false`) don't reach the installation client | High (hidden retries can duplicate comments) | T3 test: a `500` on a write makes exactly one request, through the same client the adapters use |
| A test reaches the real GitHub API | Med | P3: the harness replaces the client; unit tests always pass a scripted `fetch` |
| The narrowed token request is refused or is not really narrowed | High (spec 8 depends on it) | T13 smoke: the token must get `403` when it tries to comment |
| The first real start writes to the sandbox (11 labels) | Low (wanted, and it only creates) | T4 tests: never `PATCH` or `DELETE`; Checkpoint 1 checks the repo's own labels |
| A token ends up in a log or an error message | High | Messages are built from route, status and GitHub's message only; T13 log test; `ghs_` greps at Checkpoint 3 and in T16 |
| The fakes drift from the adapters | Med (specs 2, 4, 5 would test against wrong rules) | Both are tested for the same rules from the spec's tables (T2 and T7–T14) |
| `nest build` empties `dist/` while the app runs | Low | P6: the smoke runs with the app stopped; the guide says so |
| GitHub changes the "unknown ref" wording | Low | P7: the smoke's "missing ref → error" check fails visibly |
| Your sandbox preparations block Checkpoint 3 | Med | Listed under "Your part"; they can be done any time after Checkpoint 1 |

## Open questions

- Confirm P1–P9 above. P9 changes `src/main.ts`, and P4 changes `vitest.config.ts`; neither file is listed in the
  spec's "Project structure".
