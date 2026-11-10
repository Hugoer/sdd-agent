# Implementation Plan — Spec #1: Walking Skeleton

> **Created:** 2026-11-10 · **Status:** draft, awaiting review
>
> **Why this file exists:** turns the approved spec `docs/specs/spec-github-agent-walking-skeleton.md` into
> ordered, verifiable tasks (skill `agent-skills:planning-and-task-breakdown`). The spec stays normative: this plan
> adds order, slicing and build-time decisions only. The task checklist lives here (repo placement rules override
> the skill's `tasks/todo.md`).
>
> **Reference project:** `~/Projects/web-perf-app/web-perf-monorepo` (`apps/api/vitest*.config.ts`,
> `prisma.config.ts`, `apps/api/src/prisma/`). Never read its `.env` / `*.pem`.

## Overview

Scaffold the NestJS bot and prove the round trip GitHub → ngrok → `POST /webhooks/github` (HMAC) →
`webhook_events` → polling worker → one hello comment as `<app>[bot]`, plus the setup guide. Built in 11 tasks across
4 phases. You review the work and commit at each checkpoint (I never commit).

## Build-time decisions (not in the spec; please confirm)

| # | Decision | Why |
|---|---|---|
| P1 | `src/app.setup.ts` exports `appOptions` (`rawBody: true`) and `configureApp(app)` (25 MB JSON limit via `app.useBodyParser('json', …)`, shutdown hooks). `main.ts` uses them with `NestFactory.create`; integration tests use them with `Test.createTestingModule(…).overrideProvider(…)` (built in T6: a single `createApp()` could not take provider overrides). | Tests then exercise the real raw-body and size-limit config instead of a copy (mutation-checked in T6). One extra file not listed in the spec's "Project structure". |
| P2 | `enqueue()` = `createMany({ data: [row], skipDuplicates: true })`; `duplicate = count === 0`. | `INSERT … ON CONFLICT DO NOTHING`: no exception handling, the first row stays unchanged (spec row 4). |
| P3 | Claim = `findFirst` (oldest due `PENDING`) + `updateMany({ where: { id, status: 'PENDING' } })`; if `count === 0`, try the next one. | This is the spec's "one atomic update that only succeeds if still `PENDING`", with no raw SQL. The concurrent-claim integration test proves it. |
| P4 | The worker exposes `drainOnce()` (claims and processes until nothing is due). The `setTimeout` loop calls it. Tests call it directly and move `availableAt` into the past instead of waiting 5 s / 30 s. | Fast, deterministic integration tests with no fake timers on top of a real DB. |
| P5 | `PrismaService` takes `DATABASE_URL` from `ConfigService`, unlike the reference, which reads `process.env`. | Spec code style: config only through `ConfigService`. |
| P6 | `prisma.config.ts` calls `process.loadEnvFile()` only if `.env` exists. Node does not override variables that are already set, so the test global setup's `DATABASE_URL` (port 5434) wins. | Spec: no `dotenv`. Tests must never reach dev data (W5). |
| P7 | Integration tests replace `HelloCommentService` with `overrideProvider` (a fake with a call log). | Spec: "faked at its class boundary, no GitHub calls in tests". |

## Dependency graph

```text
T1 scaffold
 ├── T2 env config ───────────────┬──────────────┐
 └── T3 docker + prisma schema    │              │
        └── T4 PrismaModule + integration harness│
               │      T5 HMAC guard (needs T2)   │
               └──────┴── T6 webhook endpoint + enqueue
                               └── T7 EventProcessor + hello client
                                      └── T8 worker (claim, retries, startup reset, shutdown)
                                             └── T9 tunnel script + webhook URL log
                                                    └── T10 guide + README + AGENTS.md
                                                           └── T11 verification matrix
```

**Your parallel track (start now, it's the highest external risk):** follow the spec's "Setup & configuration"
steps 2–4. Claim the ngrok static domain, create the sandbox repo, then create and install the GitHub App. Have
the App ID, PEM path and webhook secret ready by Checkpoint 3.

---

## Phase 1 — Foundation

### Task 1: Project scaffold with toolchain green

**Description:** `package.json` with every dependency from the spec's "Tech stack" (newest minor of each listed
major, checked with `npm view`; **if a major has moved on, stop and ask**) and all scripts from "Commands" (the
db and tunnel scripts can point to files that come in later tasks). TS 6.0 strict, Nest CLI, ESLint 10 flat +
`typescript-eslint` recommended-type-checked + `eslint-config-prettier`, Prettier (`singleQuote`),
`.editorconfig`, `.nvmrc` (24), Vitest unit config, a minimal `AppModule` + `main.ts`, and one spec that
proves the runner and DI metadata. ESM per NestJS 12's `ts-esm` template; no `unplugin-swc` (spec W4). Each
`package.json` script is added by the task that makes it work (`postinstall: prisma generate` would break
`npm install` before Task 3's schema exists).

> **Done 2026-11-10.** Installed: NestJS 12.4.2, @nestjs/config 12.1.1, TypeScript 6.0.3, Vitest 5.1.0,
> ESLint 10.14.0, typescript-eslint 8.72.2, Prettier 3.9.10, @types/node 24.19.2. `npm audit`: 10 moderate,
> all `minimatch` inside ESLint (dev only, not in the runtime); no `--force` fix applied.

**Acceptance criteria:**
- [x] `npm ci` works on Node 24; `package-lock.json` is created (you commit it)
- [x] `.gitignore` covers `node_modules`, `dist`, `generated`, `.env`, `*.pem`, `coverage`
- [x] No package outside the spec's list

**Verification:**
- [x] `npm run build`, `npm run typecheck`, `npm run lint`, `npm test` all pass
- [x] Manual: `npm run dev` starts Nest and logs the app as started

**Dependencies:** None
**Files:** `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `eslint.config.mjs`,
`.prettierrc`, `.editorconfig`, `.nvmrc`, `.gitignore`, `vitest.config.ts`, `src/main.ts`, `src/app.module.ts`
**Scope:** M (many small config files)

### Task 2: Env validation (`ConfigModule` + Zod)

**Description:** `src/config/env.schema.ts` with the spec's six variables and rules (the private-key rule checks
that the file exists, is readable and has a `-----BEGIN … PRIVATE KEY-----` block). A `validate` function whose
error names every failing variable and its reason, never a value. Wired with `ConfigModule.forRoot({ isGlobal:
true, validate })`. Export `Env`. `.env.example` with placeholders.

**Acceptance criteria:**
- [x] Invalid or missing env → process exits 1 and prints all failing names, with no values
- [x] Defaults: `PORT=3000`, `NGROK_DOMAIN=''`; `NGROK_DOMAIN` rejects a scheme or a path

**Verification:**
- [x] Unit: `src/config/env.schema.spec.ts` covers each rule, the defaults, a multi-error list, and checks that no secret value appears in the message
- [x] Manual: remove `GITHUB_WEBHOOK_SECRET` → `npm run dev` exits naming it; `PORT=70000` → names `PORT`

**Dependencies:** T1
**Files:** `src/config/env.schema.ts`, `src/config/env.schema.spec.ts`, `src/app.module.ts`, `.env.example`
**Scope:** S

### Task 3: PostgreSQL in Docker + `WebhookEvent` schema and migration

**Description:** `docker-compose.yml` (`postgres:16-alpine`, named volume, healthcheck so `--wait` works) and
`docker-compose.test.yml` (port 5434, no volume, separate project name). `prisma.config.ts` (P6).
`prisma/schema.prisma` with the `prisma-client` generator → `src/generated/prisma` (inside `src/` so `nest build` compiles it), the `WebhookEventStatus` enum,
the `WebhookEvent` model exactly as the spec's table (snake_case `@map`s, `@@map("webhook_events")`, unique
`deliveryId`, index on `(status, availableAt, receivedAt)`). Migration `<ts>_webhook_events`. Scripts `db:*`,
including `db:events` (psql through `docker compose exec`).

**Acceptance criteria:**
- [x] `npm run db:up && npm run db:migrate` creates the table; `npm run db:events` prints an empty result
- [x] The test container starts on 5434 without touching the dev container or its volume
- [x] `postinstall` runs `prisma generate`; `src/generated/` is gitignored

**Verification:**
- [x] Manual: `db:down` → `db:up` → the table is still there; `db:test:up` / `db:test:down` leave dev untouched
- [x] `npm run typecheck` passes with the generated client

**Dependencies:** T1
**Files:** `docker-compose.yml`, `docker-compose.test.yml`, `prisma.config.ts`, `prisma/schema.prisma`,
`prisma/migrations/*`, `package.json`
**Scope:** M

### Task 4: `PrismaModule` + integration test harness

**Description:** `PrismaService` (Prisma 7 + `PrismaPg` adapter, URL from `ConfigService`, P5) and a global
`PrismaModule`. `vitest.integration.config.ts` (`test/**/*.integration.spec.ts`) and `test/global-setup.ts`
(sets the 5434 `DATABASE_URL`, runs `prisma migrate deploy`). A helper that truncates `webhook_events` between
tests. One smoke integration test: boot `AppModule`, write and read one row.

**Acceptance criteria:**
- [x] Integration tests run only against port 5434: `test/test-env.ts` sets the env through Vitest `test.env` (wins over `.env`), and `resetDatabase()` refuses to truncate any database but `sdd_agent_test` (tested)
- [x] The app boots and shuts down cleanly with Prisma connected

**Verification:**
- [x] `npm run db:test:up && npm run test:integration` passes; `npm test` doesn't pick up integration specs

**Dependencies:** T2, T3
**Files:** `src/prisma/prisma.service.ts`, `src/prisma/prisma.module.ts`, `vitest.integration.config.ts`,
`test/global-setup.ts`, `test/db.integration.spec.ts`
**Scope:** M

### Checkpoint 1 — Foundation
- [x] `typecheck`, `lint`, `test`, `test:integration` green
- [x] Config matrix rows (4) pass manually
- [x] You review and commit

---

## Phase 2 — Webhook intake (signed request → stored row)

### Task 5: `GitHubWebhookGuard`

**Description:** The guard from the spec's code style: HMAC-SHA256 over `rawBody` with the secret from
`ConfigService`, the `sha256=` prefix, length checked before `timingSafeEqual`, otherwise `401`.

**Acceptance criteria:**
- [x] `401` for a missing, malformed or wrong-secret signature, a length mismatch, or an empty body with a wrong signature
- [x] The secret and header are never logged

**Verification:**
- [x] Unit: `github-webhook.guard.spec.ts`, every case from the spec's "Testing strategy"

**Dependencies:** T2
**Files:** `src/webhook/github-webhook.guard.ts`, `src/webhook/github-webhook.guard.spec.ts`
**Scope:** S

### Task 6: `POST /webhooks/github` + `EventsService.enqueue()`

**Description:** `createApp()` (P1), used by `main.ts`. `WebhookModule` + controller (guarded; `400` if
`X-GitHub-Delivery` or `X-GitHub-Event` is missing; calls only `enqueue()`; returns `202` with an empty body; logs
the delivery ID, event, action and outcome, never the payload). `EventsModule` + `EventsService.enqueue()` (P2)
per the spec's "Contracts".

**Acceptance criteria:**
- [x] The four rows of the spec's request table behave exactly as written
- [x] A signed 5 MB body is accepted (no `413`)
- [x] The controller makes no outbound call; DB down → `500`

**Verification:**
- [x] Integration (`test/webhook.integration.spec.ts`, `app.listen(0)` + `fetch` + signed bodies): `401` not
  stored; `400` not stored; `202` stored `PENDING`; duplicate → one row, first row unchanged; 5 MB accepted
- [x] Manual: the spec's `curl` (no tunnel) → `202`, row visible in `db:events`

**Dependencies:** T4, T5
**Files:** `src/app.setup.ts`, `src/main.ts`, `src/webhook/webhook.module.ts`, `src/webhook/webhook.controller.ts`,
`src/events/events.module.ts`, `src/events/events.service.ts`, `test/webhook.integration.spec.ts`
**Scope:** M (7 files, mostly small)

### Checkpoint 2 — Intake
- [x] All tests green; matrix rows "Webhook authenticity and dedupe" 1–6 pass locally with `curl` (rows stay
  `PENDING` until T8)
- [x] You review and commit

---

## Phase 3 — Worker and hello (stored row → GitHub comment)

### Task 7: `EventProcessor` + hello client

**Description:** `EventProcessor.process()` follows the spec's decision list: `ping` → ignored with reason
`ping`; `issues.opened` with an installation → hello → `DONE`; without an installation → ignored with reason
`no-installation`; anything else → ignored with reason `not-handled`. Throwing means retry.
`HelloCommentService` (`octokit` `App`, PEM read from `GITHUB_APP_PRIVATE_KEY_PATH`,
`getInstallationOctokit`, `issues.createComment`, the fixed body with the delivery ID) is the only Octokit
import.

**Acceptance criteria:**
- [x] The decision table matches the spec; the comment body is exactly the spec's text
- [x] `grep -r "octokit" src` matches only `src/events/hello/`

**Verification:**
- [x] Unit: `event-processor.spec.ts` with a faked hello client (four cases + a client error that propagates)

**Dependencies:** T6
**Files:** `src/events/event-processor.ts`, `src/events/event-processor.spec.ts`,
`src/events/hello/hello-comment.service.ts`, `src/events/events.module.ts`
**Scope:** S

### Task 8: `EventsWorker`

**Description:** Startup resets `PROCESSING` rows to `PENDING`, then the `setTimeout` loop starts (1 s, no
overlapping ticks), calling `drainOnce()` (P4). Claim per P3 (oldest first, `attempts + 1`). On success: write
`DONE`/`IGNORED` + `ignoreReason` + `processedAt`. On a throw: `PENDING` with a 5 s, then 30 s backoff; the 3rd
failure → `FAILED` with `lastError` truncated to 2,000 characters. The loop never crashes, and logs DB errors
before retrying on the next tick. Shutdown: stop claiming, finish the current event, then Prisma closes.

**Acceptance criteria:**
- [x] One event at a time, oldest due first; the state transitions match spec W3
- [x] A failed event never stops the next one from being processed

**Verification:**
- [x] Integration (`test/worker.integration.spec.ts`, faked hello per P7): oldest first; retry →
  `availableAt` ≈ +5 s / +30 s → `FAILED` after 3 with `lastError`; startup reset of `PROCESSING`; two concurrent
  `drainOnce()` → each event processed exactly once; end to end: signed `issues.opened` POST → fake called once
  with the delivery ID, row `DONE`, `attempts = 1`

**Dependencies:** T7
**Files:** `src/events/events.worker.ts`, `src/events/events.module.ts`, `test/worker.integration.spec.ts`
**Scope:** M

### Task 9: Tunnel script + webhook URL log

**Description:** `scripts/tunnel.mjs` (exits non-zero with a message naming `NGROK_DOMAIN` when it's empty;
otherwise runs `ngrok http --url=<domain> <PORT>`, inheriting stdio). `main.ts` logs `Webhook URL:
https://<NGROK_DOMAIN>/webhooks/github` or `NGROK_DOMAIN not set: no tunnel`.

**Acceptance criteria:**
- [x] Both log variants appear as written; the empty-domain tunnel never starts ngrok

**Verification:**
- [~] Manual: `NGROK_DOMAIN=` → `npm run tunnel` fails naming the variable; with your domain → ngrok runs, and the
  app log URL matches the App's webhook URL

**Dependencies:** T8
**Files:** `scripts/tunnel.mjs`, `src/main.ts`
**Scope:** XS

### Checkpoint 3 — Real round trip (needs your GitHub App)
- [ ] `npm run tunnel` + `npm run dev`; open an issue in the sandbox repo → one hello within ~5 s, row `DONE`
- [ ] The hello's own `issue_comment` → `IGNORED` `not-handled`, no reply
- [ ] All tests green; you review and commit

---

## Phase 4 — Docs and full verification

### Task 10: Setup guide, README, AGENTS.md

**Description:** `docs/guides/setup-github-agent-local.md` following the spec's 10 setup steps, using the real
commands. Root `README.md` (short purpose + link to the guide). `AGENTS.md`: fill in Commands from
`package.json` and update "State" (no longer greenfield).

**Acceptance criteria:**
- [ ] Every command in the guide exists in `package.json`; labels are listed for reference only
- [ ] Includes the data-persistence note and the troubleshooting section (Recent deliveries, `:4040`, `401`, `502`)

**Verification:**
- [ ] Manual: you (or a fresh clone) follow the guide from zero up to the hello comment

**Dependencies:** T9
**Files:** `docs/guides/setup-github-agent-local.md`, `README.md`, `AGENTS.md`
**Scope:** S

### Task 11: Run the verification matrix + success criteria

**Description:** Go through every row of the spec's "Verification matrix" with you (the GitHub-side rows need
your sandbox repo): wrong PEM → `FAILED` after ~35 s; app stopped → redeliver; `PROCESSING` reset; persistence
across a Docker restart; log grep invariants. Check the success criteria (the Octokit import check, the seams for
specs 2/3). Record the results in the spec's matrix checkboxes.

**Acceptance criteria:**
- [ ] Every matrix row checked or reported as failing with output (no silent skips)
- [ ] `grep` of the app log for the secret, `sha256=` and `-----BEGIN` → no match

**Verification:**
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:integration` green

**Dependencies:** T10
**Files:** `docs/specs/spec-github-agent-walking-skeleton.md` (checkboxes only), plus fixes if a row fails
**Scope:** S (more if a row fails)

### Checkpoint 4 — Complete
- [ ] Spec "Success criteria" all checked
- [ ] You review and commit; spec 3 (`github-providers`) is next in the build order

---

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| A listed major has moved on (Prisma, Vitest, ESLint, octokit…) | Med | T1 checks with `npm view`; stop and ask (spec rule) |
| Prisma 7 `prisma-client` + `PrismaPg` typing friction | Med | Copy the reference's `PrismaService` cast pattern; T4 proves it before any feature code |
| `useBodyParser` limit loses `rawBody` | High (every webhook → 401) | T6 integration test: a signed 5 MB body must return `202` |
| Vitest: missing decorator metadata breaks DI | Med | Resolved in T1: Vite 8 emits it; `src/app.module.spec.ts` asserts constructor injection |
| Integration tests hit the dev DB | High | P6 + Vitest `test.env` + `resetDatabase()` refuses any database but `sdd_agent_test` (T4, tested) |
| GitHub App / ngrok setup blocks Checkpoint 3 | Med | Your parallel track starts now |
| Secrets in logs (Nest exception logger, Octokit error messages) | High | The controller logs only metadata; `lastError` is truncated; the T11 log grep |

## Open questions

- Confirm P1–P7 above (P1 adds `src/app.setup.ts`, a file not listed in the spec).
