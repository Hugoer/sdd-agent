# Spec #1 — GitHub AI Agent: Walking Skeleton

> **Created:** 2026-11-10 · **Status:** approved 2026-11-10
>
> **Repos:** bot [`Hugoer/sdd-agent`](https://github.com/Hugoer/sdd-agent) (this repo) · target
> [`Hugoer/sdd-agent-sandbox`](https://github.com/Hugoer/sdd-agent-sandbox) (public)
>
> **Why this file exists:** first capability spec of the roadmap (overview §1 row 1, module id `walking-skeleton`).
> It scaffolds the project and proves the round trip GitHub → ngrok → NestJS → PostgreSQL → worker → GitHub
> comment with real payloads, before any LLM, intake or routing logic is designed on top of it.
>
> **Sources:** `docs/specs/spec-github-agent-architecture-overview.md` (normative), idea doc
> `docs/idea/github-ai-agent-master-technical-spec.md` §3 (HMAC, App auth), §9 "Event intake, idempotency and
> concurrency" (intake + processing bullets), §10 "Execution environment" (ngrok), §12 "Every spec includes", and
> the interview of 2026-11-09/10 (decisions W1–W9). Reference project for tooling:
> `~/Projects/web-perf-app/web-perf-monorepo` (NestJS + Prisma 7 + Vitest + Docker).

## Objective

A NestJS app on the developer's machine that receives the sandbox repo's webhooks through ngrok, rejects unsigned
ones, stores every delivery once, and processes stored events in a background worker. The only behavior: when an
issue is opened in the sandbox repo, the bot posts one "hello" comment as the GitHub App. Plus a setup guide that
takes a new developer from zero to that comment.

- **Actor:** the developer (sets up and runs the app, opens a test issue).
- **Done when:** a developer following `docs/guides/setup-github-agent-local.md` from zero opens an issue in their
  sandbox repo and gets exactly one hello comment from `<app>[bot]`, and the verification matrix passes.

## Scope

- **In:** project scaffold (npm, TypeScript, NestJS, lint, format, tests), `ConfigModule` (Zod env),
  `PrismaModule`, `WebhookModule` (`POST /webhooks/github`, HMAC guard), `EventsModule` (`WebhookEvent` table,
  dedupe by delivery ID, `enqueue()`, polling worker, retries), the minimal hello App client, Docker Compose for
  PostgreSQL (dev + test), `npm run tunnel`, the setup guide, root `README.md` linking to it, `AGENTS.md` →
  Commands.
- **Out (later specs):** payload → neutral input, sender check, `TARGET_REPO` filter, label revert (2); App
  auth service, `IssueProvider`/`RepoProvider`, label bootstrap (3); LLM, guardrails, secret scanning, step
  skills (4); `Task`, leases, router (5); everything after (6–10). Exactly-once for the hello comment (W2).

## Decisions (interview 2026-11-09/10, all confirmed)

- **W1 Hello trigger:** only `issues.opened`. The bot posts one fixed comment; every other event (including
  `ping` and the bot's own `issue_comment`) is stored and marked `IGNORED`, so the bot can't trigger itself.
- **W2 No exactly-once for the hello:** a redelivery is caught by the delivery-ID dedupe; a crash after posting but
  before marking the event done may post a second hello. Accepted: the marker pattern belongs to specs 3/5/6 and
  spec 3 deletes this client.
- **W3 Worker:** one app instance, one event at a time, oldest first. States
  `PENDING → PROCESSING → DONE | IGNORED | FAILED`. Atomic claim; leftover `PROCESSING` rows are reset to
  `PENDING` at startup (they come from a crash). Bounded retries with backoff, then `FAILED` with the error.
- **W4 Test runner:** Vitest 5, not Jest. No `unplugin-swc`: Vite 8's built-in transformer emits decorator
  metadata (proven by a DI unit test, 2026-11-10), as in NestJS 12's official `ts-esm` template.
- **W5 PostgreSQL in Docker:** `docker-compose.yml` (`postgres:16-alpine`, named volume: data survives
  `stop`/`start`, `restart`, `down`/`up` and a Docker restart; only `down -v` deletes it) and a separate
  `docker-compose.test.yml` (port 5434, no volume) so tests can never touch dev data. Host ports are bound to
  `127.0.0.1`; 5434, not 5433, because the reference project's test DB already uses 5433 (changed 2026-11-10).
- **W6 GitHub App created once with the final permissions and events** (overview §2), so it is never
  re-approved: permissions `issues`, `pull_requests`, `contents`, `checks` (write) + `metadata` (read); events
  `issues`, `issue_comment`, `pull_request`.
- **W7 Stack:** Node 24 LTS, npm, TypeScript 6.0 strict, NestJS 12, Prisma 7 (`prisma-client` generator +
  `@prisma/adapter-pg`), Zod 4, Vitest 5, `octokit` 5, ESLint 10 flat + `typescript-eslint` 8, Prettier. No Nx.
  Majors bumped at build time (2026-11-10, approved): NestJS 11 → 12, TypeScript 5.9 → 6.0, Vitest 4 → 5,
  ESLint 9 → 10. Not TypeScript 7: `typescript-eslint` 8 supports `<6.1` and Nest CLI 12 ships 6.0. Prisma stays
  on 7 (8 is only a release candidate). NestJS 12 is ESM-only, so the project is ESM (`"type": "module"`,
  `nodenext`, relative imports end in `.js`), following NestJS 12's `ts-esm` app template.
- **W8 Zod only:** env validation with Zod; no class-validator. Request DTOs (none in this spec) would use a Zod
  schema + `ZodValidationPipe` (rule recorded in the overview, "Tech stack, commands, code style, tests").
- **W9 `NGROK_DOMAIN`** (new env var, overview §5): the developer's free static ngrok domain; `npm run tunnel`
  uses it and the app logs the resulting webhook URL at startup. The ngrok authtoken stays in ngrok's own config.

## Behavior

### Startup

1. Load `.env` and validate with Zod (§Configuration). Any invalid or missing variable → the process exits with
   code 1 and prints every failing variable **name** and reason, never a value.
2. Connect to PostgreSQL. Reset `PROCESSING` events to `PENDING` (W3).
3. Listen on `PORT`; log `Webhook URL: https://<NGROK_DOMAIN>/webhooks/github` (or `NGROK_DOMAIN not set: no
   tunnel` when empty).
4. Start the worker loop.
5. On `SIGINT`/`SIGTERM`: stop claiming new events, let the current one finish, close Prisma.

### `POST /webhooks/github` (controller + `GitHubWebhookGuard`)

| # | Request | Response | Stored |
|---|---|---|---|
| 1 | `X-Hub-Signature-256` missing, malformed, or not the HMAC-SHA256 of the raw body with `GITHUB_WEBHOOK_SECRET` | `401` | no |
| 2 | Valid signature, `X-GitHub-Delivery` or `X-GitHub-Event` missing | `400` | no |
| 3 | Valid signature, new delivery ID | `202`, empty body | one row, `PENDING` |
| 4 | Valid signature, delivery ID already stored | `202`, empty body | nothing (the first row is unchanged) |

- The signature is checked against the **raw** request bytes (`NestFactory.create(..., { rawBody: true })`) with
  a constant-time comparison (`crypto.timingSafeEqual`, length checked first).
- JSON body limit **25 MB** (GitHub's maximum payload), not Express's 100 kB default.
- No outbound call in the request path (overview D4). The controller only calls `EventsService.enqueue()`.
- Never logged: the secret, the signature header, the payload. Logged: delivery ID, event name, action, outcome.

### Worker (`EventsWorker`)

- Polls every 1 s (constant) with a `setTimeout` chain (no overlapping ticks); drains all due events back to back,
  then sleeps.
- **Claim:** the oldest row with `status = PENDING` and `availableAt <= now()`, moved to `PROCESSING` with one
  atomic update that only succeeds if it is still `PENDING`; `attempts` + 1.
- **Process** (`EventProcessor.process(event)`, the seam specs 2 and 5 replace):
  - `ping` → `IGNORED`, reason `ping`.
  - `issues` with action `opened` → hello comment (below) → `DONE`.
    - No `installation.id` in the payload → `IGNORED`, reason `no-installation`.
  - anything else → `IGNORED`, reason `not-handled` (spec 2 introduces the real ignore reasons).
- **Failure** (any thrown error): `attempts < 3` → back to `PENDING`, `availableAt = now + backoff` (5 s after the
  first failure, 30 s after the second); 3rd failure → `FAILED`, `lastError` = error message (truncated to 2,000
  characters, never a token). The worker never crashes on a failed event.
- `processedAt` is set when the event reaches `DONE`, `IGNORED` or `FAILED`.

### Hello comment (minimal App client)

- `octokit`'s `App` (`appId` = `GITHUB_APP_ID`, `privateKey` = the PEM file's contents) →
  `getInstallationOctokit(payload.installation.id)` → `issues.createComment` on `payload.repository` /
  `payload.issue.number`.
- Body (fixed, contains no issue text, so no secret scanning is needed before spec 4):

  ```text
  👋 Hello from the GitHub AI Agent (walking skeleton). Webhook round trip OK — delivery `<deliveryId>`.
  ```

- Lives in `src/events/hello/`; it is the only Octokit import until spec 3 replaces it with `GitHubModule`
  (overview §1 "Module rules").
- No `TARGET_REPO` filter yet: the guide installs the App on the sandbox repo only.

## Contracts

- `EventsService.enqueue(input: { deliveryId; eventName; payload }): Promise<{ duplicate: boolean }>` — the
  only way into the queue (idea doc §11 "Future": a BullMQ swap only replaces this service and the worker).
- `EventProcessor.process(event: WebhookEvent): Promise<{ status: 'DONE' } | { status: 'IGNORED'; reason: string }>`
  — throwing means "retry" (worker rules above).
- No change to the overview §4 contracts.

## Owned table: `WebhookEvent`

Mapped to snake_case (`@@map("webhook_events")`, `@map` per column), as in the reference project.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | `gen_random_uuid()` |
| `deliveryId` | text, **unique** | `X-GitHub-Delivery` (dedupe key) |
| `eventName` | text | `X-GitHub-Event` |
| `action` | text, nullable | `payload.action` |
| `payload` | jsonb | the parsed body, unchanged |
| `status` | enum `WebhookEventStatus` | `PENDING`, `PROCESSING`, `DONE`, `IGNORED`, `FAILED` (spec 8 adds `WAITING_WORKSPACE`) |
| `ignoreReason` | text, nullable | spec 1: `ping`, `no-installation`, `not-handled`; spec 2 extends |
| `attempts` | int, default 0 | |
| `availableAt` | timestamptz, default now | earliest next claim (retry backoff) |
| `lastError` | text, nullable | |
| `receivedAt` | timestamptz, default now | "received" in overview §3 R1 |
| `processedAt` | timestamptz, nullable | |

Index on `(status, availableAt, receivedAt)` for the claim query. Migration: `prisma/migrations/<ts>_webhook_events`.

## Configuration

Zod schema in `src/config/env.schema.ts`, used by `ConfigModule.forRoot({ isGlobal: true, validate })`. Spec 1's
rows of overview §5:

| Variable | Default | Validation |
|---|---|---|
| `PORT` | `3000` | integer 1–65535 |
| `DATABASE_URL` | required | `postgresql://` URL |
| `GITHUB_WEBHOOK_SECRET` | required | non-empty |
| `GITHUB_APP_ID` | required | positive integer |
| `GITHUB_APP_PRIVATE_KEY_PATH` | required | file exists, readable, contains a `-----BEGIN … PRIVATE KEY-----` block |
| `NGROK_DOMAIN` | empty | bare hostname (no scheme, no path) |

`.env.example` lists them with placeholder values; `.env` and `*.pem` are gitignored. `prisma.config.ts` reads
`DATABASE_URL` with Node's built-in `process.loadEnvFile()` (no `dotenv` dependency).

## Tech stack and dependencies

Approving this spec approves these packages (overview: new dependencies are "ask first"). Newest minor of each
major at build time; `package-lock.json` is committed by the developer. If a major has moved on, the build stops
and asks.

- **Runtime:** `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/config` (12),
  `reflect-metadata`, `rxjs`, `@prisma/client` + `@prisma/adapter-pg` + `pg` (7), `zod` (4), `octokit` (5).
- **Dev:** `@nestjs/cli`, `@nestjs/schematics`, `@nestjs/testing`, `typescript` (6.0), `@types/node` (24),
  `@types/express`, `@types/pg`, `prisma` (7), `vitest` (5), `eslint` (10),
  `@eslint/js`, `typescript-eslint` (8), `eslint-config-prettier`, `prettier`.
- **Not added:** `unplugin-swc` / `@swc/core` (W4), `dotenv`, `supertest` (tests use `fetch` against `app.listen(0)`), class-validator, Nx.
- **Tools installed by the developer:** Node 24 (`.nvmrc`), Docker Desktop, ngrok CLI, `openssl` (macOS default).

## Commands (`package.json` scripts)

Copied into `AGENTS.md` → Commands once they exist (build session).

```text
npm run dev               nest start --watch
npm run build             nest build
npm start                 node dist/main.js
npm run typecheck         tsc --noEmit
npm run lint              eslint .
npm run format            prettier --write .
npm test                  vitest run                                  (unit)
npm run test:integration  vitest run -c vitest.integration.config.ts  (needs db:test:up)
npm run db:up             docker compose up -d --wait
npm run db:down           docker compose stop                         (keeps data)
npm run db:reset          prisma migrate reset                        (asks first; wipes dev data on purpose)
npm run db:test:up        docker compose -f docker-compose.test.yml up -d --wait
npm run db:test:down      docker compose -f docker-compose.test.yml down
npm run db:migrate        prisma migrate dev
npm run db:events         psql via docker compose exec: last 20 webhook_events rows
npm run tunnel            node --env-file=.env scripts/tunnel.mjs     (ngrok http --url=$NGROK_DOMAIN $PORT)
postinstall               prisma generate
```

## Project structure (spec 1's part of overview §1)

```text
src/
  main.ts                       bootstrap: rawBody, 25 MB JSON limit, shutdown hooks, webhook URL log
  app.module.ts
  config/   env.schema.ts (+ .spec.ts), config.module wiring
  prisma/   prisma.module.ts, prisma.service.ts (Prisma 7 adapter-pg)
  webhook/  webhook.module.ts, webhook.controller.ts, github-webhook.guard.ts (+ .spec.ts)
  events/   events.module.ts, events.service.ts (enqueue), events.worker.ts, event-processor.ts
            hello/hello-comment.service.ts (the only Octokit import until spec 3)
  generated/prisma/             Prisma client output (gitignored; inside src/ so `nest build` compiles it)
prisma/     schema.prisma, migrations/
scripts/    tunnel.mjs
test/       *.integration.spec.ts, global-setup.ts (migrate deploy against the test DB)
docker-compose.yml, docker-compose.test.yml, prisma.config.ts, vitest.config.ts,
vitest.integration.config.ts, eslint.config.mjs, .prettierrc, .editorconfig, .nvmrc, .env.example, .gitignore
README.md   links to docs/guides/setup-github-agent-local.md
```

## Code style

```ts
// The guard decides authenticity before anything is parsed or stored.
@Injectable()
export class GitHubWebhookGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RawBodyRequest<Request>>();
    const received = Buffer.from(req.header('x-hub-signature-256') ?? '');
    const expected = Buffer.from(
      'sha256=' +
        createHmac('sha256', this.config.get('GITHUB_WEBHOOK_SECRET'))
          .update(req.rawBody ?? Buffer.alloc(0))
          .digest('hex'),
    );
    // Byte lengths, not string lengths: a non-ASCII header of the right string length would make
    // timingSafeEqual throw (500) instead of returning 401 (found in the build, 2026-11-10).
    const ok = received.length === expected.length && timingSafeEqual(received, expected);
    if (!ok) throw new UnauthorizedException();
    return true;
  }
}
```

- Prettier `singleQuote`, 2-space indent (`.editorconfig`), ESLint flat config with `typescript-eslint`
  recommended-type-checked.
- Config is read only through `ConfigService<Env, true>` (`Env = z.infer<typeof envSchema>`), never
  `process.env` (exceptions: `prisma.config.ts`, `scripts/tunnel.mjs`).

## Testing strategy

- **Unit** (`src/**/*.spec.ts`, `npm test`): env schema (each rule, defaults, error lists names not values);
  guard (valid, missing, malformed, wrong secret, length mismatch, empty body); `EventProcessor` decisions
  (`ping`, `issues.opened`, no installation, other events) with the hello client faked.
- **Integration** (`test/*.integration.spec.ts`, real PostgreSQL on 5434, no DB mocks): the Nest app on a random
  port, called with `fetch` and signed bodies — `401` not stored; `202` stored; duplicate delivery → one row; 5 MB
  signed payload accepted; worker claims oldest first; retry backoff then `FAILED`; startup reset of
  `PROCESSING`; only one claim wins when two run concurrently. The hello client is faked at its class boundary
  (no GitHub calls in tests).
- **Manual:** the verification matrix below against the real sandbox repo.

## Setup & configuration → `docs/guides/setup-github-agent-local.md`

Written by the build session (commands must exist first, `AGENTS.md`). From zero, in this order:

1. **Prerequisites:** Node 24 (`nvm use`), Docker Desktop, ngrok CLI + account, a GitHub account.
2. **ngrok:** `ngrok config add-authtoken <token>`; claim the free static domain in the ngrok dashboard → it
   becomes `NGROK_DOMAIN`.
3. **Sandbox target repo:** create a **public** GitHub repo (e.g. `<you>/sdd-agent-sandbox`; public because GitHub
   Free only protects branches of public repos, needed for spec 10's optional required check), clone it, scaffold a tiny
   TypeScript project (one function + one Vitest test, ESLint), add `.github-agent/workflow.json` with
   `{ "skills": {} }` (every step uses the built-in prompt until skills are written; read from spec 4 on), push to
   `main`.
4. **GitHub App** (W6): Settings → Developer settings → GitHub Apps → New. Webhook active, URL
   `https://<NGROK_DOMAIN>/webhooks/github`, secret from `openssl rand -hex 32`; permissions and events as W6;
   "Only on this account". Note the App ID; generate a private key and store it **outside the repo** (e.g.
   `~/.config/sdd-agent/github-app.pem`, `chmod 600`). App name: `sdd-agent-<your-handle>` (globally unique;
   comments show as `<name>[bot]`). Install the App on the sandbox repo **only** ("Only select
   repositories").
5. **Bot repo:** `npm ci`, `cp .env.example .env`, fill in the variables (§Configuration).
6. **PostgreSQL:** `npm run db:up`, `npm run db:migrate`. Note on data: kept across stop/start/restart/down; only
   `docker compose down -v` or `npm run db:reset` removes it.
7. **Run:** terminal 1 `npm run tunnel`, terminal 2 `npm run dev`; check the logged webhook URL matches the App's.
8. **Smoke test:** open an issue in the sandbox repo → hello comment; `npm run db:events` shows the row `DONE`.
9. **Troubleshooting:** the App's "Advanced → Recent deliveries" page (status, response, Redeliver); ngrok's
   inspector at `http://localhost:4040`; `401` = secret mismatch; `502` from ngrok = app not running.
10. **Tests:** `npm run db:test:up`, `npm test`, `npm run test:integration`.

Labels are not created here (spec 3 creates them at startup); the guide lists them for reference.

## Edge cases

- `ping` (sent when the App is created or the webhook is edited) → `202`, stored, `IGNORED` `ping` (overview
  "Edge cases routed to later specs").
- Unsigned request with invalid JSON → `400` from the body parser before the guard runs; still not stored.
- GitHub retries nothing automatically; a delivery missed while the app was down is recovered with "Redeliver".
- Redelivery after the event was processed → `202`, no new row, no second hello.
- Crash between posting the hello and marking `DONE` → a second hello is possible (W2, accepted).
- App installed on a second repo by mistake → it would say hello there too (no `TARGET_REPO` filter until
  spec 2/3); the guide says "Only select repositories".
- Wrong private key / App uninstalled → GitHub `401`/`404` → 3 attempts → `FAILED` with `lastError`.
- Database down while the app runs → the controller returns `500` (GitHub shows the failed delivery; redeliver
  later); the worker logs and retries on the next tick.

## Boundaries

- **Always:** validate the signature before parsing anything into the database; keep secrets and the PEM out of
  the repo and the logs; read config only through `ConfigService`; run `npm run typecheck`, `npm run lint`,
  `npm test` and `npm run test:integration` before declaring the build done.
- **Ask first:** any package not listed in "Tech stack and dependencies" or a different major; any env var,
  column or status not listed here; touching overview §4 contracts.
- **Never:** commit or push (the developer does); outbound calls from the controller; Octokit outside
  `src/events/hello/`; logging secrets, signatures, tokens or payloads; giving the worker more than one event at a
  time; installing the App on any repo but the sandbox.

## Verification matrix

**Setup to observe:** `npm run db:events` (last 20 `webhook_events` rows: delivery, event, action, status, ignore
reason, attempts, last error); the App's "Recent deliveries" page; the issue timeline; the app log. Signed test
request (run in the bot repo with `.env` loaded, e.g. `set -a; source .env; set +a`):

```sh
BODY='{"zen":"manual"}'; SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | sed 's/^.* //')
curl -i -X POST "http://localhost:$PORT/webhooks/github" -H 'Content-Type: application/json' \
  -H 'X-GitHub-Event: ping' -H "X-GitHub-Delivery: manual-$(date +%s)" -H "X-Hub-Signature-256: sha256=$SIG" -d "$BODY"
```

**Setup guide**
- [ ] Fresh clone, nothing installed but the prerequisites — follow the guide from zero → an issue opened in the
  sandbox repo gets exactly one hello comment from `<app>[bot]`; its row is `DONE`.
- [ ] App running — the startup log shows `Webhook URL: https://<NGROK_DOMAIN>/webhooks/github`, identical to the
  App's webhook URL.
- [ ] `NGROK_DOMAIN` empty — `npm run tunnel` exits with a message naming `NGROK_DOMAIN`; ngrok does not start.

**Configuration**
- [ ] Remove `GITHUB_WEBHOOK_SECRET` from `.env` — `npm run dev` exits; the message names the variable; no secret
  value appears in the output.
- [ ] `GITHUB_APP_PRIVATE_KEY_PATH` points to a missing file — the app refuses to start, naming the variable.
- [ ] `PORT=70000` — the app refuses to start, naming `PORT`.
- [ ] `NGROK_DOMAIN=https://x.ngrok-free.app/` — the app refuses to start (scheme not allowed).

**Webhook authenticity and dedupe**
- [ ] `curl` without `X-Hub-Signature-256` → `401`; `db:events` shows NO new row.
- [ ] The signed request above with one character of the body changed after signing → `401`; no new row.
- [ ] The signed request above → `202`; one new row `IGNORED` `ping`.
- [ ] The same request again with the same `X-GitHub-Delivery` → `202`; still one row for that delivery.
- [ ] Signed request without `X-GitHub-Delivery` → `400`; no new row.
- [ ] A signed ~5 MB body → `202`; the row is stored (no `413`).
- [ ] In "Recent deliveries", redeliver the `issues.opened` delivery → `202`; still one row; NO second hello.

**Worker and hello**
- [x] Open an issue → within ~5 s one hello comment naming the delivery ID; row `DONE`, `attempts = 1`.
- [x] The hello comment's own `issue_comment` webhook → row `IGNORED` `not-handled`; NO reply: the bot never
  triggers itself.
- [ ] Add a label or a comment to an issue → row `IGNORED` `not-handled`; nothing posted.
- [ ] Point `GITHUB_APP_PRIVATE_KEY_PATH` to another valid PEM (`openssl genrsa -out /tmp/other.pem 2048`),
  restart, open an issue → no comment; after ~35 s the row is `FAILED`, `attempts = 3`, `lastError` set; the app
  keeps running and processes the next event.
- [ ] Stop the app, open an issue (delivery fails, ngrok `502`), start the app, redeliver → one hello.
- [ ] With the app stopped, set a row to `PROCESSING` via `psql`, start the app → the row is processed again
  (reset at startup).

**Persistence**
- [ ] `npm run db:down` then `npm run db:up` (and separately a Docker Desktop restart) → `db:events` still shows the
  earlier rows.
- [ ] `npm run db:test:down` → dev rows unaffected (separate container).

**Invariants**
- [ ] After all rows above, `grep` the app log for the webhook secret, `sha256=` and `-----BEGIN` → no match.
- [ ] No path ever produces two hello comments for one delivery ID, except the accepted crash window (W2).
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:integration` all pass.

## Success criteria

- [ ] Every row of the verification matrix passes on the developer's machine.
- [ ] `AGENTS.md` → Commands and "State" reflect the scaffolded project; `README.md` links to the guide.
- [ ] Only `src/events/hello/` imports Octokit; the controller makes no outbound call.
- [ ] Specs 2 and 3 can replace `EventProcessor` and the hello client without changing the controller, the guard
  or the `WebhookEvent` columns defined here.

## Open questions

- None blocking. The retry counts (3 attempts, 5 s / 30 s) and the 1 s poll are constants; specs 3 and 5 may move
  them to config when they classify transient errors.
