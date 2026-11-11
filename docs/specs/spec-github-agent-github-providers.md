# Spec #3 — GitHub AI Agent: GitHub Providers

> **Created:** 2026-11-10 · **Status:** approved 2026-11-10 (including A1–A5) · not built yet
>
> **Repos:** bot [`Hugoer/sdd-agent`](https://github.com/Hugoer/sdd-agent) (this repo) · target
> [`Hugoer/sdd-agent-sandbox`](https://github.com/Hugoer/sdd-agent-sandbox)
>
> **Why this file exists:** second capability spec in build order (overview §1 row 3, module id
> `github-providers`). It replaces spec 1's minimal hello client with the real GitHub adapters behind the
> `IssueProvider` and `RepoProvider` ports, so specs 2, 4, 5 and 8–10 never touch Octokit.
>
> **Sources:** `docs/specs/spec-github-agent-architecture-overview.md` (normative: §2 labels, §4 contracts, §5
> config, §7 rules), `docs/specs/spec-github-agent-walking-skeleton.md` (the code it changes), idea doc
> `docs/idea/github-ai-agent-master-technical-spec.md` §10 "Identity", and the interview of 2026-11-10
> (decisions G1–G14). GitHub response shapes were checked against the sandbox repo on 2026-11-10.

## Objective

One NestJS module, `GitHubModule`, that authenticates as the GitHub App on the target repo and implements every
method of `IssueProvider` and `RepoProvider`. At startup it checks the installation and creates the bot's labels.
The rest of the app reaches GitHub only through the two ports.

- **Actor:** the developer (runs the app, runs the smoke script). Later specs are the callers.
- **Done when:** the app starts only if the App is correctly installed on `TARGET_REPO`, the 11 labels exist, the
  hello comment goes through `IssueProvider`, every other method is proven by the smoke script against the sandbox
  repo, and the verification matrix passes.

## Scope

- **In:** `src/contracts` (types, DI tokens, `ProviderError`), `GitHubModule` (App auth, installation lookup, bot
  identity, both providers, startup checks, label bootstrap), `TARGET_REPO`, the hello comment moved onto
  `IssueProvider`, the worker's handling of permanent and rate-limit errors, in-memory fake providers for tests,
  the dev-only smoke script, setup guide updates.
- **Out (later specs):** sender check, own-event filter, the real ignore reasons, label revert logic (2); reading
  `workflow.json`, loading and validating skills, secret scanning (4); `Task`, status transitions, `needs-human`
  comments, marker formats (5, 6); git fetch/push with the push credentials (8); when PRs and check runs are
  created (9, 10). Jira / Azure DevOps adapters: Future.

## Decisions (interview 2026-11-10, all confirmed)

- **G1 The full contract now.** Every `IssueProvider` and `RepoProvider` method is built in this spec, including
  the PR, check-run and push-credential methods whose callers arrive in specs 8–10. A dev-only smoke script
  proves those against the sandbox repo.
- **G2 The installation comes from `TARGET_REPO`.** Resolved once at startup (App JWT → the repo's installation)
  and kept in memory. No `GITHUB_INSTALLATION_ID` variable; payload installation IDs are no longer used.
- **G3 Startup fails fast.** If the installation lookup, the permission check or the label bootstrap fails, the
  app exits with the cause and the fix. No background retry, no "not ready" state.
- **G4 The hello comment stays,** posted through `IssueProvider.postComment`. An `issues.opened` event from a
  repo other than `TARGET_REPO` is recorded as ignored.
- **G5 One retry layer: the worker.** Octokit's retry and throttling plugins are off. Providers throw a neutral
  `ProviderError` marked `transient` or `permanent`. The worker retries transient errors as in spec 1 and fails a
  permanent one at once. Reason: a hidden retry of a write can duplicate a comment (a 5xx may arrive after GitHub
  created it), and the marker check (overview D13) only runs when the event is retried.
- **G6 `hasWriteAccess` is never cached.** Every call asks GitHub.
- **G7 A skill is its whole directory.** `RepoProvider` gains `listFiles(ref, dir)` (overview §4 updated first).
  How reference files reach the LLM, and whether a skill's scripts may run, are decided in spec 4 (Open
  questions).
- **G8 Narrowed push token.** `getPushCredentials()` creates a separate token limited to the target repo and
  `contents: write`, new on every call. It is the only token that leaves the Node process.
- **G9 `setStatusLabel` adds first, then removes,** so an issue is never without a status label. It never touches
  other labels.
- **G10 `ensureLabels` only creates missing labels.** It never edits or deletes an existing one.
- **G11 `findCommentByMarker` only matches comments written by the App itself,** so a user who pastes a marker
  can't fool it.
- **G12 One Quality Gate check run per commit.** A second `setQualityResult` for the same commit updates the
  existing check run. A new head commit gets a new one, as the idea doc's "each run posts a new check run" says.
- **G13 No new dependency for tests.** Octokit gets a fake `fetch`. In-memory fake providers live in `test/fakes/`
  for specs 2, 4 and 5.
- **G14 The smoke PR needs a branch** the developer creates in the GitHub UI (matrix precondition). The bot has no
  git code until spec 8.

**Added while writing (not asked in the interview; approved with the spec on 2026-11-10):**

- **A1** Startup also checks the installation's permissions and names any missing one (part of G3's "a
  permission is missing").
- **A2** A rate-limit error carries GitHub's wait time, and the worker waits at least that long before the next
  attempt. Without it a rate-limited event would fail after 35 s.
- **A3** `readFile` / `listFiles` on a ref that doesn't exist throw a permanent error instead of returning `null`,
  so a wrong base branch is never mistaken for "this repo has no skills".
- **A4** `removeLabel` refuses any label that is not `workflow: *` or `grill: skip`.
- **A5** Every GitHub request has a 30 s timeout (a hung connection would block the single worker for ever).

## Behavior

### Startup

Order: env validation → PostgreSQL → **GitHub (new)** → worker → listen. The app listens only after step 4 below
succeeded.

1. **Installation:** as the App (JWT), `GET /repos/{owner}/{repo}/installation` for `TARGET_REPO` → installation
   ID, App slug, granted permissions.
2. **Permissions (A1):** `issues`, `pull_requests`, `contents`, `checks` must be `write`; `metadata` at least
   `read`.
3. **Bot identity:** login `<slug>[bot]`; its user ID from `GET /users/<slug>[bot]` (needed for the commit email).
4. **Labels:** `ensureLabels()` (below).
5. Log one line: bot login, `TARGET_REPO`, installation ID, labels created / already present.

Any failure stops the process with exit code 1 and one message. Never printed: the token, the JWT, the key.

| Cause | Message says |
|---|---|
| `401` on the App JWT | GitHub rejected the App credentials: check `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` |
| `404` on the installation lookup | the App is not installed on `<TARGET_REPO>` (or the repo doesn't exist): install it, setup guide step 4 |
| A required permission is missing | which permissions are missing; fix them in the App settings and accept the new permissions |
| `403` while creating a label | `issues: write` is missing |
| No response / timeout / `5xx` | GitHub is unreachable; check the connection and start again |

### GitHub client (`src/github`, the only Octokit import)

- `octokit`'s `App` (`GITHUB_APP_ID`, the PEM file's contents) built on an `Octokit` with
  `retry: { enabled: false }` and `throttle: { enabled: false }` (G5). The auth strategy's own handling stays: it
  caches and renews the installation token, and retries a `401` on a token younger than 5 s (nothing was executed,
  so nothing can be duplicated).
- All API calls use the installation's Octokit. That token never leaves the client: not logged, not stored, not
  returned (the push token is a different one, G8).
- Every request has a 30 s timeout (A5) and every failure becomes a `ProviderError` ("Errors and retries").
- **Target repo only:** a `TaskRef` whose `externalRef` is not `<TARGET_REPO>#<number>` (repo compared
  case-insensitively), or a `PullRequestRef` for another repo, throws a permanent `ProviderError` before any call.
- Logged per write: method, issue or PR reference, resulting ID. Never logged: bodies, tokens, headers.

### `IssueProvider` (GitHub)

`task.externalRef` gives the issue number; `task.id` is the DB identity and is not sent to GitHub.

| Method | GitHub call | Result and rules |
|---|---|---|
| `getTaskDetails` | `GET …/issues/{n}` | `id` = `issue.id` as a string, `title`, `description` = body or `''`, `labels` = label names, `author` = `user.login`, `url` = `html_url`. Missing issue → permanent error. |
| `postComment` | `POST …/issues/{n}/comments` | The body is sent unchanged (the caller scanned it and added its marker). Returns `{ id, url, createdAt }`. |
| `getComment` | `GET …/issues/comments/{id}` | `{ body, createdAt }`. `null` when the comment doesn't exist or belongs to another issue. |
| `findCommentByMarker` | `GET …/issues/{n}/comments`, all pages (100 per page) | The oldest comment whose author is this App (`performed_via_github_app.id` = `GITHUB_APP_ID`) and whose body contains `marker` (G11). `null` if none. An empty marker is a programming error (throws). |
| `setStatusLabel` | `GET …/issues/{n}/labels`, then `POST …/labels`, then `DELETE …/labels/{name}` | G9: add `status: <status>` if missing, then remove every other label starting with `status: `. Already in the target state → no write. Other labels are untouched. A crash between add and remove leaves two status labels; the next call fixes it. |
| `removeLabel` | `DELETE …/issues/{n}/labels/{name}` | Only `workflow: *` and `grill: skip` (A4); anything else throws without a call. Label not on the issue → success. |
| `hasWriteAccess` | `GET …/collaborators/{login}/permission` | `true` when `permission` is `admin` or `write` (GitHub reports `maintain` as `write` and `triage` as `read`). `404` (no such user) → `false`. No cache (G6). |
| `readControls` | none (pure) | From `task.labels`, compared case-insensitively: `lanes` = every lane label present, in the order `full-sdd`, `spec-code`, `code-only`; `grillSkip` = `grill: skip` present. Unknown `workflow: *` labels are ignored. |
| `ensureLabels` | `GET …/labels` (all pages), `POST …/labels` per missing one | G10: creates each missing label of the table below; names compared case-insensitively. "Already exists" from a race counts as present. Never `PATCH`, never `DELETE`. |

**Labels created** (name, color, description; overview §2):

| Label | Color | Description |
|---|---|---|
| `status: draft` | `ededed` | Bot-managed: not started. Add a workflow label to start. |
| `status: grilling` | `fbca04` | Bot-managed: asking clarifying questions. |
| `status: spec-review` | `c5def5` | Bot-managed: Spec posted, waiting for /approve. |
| `status: ready-for-dev` | `0e8a16` | Bot-managed: waiting for /approve to start the Coder. |
| `status: executing` | `1d76db` | Bot-managed: the Coder is running. |
| `status: in-review` | `5319e7` | Bot-managed: PR opened; Quality Gate and human review. |
| `status: needs-human` | `b60205` | Bot-managed: stopped. Remove and re-add the workflow label to restart. |
| `workflow: full-sdd` | `0052cc` | Human-assigned: Grill Me → Spec → Plan → Coder → Quality Gate. |
| `workflow: spec-code` | `0052cc` | Human-assigned: Grill Me → Spec → Coder → Quality Gate. |
| `workflow: code-only` | `0052cc` | Human-assigned: Coder → Quality Gate, after /approve. |
| `grill: skip` | `d4c5f9` | Human-assigned: skip Grill Me (full-sdd, spec-code). |

The bot never adds a `workflow: *` or `grill: skip` label to an issue; it only creates them in the repo.

### `RepoProvider` (GitHub)

Paths are relative to the repo root: no leading `/`, no `..` segment (otherwise a permanent error, no call).

| Method | GitHub call | Result and rules |
|---|---|---|
| `getPushCredentials` | as the App (JWT): `POST /app/installations/{id}/access_tokens` with `repositories: [<repo>]`, `permissions: { contents: 'write' }` | G8. `authorName` = `<slug>[bot]`, `authorEmail` = `<bot user id>+<slug>[bot]@users.noreply.github.com`, `remoteUrl` = `https://github.com/<TARGET_REPO>.git`, `token`, `expiresAt` (about 1 h). A new token on every call; never cached, logged or stored. |
| `readFile` | `GET …/contents/{path}?ref={ref}` | The file's text (UTF-8). `null` when the path doesn't exist or is not a file (directory, submodule). Unknown ref → permanent error (A3). Over 1 MB or not valid UTF-8 → permanent error. |
| `listFiles` | `GET …/commits/{ref}` → tree SHA → `GET …/git/trees/{sha}?recursive=1` | G7. Every regular file under `dir`, at any depth: `{ path, size, executable }`, `path` from the repo root, sorted by path. `executable` = git mode `100755`. Symlinks and submodules are left out. `null` when `dir` is not a directory at that ref. Unknown ref → permanent error (A3). A listing GitHub marks `truncated` → permanent error. |
| `openPullRequest` | `POST …/pulls` (`head` = branch, `base`, `title`, `body`) | A normal (non-draft) PR. Returns `{ platform, repo, number, url }`. It does not look for an existing PR: GitHub's `422` (PR already exists, no commits) is a permanent error, and the caller runs `findPullRequest` first on a retry (overview §7 rule 7). |
| `findPullRequest` | `GET …/pulls?head={owner}:{branch}&state=all` | The newest PR for that branch **opened by this App**, in any state. `null` if none (a human's PR from the same branch doesn't count). |
| `postPullRequestComment` | `POST …/issues/{pr.number}/comments` | As `postComment`. |
| `setQualityResult` | `GET …/commits/{sha}/check-runs` (this App, name `Quality Gate`), then `PATCH …/check-runs/{id}` or `POST …/check-runs` | G12. A completed check run named `Quality Gate`: `conclusion` = `result`, output title `Quality Gate`, output summary = `summary` (already scanned). The same commit again → the existing check run is updated. |

### Errors and retries

```ts
// src/contracts
export class ProviderError extends Error {
  constructor(
    message: string,                       // "GitHub POST /repos/{owner}/{repo}/pulls → 422: <GitHub's message>"
    readonly kind: 'transient' | 'permanent',
    readonly detail: { status?: number; retryAfterSeconds?: number } = {},
  ) { super(message); }
}
```

| GitHub answer | Kind |
|---|---|
| No response (DNS, connection reset, the 30 s timeout) | `transient` |
| `5xx` | `transient` |
| `429`, or `403` with `retry-after` or `x-ratelimit-remaining: 0` | `transient` + `retryAfterSeconds` (A2) |
| `401`, any other `403`, `404`, `410`, `422`, any other `4xx` | `permanent` |
| `404` where the method defines a "missing" result (`getComment`, `readFile`, `hasWriteAccess`, `removeLabel`) | not an error |

The message holds the method, the route, the status and GitHub's message. Never a token, a header or a request
body.

**Worker change** (spec 1 "Worker", failure rule):

- `ProviderError` `permanent` → `FAILED` at once, `lastError` set, no further attempt.
- `ProviderError` `transient`, and any other thrown error → spec 1's rule (3 attempts, 5 s then 30 s). With
  `retryAfterSeconds`, the next attempt waits `max(backoff, retryAfterSeconds)`.
- Inside one attempt no GitHub call is ever sent twice.

### Hello comment (through the port)

`EventProcessor` keeps spec 1's decisions with these changes:

- `issues.opened` and `payload.repository.full_name` ≠ `TARGET_REPO` (case-insensitive) → `IGNORED`, reason
  `other-repo`; no GitHub call.
- Otherwise `IssueProvider.postComment(task, body)` with `task = { platform: 'GITHUB', id: <issue.id>,
  externalRef: '<full_name>#<issue.number>' }` → `DONE`. The body text is spec 1's, unchanged.
- The reason `no-installation` no longer exists (G2). The crash window of spec 1 W2 (a possible second hello) is
  still accepted.
- `src/events/hello/` is deleted. `EventsModule` imports `GitHubModule` only for this; spec 2 moves event
  processing to `IntakeModule`.

### Smoke script (dev-only)

```text
npm run github:smoke -- --issue <n> [--base main] [--dir .github-agent] [--branch <name> --sha <head commit>]
```

- Starts a Nest application context with config and `GitHubModule` only: no HTTP server, no worker, no database.
  It uses the two ports, never Octokit directly. The startup checks run first, so labels are also created here.
- Prints one line per check, `PASS` or `FAIL` with the method and what it saw; exit code 0 only if all pass.
  Tokens are printed as their length only.
- **Issue checks** (`--issue`): `getTaskDetails` + `readControls`; `postComment` with a per-run marker →
  `findCommentByMarker` returns the same ID → `getComment` returns the body; an unused marker → `null`;
  `setStatusLabel('grilling')` then `('spec-review')` → exactly one status label; `removeLabel('grill: skip')`
  twice; `removeLabel('bug')` is refused; `hasWriteAccess` for the issue author, for `octocat` and for a login
  that doesn't exist.
- **Repo checks:** `readFile(base, '.github-agent/workflow.json')`, a missing file → `null`, a missing ref →
  permanent error; `listFiles(base, dir)` printed, a missing directory → `null`.
- **Push credentials:** two calls give two different tokens; identity and URL printed; a comment attempt made
  with the push token (plain `fetch`) must get `403`, which proves the token is narrowed.
- **PR checks** (`--branch` + `--sha`): `findPullRequest` → open it if missing → `findPullRequest` returns the
  same number → `postPullRequestComment` → `setQualityResult` `neutral` then `success` on `--sha` → one check run.
- Safe to run again: a second run posts new comments but opens no second PR and adds no second check run.
- It leaves the issue, the comments and the PR in place; the developer closes them by hand (the bot never closes
  or deletes anything).

## Contracts

Changes to overview §4, made there first (2026-11-10):

```ts
export interface RepoFile {
  path: string;        // relative to the repo root
  size: number;        // bytes
  executable: boolean; // git mode 100755
}

export interface RepoProvider {
  // …existing methods…
  /** every regular file under dir at a ref, at any depth (a step skill is its whole directory); null = no such directory */
  listFiles(ref: string, dir: string): Promise<RepoFile[] | null>;
}
```

- `ProviderError` (above) joins `src/contracts`; core code and the worker import it from there, never from
  `src/github`.
- `src/contracts` is created by this spec with the types its providers need (`Platform`, `Lane`, `TaskStatus`,
  `TaskRef`, `UnifiedTask`, `CommentRef`, `IssueProvider`, `PullRequestRef`, `PushCredentials`, `RepoFile`,
  `RepoProvider`, `ProviderError`) and the tokens `ISSUE_PROVIDER`, `REPO_PROVIDER`. `StepName` and `StepSkill`
  arrive with spec 4.
- `GitHubModule` exports only the two tokens.
- `EventProcessor.process()` keeps its signature (spec 1).

## Owned tables

None. No migration.

## Configuration

| Variable | Default | Validation |
|---|---|---|
| `TARGET_REPO` | required | `owner/name` (GitHub's characters for each part) |

Added to `src/config/env.schema.ts`, `.env.example` and the test environment. Used by `GitHubModule` and by the
hello's repo check.

## Tech stack and dependencies

No new package. `octokit` 5 (already installed) provides the App auth and REST methods; the smoke script parses
its arguments with Node's `util.parseArgs`.

## Commands

```text
npm run github:smoke      build, then run the provider smoke checks against TARGET_REPO (needs .env; arguments above)
```

Added to `AGENTS.md` → Commands by the build session.

## Project structure (spec 3's part of overview §1)

File names are a guide; the plan may adjust them.

```text
src/
  contracts/                     §4 types, ProviderError, DI tokens; no logic
  github/
    github.module.ts             provides and exports ISSUE_PROVIDER, REPO_PROVIDER
    github-client.ts             the only Octokit import: App auth, installation, bot identity, timeout, error mapping
    github-startup.ts            startup checks + ensureLabels (fail fast)
    github-issue.provider.ts     IssueProvider
    github-repo.provider.ts      RepoProvider
    labels.ts                    the 11 label definitions; label name ↔ Lane / TaskStatus
    smoke/github-smoke.ts        npm run github:smoke
    *.spec.ts
  events/event-processor.ts      hello through ISSUE_PROVIDER (events/hello/ deleted)
  events/events.worker.ts        permanent → FAILED at once; retryAfterSeconds
  config/env.schema.ts           + TARGET_REPO
test/
  fakes/                         in-memory IssueProvider and RepoProvider
```

## Code style

```ts
// Adapters hold the GitHub knowledge; a defined "missing" result is a value, every other failure a ProviderError.
@Injectable()
export class GitHubIssueProvider implements IssueProvider {
  constructor(private readonly github: GitHubClient) {}

  async hasWriteAccess(task: TaskRef, login: string): Promise<boolean> {
    const { owner, repo } = this.github.target(task); // throws if the task is not in TARGET_REPO
    const found = await this.github.requestOrNull(
      'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
      { owner, repo, username: login },
    );
    return found?.permission === 'admin' || found?.permission === 'write';
  }
}
```

- Core code injects `@Inject(ISSUE_PROVIDER)` / `@Inject(REPO_PROVIDER)`, never a class from `src/github`.
- Spec 1's rules stay: ESM imports ending in `.js`, config only through `ConfigService<Env, true>`.

## Testing strategy

- **Unit** (`src/github/*.spec.ts`, `npm test`): the adapters run on a real Octokit whose `fetch` is a scripted
  fake that records requests (G13); the App key is generated in the test. Covered: each method's request and
  mapping; pagination over two pages; every "missing" result; each row of the error table; a `500` on a write
  makes exactly one request; the timeout; `setStatusLabel` order and its no-write case; `ensureLabels` creates
  only missing labels and never patches; the `removeLabel` guard; a human comment holding the marker is not
  matched; the narrowed token request (`repositories`, `permissions`) and a new token per call; `listFiles`
  (nested paths, executable flag, symlink left out, missing directory, truncated tree); `readFile` (directory,
  too large, invalid UTF-8, unknown ref); each startup failure and its message; `readControls` (no lane, one, two,
  skip, letter case); `TARGET_REPO` validation.
- **Fakes** (`test/fakes/`): in-memory providers with the same rules as the adapters (marker search only among
  bot comments, status-label replacement, `null` results) and a way to make the next call throw a given
  `ProviderError`. They have their own unit tests.
- **Integration** (real PostgreSQL, fake providers, no network): hello for the target repo → one `postComment`
  with the right `TaskRef`; other repo → `IGNORED` `other-repo`, no call; permanent error → `FAILED` after 1
  attempt; transient → backoff, `FAILED` after 3; `retryAfterSeconds: 120` → next attempt about 120 s later; the
  app boots with the fakes without calling GitHub.
- **Manual:** the verification matrix below. No test calls the real GitHub API.

## Setup & configuration → `docs/guides/setup-github-agent-local.md`

Updated by the build session:

- Step 5 (`.env`): add `TARGET_REPO=<you>/sdd-agent-sandbox`.
- Step 7 (run): the first start creates the 11 labels; what each startup failure message means and its fix.
- "Reference: labels": the table above; they are created by the bot, never by hand.
- New section "Check the GitHub App with the smoke script": preconditions (a test issue, optionally a branch) and
  the command.
- Troubleshooting: an event `FAILED` with `attempts = 1` is a permanent GitHub error; read `last_error`.

The App's permissions and events don't change (spec 1 W6 created it with the final set).

## Changes to spec 1's behavior

- A wrong private key or an App that is not installed now stops the app at startup. Spec 1's matrix row
  "another valid PEM → `FAILED` after ~35 s" no longer applies.
- `no-installation` is gone; `other-repo` is new.
- Only permanent errors skip the retries; everything else retries as before.

## Edge cases

- Issue deleted or transferred → `404` / `410` → permanent error (spec 5 turns it into its outcome).
- A status label deleted from the repo while the app runs → GitHub recreates it (default color) when
  `setStatusLabel` adds it; the bot doesn't recolor it later (G10).
- The marked comment was deleted by a human → `findCommentByMarker` returns `null` and the caller posts again.
- More than 100 comments or labels → all pages are read.
- App renamed → the bot login and commit email change at the next start; old comments still match by App ID.
- App installed on more repos than the sandbox → the providers still only serve `TARGET_REPO`.
- Installation token expires during a long run → Octokit renews it. The push token is requested per git command
  (spec 8).
- Comment or check-run text over GitHub's limit → `422` → permanent error; the provider never cuts text (spec 7
  handles long documents).
- Each label change by the bot fires a webhook from the bot itself → recorded `not-handled` today; spec 2 gives it
  its own reason.
- A repo too large for one tree listing (`truncated`) → permanent error. Walking the tree per directory: Future.
- Private target repo → works the same (the App's `contents` permission covers reading).

## Boundaries

- **Always:** keep Octokit inside `src/github`; turn every GitHub failure into a `ProviderError`; change overview
  §4 first when a contract changes; run `npm run typecheck`, `npm run lint`, `npm test` and
  `npm run test:integration` before declaring the build done.
- **Ask first:** a new package, env var, label or contract method; changing a label's name, color or
  description; a smoke check that touches anything but its own issue, branch and PR.
- **Never:** commit or push (the developer does); use the `gh` CLI or the developer's credentials in code; log,
  print or store a token, the JWT or the key; add `workflow: *` or `grill: skip` to an issue; edit or delete repo
  labels; close issues or PRs, delete comments or branches; send a GitHub write twice inside one attempt; call
  GitHub from the webhook controller or from a test.

## Verification matrix

**Setup to observe:** `npm run db:events`; the sandbox's Labels page (`https://github.com/<TARGET_REPO>/labels`);
the issue timeline; the PR's Checks tab; the app log; the smoke script's output. Signed `issues.opened` request
(bot repo, `.env` loaded with `set -a; source .env; set +a`; set `REPO` and `N`):

```sh
REPO="$TARGET_REPO"; N=1
BODY=$(printf '{"action":"opened","repository":{"full_name":"%s"},"issue":{"id":1,"number":%s}}' "$REPO" "$N")
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | sed 's/^.* //')
curl -i -X POST "http://localhost:$PORT/webhooks/github" -H 'Content-Type: application/json' \
  -H 'X-GitHub-Event: issues' -H "X-GitHub-Delivery: manual-$(date +%s)" -H "X-Hub-Signature-256: sha256=$SIG" -d "$BODY"
```

**Startup and labels**
- [ ] Sandbox repo without the bot's labels — start the app → the 11 labels exist with the spec's colors and
  descriptions; the log names `<app>[bot]`, `TARGET_REPO` and "11 created".
- [ ] All 11 present, one recolored by hand — restart → log says 0 created; the hand-set color is kept.
- [ ] Delete only `status: grilling` in the Labels page — restart → only that label is recreated.
- [ ] In all rows above the repo's own labels (`bug`, `enhancement`, …) are unchanged.
- [ ] `TARGET_REPO` removed from `.env` → the app refuses to start, naming `TARGET_REPO`. `TARGET_REPO=foo` → same.
- [ ] `TARGET_REPO=Hugoer/sdd-agent` (App not installed there) → the app exits with code 1 within seconds; the
  message says the App is not installed on that repo; the port is NOT listening (`curl` → connection refused).
- [ ] `GITHUB_APP_PRIVATE_KEY_PATH` → another valid PEM (`openssl genrsa -out /tmp/other.pem 2048`) → the app
  exits; the message names `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH`.
- [ ] Wi-Fi off → `npm start` exits with the "GitHub is unreachable" message; it does NOT keep retrying.

**Hello through the provider**
- [ ] Open an issue in the sandbox repo → within ~5 s one hello comment from `<app>[bot]`; row `DONE`,
  `attempts = 1`.
- [ ] Signed request with `REPO=someone/other-repo` → `202`; row `IGNORED` `other-repo`; NO comment anywhere.
- [ ] Signed request with `N=999999` (no such issue) → row `FAILED` at once with `attempts = 1`; `last_error`
  shows the `404`; the app keeps running and handles the next event.
- [ ] Wi-Fi off, signed request for an existing issue; when the log shows "attempt 1/3 failed", Wi-Fi on →
  exactly one hello; row `DONE` with `attempts` 2 or 3.
- [ ] Wi-Fi off for the whole time, signed request → after ~35 s row `FAILED`, `attempts = 3`.
- [ ] Redeliver the `issues.opened` delivery from "Recent deliveries" → still one row; NO second hello.
- [ ] The hello's own `issue_comment` webhook → row `IGNORED` `not-handled`; NO reply.

**Smoke script — issue** (precondition: a new sandbox issue `#N` with the labels `grill: skip` and `bug` added by
hand)
- [ ] `npm run github:smoke -- --issue N` → every line `PASS`, exit code 0.
- [ ] On GitHub afterwards: one smoke comment from `<app>[bot]`; exactly one `status: *` label
  (`status: spec-review`); `grill: skip` is gone; `bug` is still there.
- [ ] The output shows `hasWriteAccess` `true` for you, `false` for `octocat` and `false` for the invented login.
- [ ] The output shows the content of `.github-agent/workflow.json`, `null` for the missing file, an error for
  the missing ref, the listing of `.github-agent`, and `null` for the missing directory.
- [ ] Run it again → `PASS`; the issue still has exactly one `status: *` label; one more smoke comment.

**Smoke script — skill directory** (precondition: from your sandbox clone, push to `main` a directory
`smoke-skill/` with `SKILL.md`, `references/a.md` and `scripts/run.sh` made executable with
`git update-index --chmod=+x`)
- [ ] `npm run github:smoke -- --issue N --dir smoke-skill` → the listing shows exactly those three files with
  their nested paths and sizes; `executable` is `true` only for `scripts/run.sh`.

**Smoke script — push credentials**
- [ ] The output shows `authorName` `<app>[bot]`, `authorEmail` `<id>+<app>[bot]@users.noreply.github.com`,
  `remoteUrl` `https://github.com/<TARGET_REPO>.git`, an expiry about 1 h ahead, two different tokens (lengths
  only), and `PASS` for "push token cannot comment (403)".

**Smoke script — PR and check run** (precondition: in the GitHub UI, create branch `smoke/spec-3` from `main` and
commit one small edit on it; `SHA` = that commit)
- [ ] `npm run github:smoke -- --issue N --branch smoke/spec-3 --sha SHA` → a PR from `smoke/spec-3` into `main`
  opened by `<app>[bot]`; one PR comment from the bot; the Checks tab shows exactly one `Quality Gate` check run,
  conclusion `success`.
- [ ] Run the same command again → NO second PR; still exactly one `Quality Gate` check run on that commit.

**Invariants**
- [ ] `grep -rnE "from '(octokit|@octokit)" src --include='*.ts' --exclude-dir=generated` → matches only under
  `src/github/`; `src/events/hello/` doesn't exist.
- [ ] After all rows: `grep` the app log and the smoke output for `ghs_`, `-----BEGIN` and the webhook secret → no
  match.
- [ ] After all rows: no issue timeline shows the bot adding a `workflow: *` or `grill: skip` label, and no label
  of the repo was edited or deleted by the bot.
- [ ] No path sends a GitHub write twice inside one attempt (unit test: a `500` on `postComment` → one request).
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:integration` all pass.

Not checked by hand: the missing-permission startup message (changing the App's permissions would need a new
approval of the installation); it is covered by a unit test.

## Success criteria

- [ ] Every row of the verification matrix passes on the developer's machine.
- [ ] `src/contracts` matches overview §4 signature by signature; only `src/github` imports Octokit.
- [ ] Specs 2, 4 and 5 can be built against `ISSUE_PROVIDER`, `REPO_PROVIDER` and `test/fakes/` without changing
  `src/github`.
- [ ] The setup guide, `.env.example`, `AGENTS.md` (State, Commands) and the overview reflect this spec.

## Open questions

None blocks this spec. For later specs:

- **Spec 4 (from G7):** how a skill's reference files reach the LLM (all in the prompt, or loaded on demand);
  whether and where a skill's scripts run. Running them contradicts overview §4 "The skill only changes
  instructions" and its tools column (Grill, Spec and Plan have no tools), so the overview changes first. Also:
  binary files in a skill directory (`readFile` rejects non-UTF-8), reading the listing and the files at one
  commit (pass a commit SHA as `ref`), and whether `listFiles` should also return each file's blob SHA to skip
  unchanged files.
- **Spec 5:** overview D16 says retries end in `needs-human` + a comment; until then a failed event is only a
  `FAILED` row. The retry constants stay constants.
- **Spec 10:** the check-run name `Quality Gate` (it becomes the required-check name in branch protection) and
  its output title.
