# Setup: GitHub AI Agent on your machine

> **Created:** 2026-11-10 · **Why this file exists:** setup guide for spec #1
> (`docs/specs/spec-github-agent-walking-skeleton.md`, "Setup & configuration"). It takes a new developer from
> zero to the bot's first comment on a sandbox issue. Living doc: each later spec that changes setup updates it.
> **Updated:** 2026-11-11 for spec #3 (`docs/specs/spec-github-agent-github-providers.md`): `TARGET_REPO`, the
> startup checks, the labels, the smoke script.
> **Updated:** 2026-11-12 for spec #2 (`docs/specs/spec-github-agent-intake-authorization.md`): no hello comment
> any more, the `external_ref` column, redelivery of a `FAILED` event, ignore reasons, who can do what, signed
> test requests.
> **Updated:** 2026-11-16 for spec #4 (`docs/specs/spec-github-agent-llm-foundation.md`): the Google API key and
> base branch, `workflow.json` with skills and models, the five model labels, the secret scanner, the LLM smoke
> script, usage data, the LLM errors.

**End state:** you open an issue in your sandbox repo, and within a few seconds its webhook is stored, checked
and accepted: `npm run db:events` shows the row `DONE` and the app log shows `accepted ISSUE_OPENED`. The bot
posts nothing yet; the workflow that answers comes with later specs. The model call it will use is in place:
`npm run llm:smoke` (section 12) runs it once on a real issue with Gemini.

**How the pieces connect:** GitHub sends a webhook → your ngrok static domain → the NestJS app on
`localhost:3000` → PostgreSQL (Docker) → a background worker → intake: what the event is and whether its sender
may do it, asked through the GitHub App.

You will collect six values on the way. They all go into `.env` in step 5:

| Value | From | `.env` variable |
|---|---|---|
| Sandbox repo, as `owner/name` | step 3 | `TARGET_REPO` |
| ngrok static domain | step 2 | `NGROK_DOMAIN` |
| Webhook secret | step 4 (`openssl`) | `GITHUB_WEBHOOK_SECRET` |
| App ID | step 4 (App settings page) | `GITHUB_APP_ID` |
| Private key file path | step 4 (downloaded `.pem`) | `GITHUB_APP_PRIVATE_KEY_PATH` |
| Gemini API key | step 5 (Google AI Studio) | `GOOGLE_API_KEY` |

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
- A **Google account** for Google AI Studio (the Gemini API key, step 5).
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
   mkdir -p src .github-agent/skills/{grill,spec,plan,code,quality-gate}
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

   `.github-agent/workflow.json`: which skill folder each step uses, and which model each level uses. The bot
   reads it at `TARGET_BASE_BRANCH` (`main`) before every step. Every step a workflow label uses needs a skill:
   there is no built-in fallback prompt, and a run with a missing one stops (`missing skills: …`, step 9):

   ```json
   {
     "skills": {
       "grill": ".github-agent/skills/grill",
       "spec": ".github-agent/skills/spec",
       "plan": ".github-agent/skills/plan",
       "code": ".github-agent/skills/code",
       "qualityGate": ".github-agent/skills/quality-gate"
     },
     "models": {
       "standard": { "default": "gemini-4-hydrogen" },
       "max": { "default": "gemini-4-carbon" }
     }
   }
   ```

   - `standard` is used by default; `max` for a step whose `model: max-<step>` label is on the issue ("Reference:
     labels"). Each level needs `default` and may name a model per step (`"spec": "gemini-4-carbon"`), which
     that step then uses for every issue.
   - Model names must be in your key's model list (Google AI Studio). If a model keeps answering "high demand"
     (step 9, `provider-unavailable`), point the level at another one here: no bot change is needed.

   The five skills, one line each until the step's own spec writes the real one. A skill is text only: every
   file in its folder goes into the prompt (`SKILL.md` first, at most 204,800 bytes); nothing in it is run:

   ```sh
   p() { echo "Placeholder until spec $2 (\`$3\`) writes this step's skill." > .github-agent/skills/$1/SKILL.md; }
   p grill 6 grill-me; p spec 7 spec-plan-approvals; p plan 7 spec-plan-approvals
   p code 9 coder; p quality-gate 10 quality-gate
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
   sandbox repo **only**. The bot works only on `TARGET_REPO` (step 5): an event from any other repo is stored
   as `IGNORED` / `other-repo`. To check: the sandbox repo's **Settings → Integrations → GitHub Apps** lists your App.

When you create the App, GitHub sends a `ping` webhook. It fails because the app isn't running yet. That's
expected.

## 5. Bot repo

```sh
git clone https://github.com/Hugoer/sdd-agent.git && cd sdd-agent
nvm use
npm ci                 # also generates the Prisma client
cp .env.example .env
```

**Gemini API key.** In [Google AI Studio](https://aistudio.google.com) choose **Get API key → Create API key**,
in a Google Cloud project. Check that your models are in the key's list (`gemini-4-hydrogen`, `gemini-4-carbon`).
On a key without billing, Google may use your prompts to improve its products; on a project with billing it
doesn't. The bot sends issue text to the model, so use a billed project for anything that isn't a test.

Fill in `.env` with the six values above. `DATABASE_URL`, `PORT` and `TARGET_BASE_BRANCH` can stay as in
`.env.example`:

```sh
PORT=3000
DATABASE_URL=postgresql://sdd_agent:sdd_agent@localhost:5432/sdd_agent
GITHUB_WEBHOOK_SECRET=<step 4.1>
GITHUB_APP_ID=<step 4.3>
GITHUB_APP_PRIVATE_KEY_PATH=/Users/<you>/.config/sdd-agent/github-app.pem
TARGET_REPO=<you>/sdd-agent-sandbox
NGROK_DOMAIN=<step 2>
GOOGLE_API_KEY=<Google AI Studio>
TARGET_BASE_BRANCH=main
```

`.env` and `*.pem` are gitignored. Never commit them. Use an absolute path for the key: `~` is not expanded.

- `TARGET_BASE_BRANCH` is the sandbox branch `workflow.json` and the skills are read from (default `main`).
- **Never set a LangChain tracing switch** (`LANGSMITH_TRACING`, `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING`,
  `LANGCHAIN_TRACING_V2`) to `true`, in `.env` or in your shell: it would send every prompt to LangSmith. The app
  refuses to start and names the switch.

## 6. PostgreSQL

```sh
npm run db:up        # starts postgres:16-alpine on 127.0.0.1:5432 and waits until healthy
npm run db:migrate   # applies the migrations
```

**After pulling new code**, run `npm run db:migrate` again before `npm run dev`: a spec can add a column or a
table (spec 2 added `external_ref` and filled it for the rows you already have; spec 4 added the
`execution_logs` table). Nothing is deleted.

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

**First start.** Before it listens, the app checks GitHub: it finds the App's installation on `TARGET_REPO`,
checks its permissions, looks up the bot user and creates the bot labels that are missing. The first start
creates the 16 labels of "Reference: labels"; later starts find them. (A sandbox set up before spec 4 gets the
five model labels at its next start: `5 created, 11 already present`.) The app calls no model at startup.

```text
Labels on <you>/sdd-agent-sandbox: 16 created, 0 already present
GitHub ready: <your-app>[bot] on <you>/sdd-agent-sandbox (installation <id>)
```

If a check fails, the app prints one message and exits with code 1; the port is never opened. Fix the cause,
then stop `npm run dev` (Ctrl+C) and start it again: it doesn't watch `.env`.

| Message starts with | Cause | Fix |
|---|---|---|
| `GitHub rejected the App credentials` | `GITHUB_APP_ID` and the private key don't belong to the same App | Check both (steps 4.3 and 4.4); generate a new key if needed |
| `The GitHub App is not installed on <repo>` | The App isn't installed on `TARGET_REPO`, or the name is wrong | Install it (step 4.5) or fix `TARGET_REPO` |
| `The GitHub App is missing permissions on <repo>` | A permission of step 4.2 is missing (the message names it) | App settings → **Permissions & events**: fix and save. Then accept the new permissions on the installation (your account's **Settings → Applications → Installed GitHub Apps → Configure**) |
| `GitHub refused to create a label` | The App lacks **Issues: Read and write** | As above |
| `GitHub is unreachable` | No network, or GitHub is down | Check the connection, then start again |
| `GitHub startup failed:` | Any other GitHub answer (the message holds it) | Read GitHub's message |

## 8. Smoke test

1. Open an issue in the sandbox repo.
2. Within about 5 seconds the app log shows two lines for it:

   ```text
   LOG [IntakeService] delivery=<id> event=issues action=opened sender=<you> accepted ISSUE_OPENED <you>/sdd-agent-sandbox#<n>
   LOG [EventsWorker] delivery=<id> event=issues action=opened DONE
   ```

3. Check the stored event:

   ```sh
   npm run db:events
   ```

   You should see one `issues` / `opened` row with `external_ref` `<you>/sdd-agent-sandbox#<n>`, your login as
   sender, status `DONE` and attempts `1`. No comment appears on the issue.

You can also redeliver the App's earlier failed `ping` (step 9): it's stored as `IGNORED` / `ping`.

Try a label: add `workflow: full-sdd` → `accepted LANE_ADDED full-sdd`; add `bug` → `IGNORED` / `other-label`;
add `model: max-spec` → `IGNORED` / `model-label` (you're an Approver, so it stays). Comment on the issue →
`accepted COMMENT`; the log never contains the comment's text.

## 9. Troubleshooting

| Symptom | Where to look | Cause / fix |
|---|---|---|
| Nothing in the app log | App settings → **Advanced → Recent deliveries** (status, response, **Redeliver**) | Is the webhook URL right? Are the tunnel and the app both running? |
| I labeled or commented and nothing happened | `npm run db:events` (`status`, `ignore_reason`) | An `IGNORED` row says why in `ignore_reason`: see "Ignore reasons" below. `unauthorized` or `label-reverted`: the sender lacks the access ("Reference: who can do what") |
| Delivery shows `502` | ngrok inspector <http://localhost:4040> | The app isn't running on `PORT`. Start `npm run dev`, then **Redeliver** |
| Delivery shows `401` | app log | `GITHUB_WEBHOOK_SECRET` doesn't match the App's webhook secret. Fix it, restart, redeliver |
| Delivery shows `202` and the row is `FAILED` with attempts `1` | `npm run db:events` (`last_error`) | A permanent GitHub error, e.g. `404` (the issue was deleted or transferred) or `403` (a missing permission). It is not retried; fix the cause, then **Redeliver** it |
| Delivery shows `202` and the row goes `FAILED` with attempts `3` | `npm run db:events` (`last_error`) | GitHub was unreachable, answered `5xx` or rate-limited three times (about 35 s, longer after a rate limit). Check the connection, then **Redeliver** it |
| The row is `IGNORED` / `other-repo` | the delivery's repository | The App is installed on another repo too; the bot only works on `TARGET_REPO` |
| `npm run dev` exits at startup with a GitHub message | the message | See the table in step 7 |
| `npm run github:smoke` prints `FAIL` | the `FAIL` line (method and what it saw) | Check the preconditions in step 11 |
| `npm run dev` exits at startup listing variables | the error lists names and reasons, never values | Fix those variables in `.env` |
| `npm run dev` exits: `LANGSMITH_TRACING` (or another switch) `must be unset or false` | the error names the switch | A LangChain tracing switch is `true` in `.env` or your shell. Remove it (`unset LANGSMITH_TRACING`) and start again |
| `npm run llm:smoke` prints `FAIL` | the `FAIL` line (check, code, message) | See "LLM and setup errors" below and the preconditions in step 12 |
| A bot comment shows `[REDACTED: github-token]` (or another kind) | app log: `secret-scan <method> <issue>: redacted <n> (<kinds>)` | The secret scanner replaced something shaped like a secret before posting ("Reference: what the bot never posts"). A documentation example that looks like a token is replaced too |
| A bot comment says "Read the issue description carefully…" | the comment's marker and kinds | Part of that text looks like instructions aimed at the bot. The bot treats it as data and keeps working; one warning per text and issue. Delete the comment to get a new one the next time that text is used |
| `npm run tunnel` says `NGROK_DOMAIN is not set` | `.env` | Set it to your static domain (bare hostname) |
| `npm run dev` fails with a database connection error, or a delivery shows `500` | `docker compose ps` | Postgres isn't running (e.g. after a Docker Desktop restart). Run `npm run db:up`, then restart the app / **Redeliver** |
| `npm run db:up` fails: port 5432 already allocated | `docker ps` | Another Postgres is using 5432. Stop it |

GitHub never retries a failed delivery automatically. While the app is down, deliveries are lost until you
**Redeliver** them. A redelivery is always accepted (`202`):

- of a `FAILED` row: the same row is queued again (attempts back to `0`) and runs from the start; the log shows
  `requeued`. Safe: every bot comment is guarded by a hidden marker, so none is posted twice.
- of a row in any other status: nothing changes; the log shows `duplicate`.

**Ignore reasons.** What `ignore_reason` holds for an `IGNORED` row:

| Reason | Meaning |
|---|---|
| `ping` | GitHub's webhook test |
| `other-repo` | not `TARGET_REPO` |
| `unsupported-event` | an event or action the bot doesn't use (e.g. closing or reopening an issue) |
| `invalid-payload` | a needed field is missing or malformed |
| `own-event` | sent by the bot itself, and not a `pull_request` event |
| `label-deleted` | a label event without a label (the label was deleted from the repo) |
| `status-label` | a `status: *` label was added or removed |
| `other-label` | a label the bot doesn't use |
| `skip-removed` | `grill: skip` was removed |
| `pr-comment` | a comment on a pull request |
| `comment-edited` | a comment was edited (the bot reads a comment as it was created) |
| `comment-deleted` | a comment was deleted |
| `not-bot-pr` | a pull request the bot didn't open |
| `unauthorized` | the sender's level is too low; nothing was done |
| `label-reverted` | a lane or skip label added with no access, or a model label added below Approver, was removed, with one comment per label |
| `approve-denied` | a Participant's `/approve` was answered |
| `model-label` | a `model: max-*` label added by an Approver, or removed (nothing to do until a step runs) |

Rows stored before spec 2 can still show `not-handled` or `no-installation`; they are no longer written.

**LLM and setup errors.** A failed model call is an `LlmError` with a code: in the smoke output, in
`execution_logs.error_code` and, from spec 5 on, in the event's `last_error`. Messages never hold the key, the
prompt or the answer. Retried codes get 3 attempts (5 s, then 30 s, at least Google's own delay):

| Code | Retried | Cause | Fix |
|---|---|---|---|
| `rate-limited` | yes | Google answered `429` (quota or rate limit) | Wait; check the key's quota in Google AI Studio |
| `provider-unavailable` | yes | `5xx` (often `503` "high demand"), no response, or no answer within 300 s | Usually passes on its own. If one model stays busy for hours, point its level at another model in `workflow.json` |
| `bad-api-key` | no | Google refused the key (`400` `API_KEY_INVALID`, or `401`) | Check `GOOGLE_API_KEY` in `.env`, then restart |
| `access-denied` | no | `403`: the key may not make this call | Check the key's project: API enabled, billing |
| `credits-exhausted` | no | `402`: the account's credits are used up | Add credits or billing in Google AI Studio |
| `unknown-model` | no | `404`: Google has no model by that name for this key | Fix the name in `workflow.json`; it must be in the key's model list |
| `answer-blocked` | no | Google blocked the prompt or the answer (safety, recitation, …) | Read the issue's text; change the content that triggers it |
| `answer-cut` | no | The answer hit the model's output limit | Shorten the input, or use a step's model with a larger limit |
| `bad-request` | no | Any other `4xx`, e.g. a prompt larger than the model's context | Read the message (status and Google's reason) |
| `invalid-answer` | no | Three answers in a row without the required format (each one re-asked) | Read the rows' answers ("Usage data"); a stronger model or a clearer skill |

Setup errors (`StepConfigError`) are never retried; the message is safe to post on the issue:

| Message | Fix |
|---|---|
| `invalid workflow.json: <what and where>` | Fix `.github-agent/workflow.json` on `TARGET_BASE_BRANCH`: missing file, not JSON, an unknown key, a missing `default`, a path with `..` or a leading `/`, a model name with other characters than letters, digits, `.`, `_`, `-` |
| `missing skills: <steps>` | Map each named step in `skills` to a folder with a non-empty `SKILL.md` at its root, on `TARGET_BASE_BRANCH` |
| `skill too large: <step> (<N> bytes, limit 204,800)` | Make the skill's text files smaller (images, PDFs, archives, fonts, audio and video don't count) |
| `unreadable skill file: <path>` | The file is over 1 MB or not UTF-8 text: remove or convert it |
| `resolveRef: no branch or commit "<branch>" in <repo> (422)` (a GitHub error) | `TARGET_BASE_BRANCH` names a branch that doesn't exist in `TARGET_REPO` |

## 10. Tests

```sh
npm run db:test:up        # separate Postgres on 127.0.0.1:5434, data in memory (never touches dev data)
npm test                  # unit tests
npm run test:integration  # integration tests against the test database (GitHub is faked)
npm run db:test:down
```

Before handing over a change, also run `npm run typecheck` and `npm run lint`.

## 11. Check the GitHub App with the smoke script

`npm run github:smoke` calls every GitHub method of the bot once against `TARGET_REPO` and prints one `PASS` /
`FAIL` line per check; the exit code is 0 only if all pass. It writes to the sandbox: comments, status labels
and, with `--branch`, a pull request and a check run. It never closes or deletes anything: close the issue and the
pull request by hand when you're done. Tokens are printed as their length only.

Stop `npm run dev` first: the script rebuilds `dist/` (`nest build`).

**Preconditions**

1. A test issue in the sandbox, opened by you, with the labels `grill: skip` and `bug` added by hand.
2. `.github-agent/workflow.json` on `main` (step 3).
3. Only for the pull request checks: a branch one commit ahead of `main`. In the GitHub UI, create `smoke/spec-3`
   from `main` and commit a small README edit on it. You need that commit's full 40-character SHA.

```sh
npm run github:smoke -- --issue <n>                                        # issue, file and push-token checks
npm run github:smoke -- --issue <n> --dir <directory>                      # list another directory, e.g. a skill
npm run github:smoke -- --issue <n> --branch smoke/spec-3 --sha <head SHA> # plus the pull request checks
```

`--base` (default `main`) is the branch the file checks read; `--dir` (default `.github-agent`) is the directory
listed.

**Access lines** (who may do what, "Reference: who can do what"): `getAccessLevel` is `approver` for the issue's
author (you own the repo), `none` for `octocat` and for an invented login; `isSelf` is `false` for the issue's
author and `true` for `<your-app>[bot]`.

**After a passing run:** the issue has exactly one `status: *` label (`status: spec-review`), `grill: skip` is
gone, `bug` stays, and there is one more smoke comment. With `--branch`: one pull request from that branch (a
second run finds it instead of opening another) and one `Quality Gate` check run on the commit, conclusion
`success`.

## 12. Check the LLM with the smoke script

`npm run llm:smoke` runs the whole model chain once for one issue and one step: it reads `workflow.json` and the
step's skill at `TARGET_BASE_BRANCH`, picks the model from the issue's labels, checks the issue's title and
description, calls the model through the bot's own code, posts one comment and reads the stored row back. One
`PASS` / `FAIL` / `SKIP` line per check; the exit code is 0 only if none fails. It never prints the key, a token,
the issue's text or the prompt. A run costs one or two short model calls.

Stop `npm run dev` first: the script rebuilds `dist/` (`nest build`).

**Preconditions**

1. `npm run db:migrate` done (the `execution_logs` table, step 6), and Postgres running.
2. `workflow.json` and the five skills on the sandbox's `main` (step 3).
3. An open sandbox issue `N` with a short, harmless description.

```sh
npm run llm:smoke -- --issue <n> --step spec                              # the whole chain
npm run llm:smoke -- --issue <n> --step spec --base <branch>              # read the map and skills at another branch
npm run llm:smoke -- --issue <n> --step spec --model no-such-model-xyz    # passes when the call fails as unknown-model
npm run llm:smoke -- --issue <n> --step spec --reask                      # forces one re-ask: two rows
```

`--step` is one of `grill`, `spec`, `plan`, `code`, `qualityGate`.

| # | Check | Prints |
|---|---|---|
| 1 | The base branch resolves; `workflow.json` is valid | the commit SHA, the skills map, the models |
| 2 | Each lane's steps have skills (informative: never fails the smoke) | per lane: `ok`, or the missing steps |
| 3 | The step's skill loads | files and sizes, characters, skipped binary files |
| 4 | The step's model from the issue's labels | name and level (`standard`, or `max` with the step's model label) |
| 5 | The title and description against the injection patterns | cut or whole, the kinds, the warning: `posted`, `already-there` or `none` |
| 6 | One real call: a one-sentence summary as JSON | model, duration, the four token values, the four sizes, the row id |
| 7 | One comment on the issue: the summary, a token-shaped test string, the model line | the comment's URL (the test string arrives as `[REDACTED: github-token]`) |
| 8 | The rows of this run read back from the database | count, status, attempt, model, level |

**After a passing run:** one more comment on issue `N` from `<your-app>[bot]` with the summary,
`[REDACTED: github-token]` and the line `Model: gemini-4-hydrogen (standard)`; one new row per attempt in
`execution_logs` with `run_id` `smoke-<id>` ("Usage data"). If the issue's text matches a pattern, check 5 also
posts one warning comment per text, once.

## Usage data

Every model call attempt is one row in `execution_logs`: the step, the model and its level, the status, the
tokens Google reported (empty = not reported, never zero), the size of each part of the prompt in characters, the
prompt as sent and the answer as received. A re-ask is a new row; a worker retry makes new rows. Totals per step,
model and level:

```sh
npm run db:usage   # calls, errors, re-asks, the four token sums, the four size sums, average duration
```

- **Input tokens** are everything sent, the cached part included; **output tokens** are everything generated,
  the model's thinking included. `cached` and `reasoning` are the parts of those totals.
- **The sizes** (`frame`, `skill`, `untrusted`, `other`) are counted by the bot, so they compare across models and
  providers; tokens are counted differently by each provider.

The calls of one issue, oldest first, and the prompt and answer of one row (replace `14` and the id):

```sh
set -a; source .env; set +a
calls_of() {  # calls_of <issue number>
  docker compose exec -T postgres psql -U sdd_agent -d sdd_agent -c "SELECT created_at::time(0) AS at, id, run_id, \
    step, model, model_level AS level, attempt, status, error_code, input_tokens AS inp, output_tokens AS out, \
    reasoning_tokens AS think, duration_ms FROM execution_logs WHERE external_ref = '$TARGET_REPO#$1' ORDER BY created_at"
}
row_of() {    # row_of <row id>: the prompt as sent and the answer as received
  docker compose exec -T postgres psql -U sdd_agent -d sdd_agent -x -c "SELECT step, model, status, error_code, \
    jsonb_pretty(prompt) AS prompt, jsonb_pretty(answer) AS answer FROM execution_logs WHERE id = '$1'"
}
calls_of 14
row_of <id>
```

The stored prompt holds whatever users wrote in the issue, inside `untrusted-data-…` blocks, as `webhook_events`
already does. It never holds the bot's own keys.

## History of an issue

Every stored event has an `external_ref`: `<owner>/<repo>#<number>` of its issue or pull request (a comment on a
pull request gets the pull request's number). To list one issue's events, oldest first (replace `42`):

```sh
set -a; source .env; set +a
events_of() {  # events_of <issue or PR number>
  docker compose exec -T postgres psql -U sdd_agent -d sdd_agent -c "SELECT received_at, event_name, action, \
    status, ignore_reason FROM webhook_events WHERE external_ref = '$TARGET_REPO#$1' ORDER BY received_at"
}
events_of 42
```

Rows with no issue or pull request (`ping`, a broken payload) have an empty `external_ref`.

## Send a signed test request

To see what the bot does with an event you can't produce in the GitHub UI (a sender with no access, another
repo, a broken payload), sign a request with your webhook secret and send it to the running app. Run this in
the bot repo, with `npm run dev` running; set `N` to an open sandbox issue:

```sh
set -a; source .env; set +a
N=1
send() {    # send <event> <json body> [delivery ID] → prints the HTTP status
  SIG=$(printf '%s' "$2" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | sed 's/^.* //')
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:${PORT:-3000}/webhooks/github" \
    -H 'Content-Type: application/json' -H "X-GitHub-Event: $1" \
    -H "X-GitHub-Delivery: ${3:-manual-$(date +%s)-$RANDOM}" -H "X-Hub-Signature-256: sha256=$SIG" -d "$2"
}
common() {  # common <sender login> [repo] → the fields every body needs
  printf '"repository":{"full_name":"%s"},"sender":{"login":"%s"},"issue":{"id":1,"number":%s}' \
    "${2:-$TARGET_REPO}" "$1" "$N"
}
LABELED='"label":{"name":"workflow: code-only"}'
APPROVE='"comment":{"id":1,"body":"/approve","created_at":"2026-11-11T10:00:00Z"}'
```

Examples (each prints `202`; read the result with `npm run db:events` and the app log):

```sh
send issues "{\"action\":\"opened\",$(common octocat)}"                  # IGNORED unauthorized
send issue_comment "{\"action\":\"created\",$(common octocat),$APPROVE}" # IGNORED unauthorized, no reply
send issues "{\"action\":\"labeled\",$(common octocat),$LABELED}"        # removes the label if issue N has it
send issues '{"action":"labeled"}'                                       # IGNORED invalid-payload
```

The third one acts on the real issue: if `workflow: code-only` is on issue `N`, the bot removes it and posts one
comment explaining why (row `IGNORED` / `label-reverted`). The fake `issue.id` doesn't matter: the bot addresses
the issue by its number. A delivery ID you pass as the third argument is stored once; sending it again is a
redelivery (step 9).

## Reference: who can do what

The bot asks GitHub for the sender's role on the repo each time it processes an event (never cached):

| Level | GitHub role on the repo | May |
|---|---|---|
| **Participant** | Triage or higher | open an issue, add or remove a `workflow: *` label, add `grill: skip`, comment |
| **Approver** | Write, Maintain or Admin | everything a Participant may, plus comment `/approve`, push to the bot's pull request, and add or remove a `model: max-*` label |
| none | Read, or no role | nothing: the event is `IGNORED` / `unauthorized` |

- A `workflow: *` or `grill: skip` label added by someone with no access is removed again, with one comment per
  issue and label (`label-reverted`). The comment names the user without `@`, so nobody is notified.
- A Participant's `/approve` gets one reply that mentions them (`approve-denied`); nothing is approved.
- A `model: max-*` label added by a Participant or someone with no access is removed again, with one comment per
  issue and label (`label-reverted`, the user without `@`). An Approver's stays (`model-label`); it switches only
  that step of that issue to the `max` model, the next time the step runs.
- `/approve` counts only when it is the whole comment (spaces and case don't matter): `/approve thanks` or a
  quoted `> /approve` is an ordinary comment.
- **A personal repo has no Triage role:** every collaborator has Write, so everyone with access is an Approver.
  The Participant level only shows on a repo owned by an organization.

## Reference: labels

The bot creates these 16 labels when it starts, if they're missing (names compared case-insensitively). Don't
create them by hand. The bot never edits or deletes a label, so a color or description you change stays.
`status: *` labels are set by the bot only; `workflow: *`, `grill: skip` and `model: max-*` by humans only, the
model labels by Approvers only. A label never holds a model name: the models are in `workflow.json`.

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
| `model: max-grill` | `fef2c0` | Approvers only: Grill Me uses the most capable model. |
| `model: max-spec` | `fef2c0` | Approvers only: the Spec is written with the most capable model. |
| `model: max-plan` | `fef2c0` | Approvers only: the Plan is written with the most capable model. |
| `model: max-code` | `fef2c0` | Approvers only: the Coder uses the most capable model. |
| `model: max-quality-gate` | `fef2c0` | Approvers only: the Quality Gate uses the most capable model. |

## Reference: what the bot never posts

Everything the bot posts (comments, pull request title and body, pull request comments, the Quality Gate
summary) passes the secret scanner first. A match is replaced by `[REDACTED: <kind>]` and logged as
`secret-scan <method> <issue>: redacted <n> (<kinds>)`, never with the value:

| Kind | Matches |
|---|---|
| `github-token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` and 36 or more letters and digits; `github_pat_` and 22 or more |
| `google-api-key` | `AIza` and 35 letters, digits, `_` or `-` |
| `aws-access-key` | `AKIA` or `ASIA` and 16 capital letters and digits |
| `slack-token` | `xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`, `xoxs-` and 10 or more letters, digits and `-` |
| `private-key` | a `-----BEGIN … PRIVATE KEY-----` block, to its `END` line or the end of the text |
| `own-secret` | the exact values of `GITHUB_WEBHOOK_SECRET` and `GOOGLE_API_KEY` (8 characters or longer) |

It is a list, not a proof: a secret split over two lines, encoded, or of another format is not found.
