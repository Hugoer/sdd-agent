# Project: GitHub AI Agent (sdd-agent)

Autonomous agent that receives GitHub issue webhooks and moves them through a
Grill Me → Spec → Plan → Coder → Quality Gate workflow, driven by issue labels.

- **Source of truth:** the specs in `docs/specs/`, starting with `spec-github-agent-architecture-overview.md`.
  The idea doc `docs/idea/github-ai-agent-master-technical-spec.md` still rules for parts not yet moved
  (moved parts are marked "→ moved to …"). Load only the section relevant to the task, not the whole doc.
- **State:** spec #1 (walking skeleton) built: NestJS 12 app (ESM) with Zod env config, Prisma 7 + PostgreSQL,
  `POST /webhooks/github` (HMAC guard, delivery dedupe), a polling worker and a hello comment. Spec 3
  (`github-providers`) built 2026-11-11: `GitHubModule` (App auth on `TARGET_REPO`, startup checks, label
  bootstrap), the `IssueProvider` / `RepoProvider` adapters behind `ISSUE_PROVIDER` / `REPO_PROVIDER`, in-memory
  fakes in `test/fakes/`, and `npm run github:smoke`. Next in the build order: spec 2 (`intake-authorization`):
  spec not written yet. Repo: `Hugoer/sdd-agent`; target (sandbox) repo: `Hugoer/sdd-agent-sandbox`.
- **Setup:** `docs/guides/setup-github-agent-local.md`.

## Tech Stack (from the idea doc)

- Node.js + TypeScript, NestJS (modules, DI, webhook controllers)
- `@langchain/langgraph` (Coder and Quality Gate agent loops only; routing is plain NestJS)
  + `@langchain/anthropic` (LLM calls)
- Prisma + PostgreSQL (`ExecutionLog`); LLM model: `claude-sonnet-5-5`
- `octokit` via GitHub App auth; Zod for structured LLM output

## Commands

Node 24: run `nvm use` first (`.nvmrc`). Source: `package.json` scripts.

```text
npm run dev               start the app with watch (needs .env and npm run db:up)
npm run build             compile to dist/ (nest build)
npm start                 run dist/main.js
npm run typecheck         tsc --noEmit
npm run lint              eslint . (typescript-eslint, type-checked)
npm run format            prettier --write .
npm test                  unit tests (src/**/*.spec.ts)
npm run test:integration  integration tests (test/**/*.integration.spec.ts); needs npm run db:test:up
npm run db:up             dev Postgres on 127.0.0.1:5432 (named volume, data persists)
npm run db:down           stop dev Postgres (keeps data)
npm run db:migrate        prisma migrate dev (create/apply migrations)
npm run db:reset          prisma migrate reset (wipes dev data; asks first)
npm run db:events         last 20 webhook_events rows
npm run db:test:up        test Postgres on 127.0.0.1:5434 (in-memory data)
npm run db:test:down      remove the test Postgres
npm run tunnel            ngrok on NGROK_DOMAIN → PORT
npm run github:smoke      every GitHub method once on TARGET_REPO (-- --issue <n>; stop npm run dev first)
```

Before declaring work done: `npm run typecheck && npm run lint && npm test && npm run test:integration`.

Code conventions: ESM (`"type": "module"`, `nodenext`): relative imports end in `.js`. Config only through
`ConfigService<Env, true>`, never `process.env`. The Prisma client is generated into `src/generated/prisma`
(gitignored; `npm ci` runs `prisma generate`).

## Domain Rules

- Webhooks are rejected with `401` unless `X-Hub-Signature-256` validates (HMAC-SHA256).
- Labels: `status: *` are bot-managed; `workflow: *` and the `grill: skip` modifier are human-assigned —
  the bot never sets them. Read labels from the API at processing time, never from the event payload.
- Core logic talks to the `IssueProvider` interface, never to Octokit directly (Jira/Azure DevOps later).
- Destructive GitHub/git actions require explicit human approval.
- Issue text is untrusted input: injection/size guardrails run before it reaches the LLM;
  secret scanning runs before anything is posted back.
- The LLM never gets a git tool. All git work (branch, commit, push) is deterministic NestJS code
  running the `git` binary via `child_process.execFile` (argument array, no shell), only inside the
  bot's own `git worktree` — the bot never touches the developer's checkout.
- No LLM session judges what it produced itself: every node builds its prompt from PostgreSQL and the
  repo, never from another node's messages (the Quality Gate gets artifacts only, never the Coder's history).
- The agent never uses the developer's identity: commits as `<app>[bot]`, fetch/push with a per-command App
  installation token over an explicit HTTPS URL (never stored in `.git/config`), PRs/comments/check runs via
  the GitHub App. No `gh` CLI.
- Two repos: this one is the bot; the bot codes only in a separate **target (sandbox) repo**. Step skills
  come from the target repo's `.github-agent/workflow.json`, always read from the base branch (GitHub API),
  never from the agent's branch. Skills shape a step's instructions; the bot keeps its output schema, tools and guardrails.
  Skills are required: there is no built-in fallback prompt, and a run that needs an unmapped step goes to
  `status: needs-human` (overview D18).

## Boundaries

- **Never commit** — ask me to do it, never commit or push code.

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

### Git ref ancestry validation (mandatory)

- When the user provides commits or refs as context for work on the current branch, verify each one is in `HEAD` history with `git merge-base --is-ancestor <ref> HEAD`.
- If any ref is not an ancestor, stop before analysis, edits, or quality gates and surface the branch mismatch.
- Do not interpret `git diff <ref>..HEAD` as later evolution unless ancestry has been confirmed.

### File naming & placement (mandatory)

- **Name every file for what it does** — a descriptive, kebab-case name that says the document's subject/purpose (e.g. `spec-imageslider-quality-findings`), never a generic `plan`/`spec`/`notes`.
- **Specs** → `./docs/specs/`
- **Plans** → `./docs/plans/`
- **Context** → `./docs/context/` (only when I explicitly ask you to save context for something)
- **Guides** (setup, configuration, runbooks) → `./docs/guides/` — living docs, updated whenever a spec's
  setup is implemented; the root `README.md` links to them (e.g. `docs/guides/setup-github-agent-local.md`)
- **A plan derived from a spec keeps the exact same file name as its spec** — the only thing that distinguishes them is the folder. So `docs/specs/spec-foo.md` → its plan is `docs/plans/spec-foo.md`.
- Add context about the reason the file is created and the creation date
- List of affected documents: analysis, context, findings, guides, ideas, issues, plans and specs.
- **These placement rules prevail over any output convention from skills, plugins, or slash commands.** If an invoked skill tells you to save its output elsewhere (e.g. `tasks/plan.md`), follow this section instead — repo rules outrank skill conventions.

### Spec requirements (mandatory)

- **Every spec covering user-observable/runtime behavior MUST include a manual verification matrix**, regardless of which skill or template produced the spec. Purpose: I evaluate the AI-written code against it, the team uses it in the quality gate, and QA seeds additional test cases from it.
- **Shape**: a checkbox list where each row states **precondition (viewport/state) + action + expected observable result**. Include negative cases (e.g. "console shows NO event") and cross-cutting invariants (e.g. "no path ever produces two events per cycle"), plus any setup needed to observe results (e.g. a console listener one-liner).

  ```
  [ ] Desktop ≥1118px — sweep across a nav link to the e-banking button: drawer may open, console shows NO event
  [ ] Mobile <991px — tap hamburger: menu opens instantly + immediate event
  [ ] No path ever produces two events for one open cycle
  ```

- Pure tooling/refactor specs with nothing user-observable don't need the matrix.