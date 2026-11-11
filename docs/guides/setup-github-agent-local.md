# Setup: GitHub AI Agent on your machine

> **Created:** 2026-11-10 · **Why this file exists:** setup guide for spec #1
> (`docs/specs/spec-github-agent-walking-skeleton.md`, "Setup & configuration"). It takes a new developer from
> zero to the bot's first comment on a sandbox issue. Living doc: each later spec that changes setup updates it.

**End state:** you open an issue in your sandbox repo, and within a few seconds `<your-app>[bot]` comments:

```text
👋 Hello from the GitHub AI Agent (walking skeleton). Webhook round trip OK — delivery `<id>`.
```

**How the pieces connect:** GitHub sends a webhook → your ngrok static domain → the NestJS app on
`localhost:3000` → PostgreSQL (Docker) → a background worker → a comment through the GitHub App.

You will collect four values on the way. They all go into `.env` in step 5:

| Value | From | `.env` variable |
|---|---|---|
| ngrok static domain | step 2 | `NGROK_DOMAIN` |
| Webhook secret | step 4 (`openssl`) | `GITHUB_WEBHOOK_SECRET` |
| App ID | step 4 (App settings page) | `GITHUB_APP_ID` |
| Private key file path | step 4 (downloaded `.pem`) | `GITHUB_APP_PRIVATE_KEY_PATH` |

---

## 1. Prerequisites

- **Node 24** through nvm: the repo's `.nvmrc` selects it.

  ```sh
  nvm install 24   # once
  nvm use          # in the bot repo, every new terminal
  ```

- **Docker Desktop**, running.
- **ngrok CLI** and a free ngrok account: `brew install ngrok`, then sign up at <https://ngrok.com>.
- A **GitHub account**.
- `openssl` (preinstalled on macOS).

## 2. ngrok: authtoken and static domain

1. When you sign up, ngrok asks **"Where do you want to begin?"**. Choose **Share Localhost** ("Put your local
   app on a public URL"). It covers what the bot needs: a stable public URL for `localhost` and webhook
   testing with replay. Skip **Gateway** and **AI Gateway** (production API traffic and LLM providers). The
   choice only sets where onboarding starts; other products can be added later.
2. In the ngrok dashboard, copy **Your Authtoken** and register it (it stays in ngrok's own config, never in
   `.env`):

   ```sh
   ngrok config add-authtoken <token>
   ```

3. In the dashboard, open **Domains**. Free accounts get one static domain (e.g. `something.ngrok-free.app`).
   Copy it as a bare hostname: no `https://`, no trailing `/`. This is your `NGROK_DOMAIN`.

The domain never changes, so the GitHub App's webhook URL is set once.

## 3. Sandbox target repo

The bot works only on this repo, never on the bot repo itself.

1. On GitHub, create a **public** repo, e.g. `<you>/sdd-agent-sandbox`, with a README. It must be public:
   GitHub Free only protects branches of public repos, and spec 10 uses an optional required check.
2. Clone it and scaffold an empty TypeScript library: strict TypeScript, Vitest, ESLint, and one placeholder
   test. The reference sandbox [`Hugoer/sdd-agent-sandbox`](https://github.com/Hugoer/sdd-agent-sandbox) is
   **split-the-bill**, an expense-sharing library whose features arrive through issues (its README lists
   starter issues). You can copy that repo instead of the steps below.

   ```sh
   git clone https://github.com/<you>/sdd-agent-sandbox.git && cd sdd-agent-sandbox
   echo 24 > .nvmrc && nvm use
   npm init -y
   npm pkg set name=split-the-bill type=module engines.node=">=24" \
     scripts.test="vitest run" scripts.lint="eslint ." scripts.typecheck="tsc --noEmit"
   npm pkg set private=true --json   # --json: a boolean, not the string "true"
   # TypeScript 6.0: typescript-eslint 8 doesn't support TypeScript 7 yet
   npm install -D typescript@~6.0.3 vitest eslint @eslint/js typescript-eslint @types/node@24
   mkdir -p src .github-agent
   ```

   `tsconfig.json`:

   ```json
   {
     "compilerOptions": {
       "target": "ES2023",
       "module": "nodenext",
       "moduleResolution": "nodenext",
       "strict": true,
       "noEmit": true,
       "isolatedModules": true,
       "skipLibCheck": true,
       "types": ["node"]
     },
     "include": ["src", "*.ts"]
   }
   ```

   `eslint.config.mjs`:

   ```js
   import eslint from '@eslint/js';
   import tseslint from 'typescript-eslint';

   export default tseslint.config(
     { ignores: ['node_modules/'] },
     eslint.configs.recommended,
     tseslint.configs.recommended,
   );
   ```

   `src/index.ts` (placeholder until the first feature lands):

   ```ts
   // Public API of split-the-bill. Features arrive through issues (see README → Starter issues).
   export const LIBRARY_NAME = 'split-the-bill';
   ```

   `src/index.test.ts`:

   ```ts
   import { expect, it } from 'vitest';
   import { LIBRARY_NAME } from './index.js';

   it('exports the library name', () => {
     expect(LIBRARY_NAME).toBe('split-the-bill');
   });
   ```

   `.github-agent/workflow.json` (step skills; empty for now, nothing reads it yet. From spec 4 on, every step a
   workflow label uses needs a skill mapped here: there is no built-in fallback prompt):

   ```json
   {
     "skills": {}
   }
   ```

   `.gitignore`:

   ```text
   node_modules/
   ```

3. Check it, then push to `main`:

   ```sh
   npm test && npm run lint && npm run typecheck
   git add -A && git commit -m "chore: sandbox scaffold" && git push origin main
   ```

## 4. GitHub App

Create it once with its final permissions and events, so it never needs re-approval when later specs use them.

1. **Create the webhook secret.** This is a password that only GitHub and your bot know. GitHub uses it to sign
   every webhook it sends: an HMAC-SHA256 of the request body, sent in the `X-Hub-Signature-256` header. The bot
   recomputes the signature with the same secret and rejects any request that doesn't match with `401`, so
   nobody else who finds your ngrok URL can send it fake events.

   GitHub doesn't generate it: you make one up. Generate a random one:

   ```sh
   openssl rand -hex 32
   ```

   This prints 64 hexadecimal characters, e.g. `9f2c4e…b71a`. Your value will differ: never reuse the example.
   You paste **the same value in two places**:

   | Where | When |
   |---|---|
   | The App form's **Webhook secret** field | step 4.2, just below |
   | `GITHUB_WEBHOOK_SECRET` in the bot's `.env` | step 5 |

   Keep it somewhere safe until step 5, e.g. your password manager. Never commit it. GitHub never shows the
   secret again after you save the App. If you lose it, or the two copies don't match (deliveries fail with
   `401`), generate a new one, paste it in the App's settings (**General → Webhook secret**) and in `.env`, then
   restart the app.

2. Open **New GitHub App** in your **personal account** settings, not the sandbox repo's settings (a repo's
   Settings tab has no Developer settings). Either use the direct link <https://github.com/settings/apps/new>,
   or click your avatar (top-right) → **Settings** → **Developer settings** (bottom of the left sidebar) →
   **GitHub Apps** → **New GitHub App**. Fill in:

   | Field | Value |
   |---|---|
   | GitHub App name | `sdd-agent-<your-handle>` (globally unique; comments show as `<name>[bot]`) |
   | Homepage URL | your sandbox repo URL |
   | Webhook → Active | ✅ |
   | Webhook URL | `https://<NGROK_DOMAIN>/webhooks/github` |
   | Webhook secret | the value from step 4.1 |
   | Repository permissions | **Issues**, **Pull requests**, **Contents**, **Checks**: Read and write. **Metadata**: Read-only (set automatically) |
   | Subscribe to events | **Issues**, **Issue comment**, **Pull request** (these appear once the permissions above are set) |
   | Where can this GitHub App be installed? | **Only on this account** |

   Leave everything else at its default, then **Create GitHub App**.

3. On the App's **General** page, note the **App ID**. This is your `GITHUB_APP_ID`.
4. On the same page, under **Private keys**, click **Generate a private key**. A `.pem` file downloads. Move it
   **outside any repo** and lock it down:

   ```sh
   mkdir -p ~/.config/sdd-agent
   mv ~/Downloads/sdd-agent-*.private-key.pem ~/.config/sdd-agent/github-app.pem
   chmod 600 ~/.config/sdd-agent/github-app.pem
   ```

5. **Install App** (left sidebar of the App's settings) → your account → **Only select repositories** → pick the
   sandbox repo **only**. Until a later spec adds a target-repo filter, the bot greets every repo the App is
   installed on. To check: the sandbox repo's **Settings → Integrations → GitHub Apps** lists your App.

When you create the App, GitHub sends a `ping` webhook. It fails because the app isn't running yet. That's
expected.

## 5. Bot repo

```sh
git clone https://github.com/Hugoer/sdd-agent.git && cd sdd-agent
nvm use
npm ci                 # also generates the Prisma client
cp .env.example .env
```

Fill in `.env` with the four values above. `DATABASE_URL` and `PORT` can stay as in `.env.example`:

```sh
PORT=3000
DATABASE_URL=postgresql://sdd_agent:sdd_agent@localhost:5432/sdd_agent
GITHUB_WEBHOOK_SECRET=<step 4.1>
GITHUB_APP_ID=<step 4.3>
GITHUB_APP_PRIVATE_KEY_PATH=/Users/<you>/.config/sdd-agent/github-app.pem
NGROK_DOMAIN=<step 2>
```

`.env` and `*.pem` are gitignored. Never commit them. Use an absolute path for the key: `~` is not expanded.

## 6. PostgreSQL

```sh
npm run db:up        # starts postgres:16-alpine on 127.0.0.1:5432 and waits until healthy
npm run db:migrate   # applies the migrations
```

**Your data** lives in a named Docker volume and survives `npm run db:down` / `db:up`, `docker compose
restart`, `docker compose down` / `up` and a Docker Desktop restart. Only `docker compose down -v` or
`npm run db:reset` deletes it (`db:reset` asks first).

After a Docker Desktop restart (or a reboot), the Postgres container may stay stopped. Run `npm run db:up` again
before `npm run dev`. Your data is still there.

## 7. Run

Two terminals in the bot repo (`nvm use` in each):

```sh
npm run tunnel   # terminal 1: ngrok → localhost:3000 on your static domain
npm run dev      # terminal 2: the app, restarts on file changes
```

Check the app log line `Webhook URL: https://<NGROK_DOMAIN>/webhooks/github`. It must match the App's webhook
URL exactly.

## 8. Smoke test

1. Open an issue in the sandbox repo.
2. Within about 5 seconds, `<your-app>[bot]` posts the hello comment with the delivery ID.
3. Check the stored event:

   ```sh
   npm run db:events
   ```

   You should see one `issues` / `opened` row with status `DONE` and attempts `1`. The hello comment's own
   `issue_comment` webhook appears as `IGNORED` / `not-handled`: the bot never replies to itself.

You can also redeliver the App's earlier failed `ping` (step 9): it's stored as `IGNORED` / `ping`.

## 9. Troubleshooting

| Symptom | Where to look | Cause / fix |
|---|---|---|
| No comment, nothing in the app log | App settings → **Advanced → Recent deliveries** (status, response, **Redeliver**) | Is the webhook URL right? Are the tunnel and the app both running? |
| Delivery shows `502` | ngrok inspector <http://localhost:4040> | The app isn't running on `PORT`. Start `npm run dev`, then **Redeliver** |
| Delivery shows `401` | app log | `GITHUB_WEBHOOK_SECRET` doesn't match the App's webhook secret. Fix it, restart, redeliver |
| Delivery shows `202`, but no comment, and the row goes `FAILED` after ~35 s | `npm run db:events` (`last_error`) | Wrong App ID or private key, or the App isn't installed on the repo |
| `npm run dev` exits at startup listing variables | the error lists names and reasons, never values | Fix those variables in `.env` |
| `npm run tunnel` says `NGROK_DOMAIN is not set` | `.env` | Set it to your static domain (bare hostname) |
| `npm run dev` fails with a database connection error, or a delivery shows `500` | `docker compose ps` | Postgres isn't running (e.g. after a Docker Desktop restart). Run `npm run db:up`, then restart the app / **Redeliver** |
| `npm run db:up` fails: port 5432 already allocated | `docker ps` | Another Postgres is using 5432. Stop it |

GitHub never retries a failed delivery automatically. While the app is down, deliveries are lost until you
**Redeliver** them. A redelivery of an already-stored delivery is accepted (`202`) and ignored, so it never
posts a second hello.

## 10. Tests

```sh
npm run db:test:up        # separate Postgres on 127.0.0.1:5434, data in memory (never touches dev data)
npm test                  # unit tests
npm run test:integration  # integration tests against the test database (GitHub is faked)
npm run db:test:down
```

Before handing over a change, also run `npm run typecheck` and `npm run lint`.

## Reference: labels

Labels are not created during this setup. Spec 3 creates them when the bot starts, if they're missing.

- `status: draft | grilling | spec-review | ready-for-dev | executing | in-review | needs-human`: set by the
  bot only.
- `workflow: full-sdd | spec-code | code-only` and `grill: skip`: set by humans only.
