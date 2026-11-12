# Spec #2 — GitHub AI Agent: Intake & Authorization

> **Created:** 2026-11-11 · **Status:** approved 2026-11-11 (including AW1–AW8) · plan:
> `docs/plans/spec-github-agent-intake-authorization.md` (approved 2026-11-11) · built and verified 2026-11-12
> (every matrix row passed; the optional organization rows not run)
>
> **Repos:** bot [`Hugoer/sdd-agent`](https://github.com/Hugoer/sdd-agent) (this repo) · target
> [`Hugoer/sdd-agent-sandbox`](https://github.com/Hugoer/sdd-agent-sandbox) (public, owned by a personal account)
>
> **Why this file exists:** third capability spec in build order (overview §1 row 2, module id
> `intake-authorization`). Until now the worker only answered `issues.opened` with a hello comment. This spec
> decides, for every stored webhook event, whether it reaches the workflow and as what: it maps the GitHub payload
> to a neutral input, checks who sent it, and records a reason for everything it drops. The router (spec 5) and
> every step after it only ever see events that passed here.
>
> **Sources:** `docs/specs/spec-github-agent-architecture-overview.md` (normative: §3 "Inputs", "Ignored at
> intake" and "Per-event pipeline", §4 contracts, §7 rules 2–4), `docs/specs/spec-github-agent-walking-skeleton.md`
> (worker, `WebhookEvent`), `docs/specs/spec-github-agent-github-providers.md` (the ports it calls), idea doc
> `docs/idea/github-ai-agent-master-technical-spec.md` section 9 ("Who can answer and what resumes the session",
> "Skipping Grill Me" → Permissions, "Event intake, idempotency and concurrency"), and the two interviews of
> 2026-11-11 (decisions IA1–IA15, plus what was agreed for later specs). Payload fields and permission answers
> were checked against the sandbox repo's stored deliveries and the GitHub API on 2026-11-11.

## Objective

One NestJS module, `IntakeModule`, that turns every stored webhook event into exactly one of two results: a
neutral `WorkflowInput` from a sender who is allowed to send it, or an ignore reason. It also does the only two
things the bot ever does for a refused sender: remove a workflow label that was added without access, and answer
a Participant's `/approve`.

- **Actors:** the developer (labels and comments in the sandbox, runs signed test requests); from spec 5 on, the
  router consumes the inputs.
- **Done when:** every event the App receives ends as `DONE` (accepted and logged) or `IGNORED` with a reason
  from this spec, no event from a sender below the needed level is ever accepted, the hello comment is gone, and
  the verification matrix passes.

## Scope

- **In:** `IntakeModule` (GitHub payload → neutral input, target-repo filter, own-event filter, access levels,
  label revert, `/approve` reply, ignore reasons), the `WorkflowInput` contract, `IssueProvider.getAccessLevel`
  (replaces `hasWriteAccess`) and `IssueProvider.isSelf` with their GitHub and in-memory implementations, the
  worker's processor seam, removal of the hello comment, two changes to how an event is stored (the
  `external_ref` column with its migration, and a redelivery that queues a `FAILED` event again), the smoke
  script's access checks, the new columns of `npm run db:events`, setup guide updates.
- **Out (later specs):** what happens to an accepted input: `Task`, session lease, `decide()`, stale events,
  two lane labels, status labels, `needs-human` (5); secret scanning and input guardrails (4); Grill rounds and
  comment bursts (6); which `/approve` is valid for which document (7); mapping a bot PR to its task (9, 10).
  Jira / Azure DevOps / Bitbucket adapters: Future.

## Decisions (interview 2026-11-11, all confirmed)

- **IA1 An accepted event ends `DONE`.** The app logs the input (e.g. `accepted LANE_ADDED full-sdd`) and posts
  nothing. The hello comment is removed. Spec 5 replaces this placeholder with the lease and the router.
- **IA2 Two access levels** (overview D19). **Participant** = GitHub Triage or higher. **Approver** = GitHub
  Write or higher. One mapping for personal and organization repos, no setting. A personal repo has no Triage
  role, so on the sandbox nobody is only a Participant; there is no config to fake one.
- **IA3 The level each input needs.** Participant: `ISSUE_OPENED`, `LANE_ADDED`, `LANE_REMOVED`, `SKIP_ADDED`,
  `COMMENT`. Approver: `APPROVE`, and `PR_UPDATED` from a human. Consequence: a Participant can cancel or restart
  a run by removing the label, even a run an Approver approved.
- **IA4 A Participant's `/approve` gets one reply per attempt,** whatever the issue's status (intake doesn't know
  the status). A sender with no access gets no reply (overview D21).
- **IA5 The bot recognises itself through `IssueProvider.isSelf(login)`.** Other bots (Dependabot, a GitHub
  Action) are ordinary senders: they go through the level check.
- **IA6 `/approve` counts only when it is the whole comment** (overview D20).
- **IA7 Label revert.** A `workflow: *` or `grill: skip` label added by a sender with no access is removed every
  time; the comment is posted once per issue and label (overview D21).
- **IA8 Nothing else is answered.** From a sender with no access, a comment, an opened issue and a removed label
  are ignored silently as `unauthorized`. The bot never re-adds a removed label.
- **IA9 Fail closed.** If the level lookup fails, the event is retried and then `FAILED`. It is never accepted or
  refused on a guess. The bot posts nothing: at that point it can't tell an allowed user from a stranger
  (overview D16, clarified 2026-11-11).
- **IA10 An incomplete or malformed payload is ignored** as `invalid-payload`; it is not retried.
- **IA11 Mentions.** The `/approve` reply mentions the user. The revert comment shows the login in backticks,
  without `@`, so a test or a bot never notifies anyone.
- **IA12 Reasons.** `ignore_reason` stays a text column with the reasons of this spec; `not-handled` is no
  longer written. `npm run db:events` also shows the sender.

**Decided in the follow-up interview (2026-11-11, all confirmed):**

- **IA13 "Redeliver" is the retry button.** A redelivery of an event whose row is `FAILED` puts that row back
  to `PENDING`. A redelivery of any other row changes nothing, as before. Reason: after a GitHub outage a
  `FAILED` event was final, and some actions are awkward to repeat by hand (an `/approve` needs a new comment).
- **IA14 Every event stores the issue or PR it is about** in a new indexed column, `external_ref` (e.g.
  `Hugoer/sdd-agent-sandbox#12`), filled when the event is stored and back-filled for existing rows. Reason: an
  issue's history, and later a task's waiting events (specs 5 and 6), are found with an indexed lookup instead of
  reading every payload.
- **IA15 Agreed for later specs:** the secret scanner sits at the ports (spec 4), a near-miss `/approve` gets a
  hint (spec 7), and two rules for other platforms (Future). Details: "Agreed for later specs".

**Added while writing (not asked in the interview; approved with the spec on 2026-11-11):**

- **AW1 Order of checks.** Everything that can be decided from the payload is decided first. The level lookup
  comes last and happens at most once per event. An event from another repo never causes an API call.
- **AW2 Markers.** `<!-- sdd-agent:label-revert:<key> -->` (`<key>` = `full-sdd`, `spec-code`, `code-only` or
  `grill-skip`) and `<!-- sdd-agent:approve-denied:<comment id> -->`. The bot always searches for the marker
  before posting. This is overview D13 without a table of its own: the event row in `PROCESSING` is the record
  that a comment may be pending.
- **AW3 A label event without a `label` object is ignored as `label-deleted`.** Seen on the sandbox on
  2026-11-11: GitHub sends `issues.unlabeled` without `label` when a label is deleted from the repo.
- **AW4 GitHub mapping.** `approver` when the permission answer's `permission` is `admin` or `write` (as spec 3
  built it); otherwise `participant` when `user.permissions.triage` is `true`; otherwise `none`. A missing field
  means `none`.
- **AW5 The worker gets its processor by registration.** `src/events` imports no feature module; the module that
  owns processing registers itself, and the app refuses to start if none did.
- **AW6 A human sender of `PR_UPDATED` is checked with a `TaskRef` built from the PR number.** On GitHub a PR is
  an issue in the same number space; the ref is only used to address the repo.
- **AW7 The two comments are fixed text** plus a validated login and one of the four known label names, so they
  hold nothing to scan. Spec 4 routes them through its scanner when it exists (overview §7 rule 10).
- **AW8 One GitHub-specific file.** `src/intake/github-payload.ts` reads the raw payload and matches label names
  with spec 3's helpers in `src/github/labels.ts` (pure functions). Everything else in `src/intake` uses only
  `src/contracts`. Another platform later adds its own payload file and reuses the rest.

## Behavior

### Per-event flow

```text
worker claims the event → classify (payload only) → authorize (one lookup) → result
  accepted → row DONE, input logged            (placeholder until spec 5)
  ignored  → row IGNORED + ignore_reason
  thrown   → spec 3's worker rule: transient → retry (3 attempts), permanent → FAILED at once
```

The controller, the guard and the worker's claim and retry rules are unchanged (specs 1 and 3).

### When an event is stored (`EventsService.enqueue`)

Two additions to spec 1's rules. There is still no outbound call in the request path (overview D4).

**`externalRef` (IA14):** `<repository.full_name>#<number>`, where the number is `issue.number` or, when the
payload has no issue, `pull_request.number`. If the repo name or the number is missing or has the wrong type, the
column stays empty. Reading it never throws, and the event is stored either way. It is the same string intake
later builds as `task.externalRef` (or the PR's `repo#number`). A comment on a PR gets the PR's reference.

**Redelivery (IA13):**

| Delivery ID | The row's status | Result | Response |
|---|---|---|---|
| new | — | one row, `PENDING` (spec 1) | `202` |
| already stored | `FAILED` | the same row goes back to `PENDING`: `attempts = 0`, `availableAt` = now, `processedAt` cleared. Payload, `receivedAt`, `externalRef` and `lastError` are kept | `202` |
| already stored | anything else | nothing changes (spec 1) | `202` |

- One atomic update that only matches a `FAILED` row, so two redeliveries at once queue it once.
- `receivedAt` keeps the original time. A re-queued event that is older than the issue's current run is therefore
  still stale for the router (overview R1).
- Processing it again is safe: every bot comment is guarded by its marker.

### Classify (no API call)

Checks run in this order; the first that matches decides.

| # | Check | Result |
|---|---|---|
| 1 | Event is `ping` | ignored `ping` |
| 2 | The payload has `repository.full_name` and it is not `TARGET_REPO` (case-insensitive) | ignored `other-repo` |
| 3 | Event is not `issues`, `issue_comment` or `pull_request` | ignored `unsupported-event` |
| 4 | `repository.full_name`, `sender.login` or `action` is missing or not valid | ignored `invalid-payload` |
| 5 | The sender is the bot (`isSelf`) and the event is not `pull_request` | ignored `own-event` |
| 6 | The event's row in the next table | an input, or an ignore reason |

| Event · action | Condition | Result | Level needed |
|---|---|---|---|
| `issues` · `opened` | — | `ISSUE_OPENED` | Participant |
| `issues` · `labeled` | the label is `workflow: <lane>` | `LANE_ADDED(lane)` | Participant |
| | the label is `grill: skip` | `SKIP_ADDED` | Participant |
| `issues` · `unlabeled` | the label is `workflow: <lane>` | `LANE_REMOVED(lane)` | Participant |
| | the label is `grill: skip` | ignored `skip-removed` | |
| `issues` · `labeled`, `unlabeled` | no `label` object (AW3) | ignored `label-deleted` | |
| | the label starts with `status: ` | ignored `status-label` | |
| | any other label, also an unknown `workflow: *` | ignored `other-label` | |
| `issue_comment` · `created` | the issue is a pull request (`issue.pull_request` present) | ignored `pr-comment` | |
| | the text is `/approve` (below) | `APPROVE` | Approver |
| | any other text | `COMMENT` | Participant |
| `issue_comment` · `edited`, `deleted` | — | ignored `comment-edited`, `comment-deleted` | |
| `pull_request` · `opened`, `synchronize` | the PR's author is not the bot | ignored `not-bot-pr` | |
| | the PR's author is the bot | `PR_UPDATED` | none if the sender is the bot, else Approver |
| any other action | — | ignored `unsupported-event` | |
| a field the row needs is missing or has the wrong type | — | ignored `invalid-payload` | |

- Label names are compared case-insensitively with the three lane labels, `grill: skip` and the `status: `
  prefix (spec 3 "Labels created").
- The label in `LANE_ADDED(lane)` says which label the event was about. It is not the issue's state: the router
  still reads the current labels from the API (overview §7 rule 4).
- A valid `sender.login` is 1–100 characters of letters, digits, `-` and `_`, with an optional `[bot]` suffix.
- Fields read, all checked with Zod: `issue.id`, `issue.number`, `label.name`, `comment.id`, `comment.body`,
  `comment.created_at`, `pull_request.id`, `pull_request.number`, `pull_request.html_url`,
  `pull_request.user.login`, `pull_request.head.sha`. Nothing else in the payload is used.

**The input built** (contract below):

- Issue events: `task = { platform: 'GITHUB', id: String(issue.id), externalRef: '<full_name>#<issue.number>' }`.
- Comments: `comment = { id: String(comment.id), body, createdAt }`. The body is the text as it was created;
  later edits are ignored.
- PR events: `pr = { platform: 'GITHUB', repo: <full_name>, number, url: html_url }`, `headSha`.
- All: `deliveryId`, `receivedAt` (the row's `receivedAt`), `sender` (login).

### What counts as `/approve` (IA6)

The comment's text with whitespace trimmed from both ends, compared in lower case, equals `/approve`.

| Comment text | Input |
|---|---|
| `/approve` | `APPROVE` |
| `  /APPROVE` followed by blank lines | `APPROVE` |
| `/approve thanks` | `COMMENT` |
| `LGTM, /approve` | `COMMENT` |
| `> /approve` (quoted) | `COMMENT` |
| `/approve` followed by quoted text (an email reply) | `COMMENT` |
| `/approved`, `/ approve`, `approve` | `COMMENT` |

### Authorize (at most one lookup)

1. `PR_UPDATED` whose sender is the bot → accepted, no lookup.
2. Otherwise `level = IssueProvider.getAccessLevel(task, sender)`. For a `PR_UPDATED` from a human, `task` is the
   ref of AW6.
3. The level decides:

| Input | `approver` | `participant` | `none` |
|---|---|---|---|
| `ISSUE_OPENED`, `LANE_REMOVED`, `COMMENT` | accepted | accepted | ignored `unauthorized` |
| `LANE_ADDED`, `SKIP_ADDED` | accepted | accepted | label revert → ignored `label-reverted` |
| `APPROVE` | accepted | reply → ignored `approve-denied` | ignored `unauthorized` |
| `PR_UPDATED` (human sender) | accepted | ignored `unauthorized` | ignored `unauthorized` |

The level is the one GitHub reports when the event is processed, not when it was sent. It is never cached
(spec 3 G6).

### Label revert (IA7)

1. `removeLabel(task, <label>)` with the label's canonical name (`workflow: <lane>` or `grill: skip`). Already
   gone → success (spec 3).
2. `findCommentByMarker(task, '<!-- sdd-agent:label-revert:<key> -->')`. Found → post nothing.
3. Not found → `postComment`:

   ```text
   <!-- sdd-agent:label-revert:code-only -->
   The `workflow: code-only` label was removed. It was added by `octocat`, who is not allowed to start or change a workflow on this repository (on GitHub that needs the Triage role or higher).
   ```

4. Result: ignored `label-reverted`.

At most four revert comments can ever exist on one issue (three lanes and `grill: skip`).

### `/approve` reply (IA4)

1. `findCommentByMarker(task, '<!-- sdd-agent:approve-denied:<comment id> -->')`. Found → post nothing.
2. Not found → `postComment`:

   ```text
   <!-- sdd-agent:approve-denied:6775442980 -->
   @some-user `/approve` needs write access to this repository, so nothing was approved. Ask someone with write access to comment `/approve`.
   ```

3. Result: ignored `approve-denied`.

### After intake (placeholder until spec 5)

- Accepted → the row is `DONE`; the input goes nowhere else.
- Spec 5 replaces the placeholder processor with its own: it calls `IntakeService.intake(event)`, then claims the
  lease and routes the input. `IntakeService` does not change.

### Failures and retries

- Every provider failure is a `ProviderError` and goes to spec 3's worker rule. Intake catches nothing.
- An event that ends `FAILED` here leaves a row with `last_error` and an error line in the log. No comment and no
  `needs-human` (IA9). To retry it, redeliver it (IA13).
- A retried event runs intake again from the start. That is safe: classify is pure, the level is asked again,
  `removeLabel` succeeds when the label is already gone, and the marker search stops a second comment.
- A crash between `removeLabel` and the comment: the retry posts the comment. A crash after the comment: the retry
  finds the marker.

### Logging

Intake writes one line per event: delivery ID, event, action, sender login, and either `accepted <TYPE>` (plus
the lane, and the issue or PR reference) or `ignored <reason>`. The worker keeps its own status line from spec 1
(`DONE`, `IGNORED (reason)`, a retry, `FAILED`), so an event shows two lines (plan P5, 2026-11-11). When an event
is stored: `stored`, `duplicate` or `requeued`. Never logged: comment text, the payload, tokens.

### Ignore reasons

| Reason | Meaning | From |
|---|---|---|
| `ping` | GitHub's webhook test | spec 1 |
| `other-repo` | not `TARGET_REPO` | spec 3 |
| `unsupported-event` | an event or action the bot doesn't use (replaces `not-handled`) | new |
| `invalid-payload` | a needed field is missing or malformed | new |
| `own-event` | sent by the bot itself, and not a `pull_request` event | new |
| `label-deleted` | a label event without a label | new |
| `status-label` | a `status: *` label was added or removed | new |
| `other-label` | a label the bot doesn't use | new |
| `skip-removed` | `grill: skip` was removed | new |
| `pr-comment` | a comment on a pull request | new |
| `comment-edited`, `comment-deleted` | a comment was edited or deleted | new |
| `not-bot-pr` | a pull request the bot didn't open | new |
| `unauthorized` | the sender's level is too low; nothing was done | new |
| `label-reverted` | a lane or skip label added with no access was removed | new |
| `approve-denied` | a Participant's `/approve` was answered | new |

`no-installation` (spec 1) and `not-handled` are no longer written; old rows keep them.

## Contracts

Changes to overview §4, made there first (2026-11-11):

```ts
/** What a user may do with the bot, lowest first. Never a platform's role name. */
export type AccessLevel = 'none' | 'participant' | 'approver';

export interface IssueProvider {
  // …unchanged methods…
  /** replaces hasWriteAccess; asked on every call */
  getAccessLevel(task: TaskRef, login: string): Promise<AccessLevel>;
  /** true when login is the bot's own account */
  isSelf(login: string): boolean;
}

/** What intake hands to the router: one authorized event, platform-neutral. */
export interface TaskComment { id: string; body: string; createdAt: Date } // body is untrusted data
export type WorkflowInput = {
  deliveryId: string;
  receivedAt: Date;
  sender: string; // login; the bot's own login only on PR_UPDATED
} & (
  | { type: 'ISSUE_OPENED' | 'SKIP_ADDED'; task: TaskRef }
  | { type: 'LANE_ADDED' | 'LANE_REMOVED'; task: TaskRef; lane: Lane }
  | { type: 'COMMENT' | 'APPROVE'; task: TaskRef; comment: TaskComment }
  | { type: 'PR_UPDATED'; pr: PullRequestRef; headSha: string }
);
```

`hasWriteAccess` is removed from the port, the GitHub adapter, the fake and the smoke script.

**GitHub adapter** (`src/github`):

| Method | GitHub call | Result and rules |
|---|---|---|
| `getAccessLevel` | `GET …/collaborators/{login}/permission` | AW4. `404` (no such user) → `none`. No cache. Checked on the sandbox on 2026-11-11: the owner → `admin` and `triage: true`; `octocat` → `read` and `triage: false`; `github-actions[bot]` → `none`. |
| `isSelf` | none (pure) | The login equals `<slug>[bot]` (resolved at startup), case-insensitive. A human login can't contain `[`. |

**Intake's own interface** (`src/intake`, used by spec 5):

```ts
export type IntakeResult =
  | { outcome: 'accepted'; input: WorkflowInput }
  | { outcome: 'ignored'; reason: IgnoreReason }; // IgnoreReason = the union of "Ignore reasons"

IntakeService.intake(event: WebhookEvent): Promise<IntakeResult>; // throws ProviderError → the worker's rule
```

**Worker seam** (`src/events`): `EventProcessor` becomes an interface with spec 1's signature,
`process(event): Promise<{ status: 'DONE' } | { status: 'IGNORED'; reason: string }>`. The worker takes the
registered one (AW5). Spec 2 registers intake's placeholder processor; spec 5 registers its own instead.

**Storing** (`src/events`): `EventsService.enqueue(input): Promise<{ duplicate: boolean; requeued: boolean }>`
(spec 1 returned only `duplicate`). `requeued` is `true` only for a redelivery of a `FAILED` row.

**Fakes** (`test/fakes`): `InMemoryIssueProvider` gets `setAccessLevel(login, level)` (default `none`) in place of
`setPermission`, a bot login, and `isSelf`.

## Owned tables

None owned. Spec 2 extends `WebhookEvent` (owner: spec 1; overview §6):

| Column | Type | Notes |
|---|---|---|
| `externalRef` | text, nullable (`external_ref`) | IA14: the issue or PR the event is about, `owner/repo#number` |

- Index on `(externalRef, receivedAt)`.
- Migration `prisma/migrations/<ts>_webhook_event_external_ref`: adds the column and the index, then fills the
  column for existing rows with one `UPDATE` from the stored payload (same rule as above).
- `ignoreReason` (text) takes the values of "Ignore reasons" (IA12). No other column changes.

## Configuration

No new variable. Intake reads `TARGET_REPO` (spec 3).

## Tech stack and dependencies

No new package. Payload fields are checked with `zod` (already installed).

## Commands

```text
npm run db:migrate        applies the new migration (external_ref)
npm run db:events         now also shows external_ref and the sender (payload → sender.login)
npm run github:smoke      the access checks call getAccessLevel and isSelf (below)
```

**Smoke script changes:** `getAccessLevel` for the issue author → `approver`, for `octocat` → `none`, for a login
that doesn't exist → `none`; `isSelf` is `true` for the bot login (`getPushCredentials().authorName`) and `false`
for the issue author.

## Project structure (spec 2's part of overview §1)

File names are a guide; the plan may adjust them.

```text
src/
  contracts/
    issue-provider.ts          + AccessLevel, getAccessLevel, isSelf; hasWriteAccess removed
    workflow-input.ts          WorkflowInput, TaskComment (new)
  intake/
    intake.module.ts           imports EventsModule and GitHubModule; registers the placeholder processor
    github-payload.ts          pure: stored event → ignore reason or candidate input (AW8); the Zod schemas
    approve-command.ts         pure: is this text /approve?
    intake.service.ts          classify → authorize → label revert / reply
    intake-event.processor.ts  placeholder until spec 5: accepted → DONE + log line
    ignore-reason.ts           the reasons
    *.spec.ts
  events/
    event-processor.ts         only the interface and ProcessResult (the hello is deleted)
    events.worker.ts           takes the registered processor
    events.service.ts          enqueue: fills externalRef; a redelivery re-queues a FAILED row
    external-ref.ts            pure: event name + payload → "owner/repo#number" or null
    events.module.ts           no GitHubModule import
  github/
    github-issue.provider.ts   getAccessLevel, isSelf
    labels.ts                  + which lane a label name stands for
    smoke/run-smoke.ts         access-level and isSelf checks
test/
  fakes/in-memory-issue-provider.ts   access levels, bot login
  fixtures/github/                    trimmed real payloads from the sandbox's stored deliveries
  intake.integration.spec.ts
prisma/
  schema.prisma                       + WebhookEvent.externalRef and its index
  migrations/<ts>_webhook_event_external_ref/
package.json                          db:events + external_ref and sender
```

## Code style

```ts
// Payload-only decisions are pure and come first; the one lookup comes last.
@Injectable()
export class IntakeService {
  constructor(@Inject(ISSUE_PROVIDER) private readonly issues: IssueProvider /* , config */) {}

  async intake(event: WebhookEvent): Promise<IntakeResult> {
    const classified = classifyGitHubEvent(event, this.targetRepo, (login) => this.issues.isSelf(login));
    if (classified.outcome === 'ignored') return classified;

    const { input, needs, subject, revertLabel } = classified;
    if (needs === 'self') return accepted(input); // the bot's own PR event

    const level = await this.issues.getAccessLevel(subject, input.sender);
    if (allows(level, needs)) return accepted(input);
    if (revertLabel && level === 'none') return this.revertLabel(subject, revertLabel, input.sender);
    if (input.type === 'APPROVE' && level === 'participant') return this.denyApprove(input);
    return ignored('unauthorized');
  }
}
```

- `src/intake` never reads `event.payload` outside `github-payload.ts`, and never imports a class from
  `src/github`.
- Spec 1's and spec 3's rules stay: ESM imports ending in `.js`, config only through `ConfigService<Env, true>`,
  providers injected by token.

## Testing strategy

- **Unit** (`npm test`):
  - `github-payload`: one test per row of both "Classify" tables and one per check-order case (e.g. the bot's own
    `status: *` label event is `own-event`, not `status-label`), on fixtures trimmed from real sandbox deliveries.
  - `approve-command`: every row of "What counts as `/approve`".
  - `IntakeService` with the in-memory provider: every cell of the "Authorize" table; the bot's own PR event
    makes no lookup; an `other-repo` event makes no call at all; the revert's call order; the revert comment is
    posted once for two events on the same issue and label, and again for another label; the reply is posted once
    per comment ID; a `ProviderError` from each call propagates and a second run posts nothing twice.
  - GitHub adapter (scripted `fetch`, as spec 3): `getAccessLevel` for `admin`, `maintain`, `write`, a Triage
    answer, `read`, `none`, `404` and an answer without `user.permissions`; `isSelf` (exact, other case, a human
    login, another bot).
  - `external-ref`: issue, comment, comment on a PR, pull request; no issue and no PR; missing or wrongly typed
    fields; it never throws. For every fixture it equals the reference intake builds.
  - The fake provider's new methods; the worker without a registered processor.
- **Integration** (`npm run test:integration`, real PostgreSQL, fake providers, no network): signed requests
  through the controller for an accepted event (`DONE`), each kind of ignore (`IGNORED` + reason), the revert
  (label gone, one comment, row `label-reverted`), a Participant's `/approve` (one reply, row `approve-denied`),
  a transient lookup error (retried, then `FAILED`, nothing accepted) and a retry after a failed `postComment`
  (one comment in the end). Storing: the row has its `external_ref`; a payload without an issue is stored with
  none. Redelivery: a `FAILED` row is queued again and processed once, also when two redeliveries arrive
  together; a `DONE`, `IGNORED`, `PENDING` or `PROCESSING` row is left untouched. The app boots with the fakes.
- **Manual:** the verification matrix. No test calls the real GitHub API.

## Setup & configuration → `docs/guides/setup-github-agent-local.md`

Updated by the build session. No new env var, permission or webhook event: the App has subscribed to `issues`,
`issue_comment` and `pull_request` since spec 1 (W6).

- "8. Smoke test": no hello any more. Open an issue → the row is `DONE` and the log shows
  `accepted ISSUE_OPENED`.
- "6. PostgreSQL": run `npm run db:migrate` after pulling this spec's build (new column).
- "9. Troubleshooting": drop the hello rows; add "I labeled or commented and nothing happened → `npm run
  db:events`, read `ignore_reason`" with the table of "Ignore reasons". A `FAILED` row: fix the cause, then
  **Redeliver** it (replaces "redelivering the same delivery is ignored", which now holds for every other
  status).
- New "History of an issue": the query by `external_ref` from the verification matrix.
- "11. Check the GitHub App with the smoke script": the new access lines.
- New "Reference: who can do what": Participant and Approver, the GitHub roles behind them, and the note that a
  personal repo has no Triage role (every collaborator is an Approver).
- New "Send a signed test request": the helper of the verification matrix.

## Changes to earlier specs' behavior

- **Hello comment (specs 1 and 3):** removed. `issues.opened` ends `DONE` with no comment, so spec 1's and
  spec 3's matrix rows that expect a hello no longer reproduce.
- **Ignore reasons:** `not-handled` is replaced by precise reasons. The bot's own events are `own-event`.
- **Spec 3's signed `issues.opened` request** has no `sender`, so it now ends `invalid-payload`. Use this spec's
  helper.
- **`hasWriteAccess` (spec 3)** → `getAccessLevel`; `isSelf` is new. `removeLabel` gets its first caller.
- **`EventsModule`** no longer imports `GitHubModule`; `EventProcessor` is an interface.
- **Dedupe (spec 1, "`POST /webhooks/github`" row 4):** a redelivery of a `FAILED` event queues it again (IA13).
  Every other redelivery still changes nothing. `enqueue` also returns `requeued`.
- **`WebhookEvent` (spec 1):** one new column, `externalRef` (IA14). The columns spec 1 defined are unchanged.
- **Overview:** D19–D21, the `WorkflowInput` contract, authorization rules 2, 4 and 16, the two `triage` matrix
  rows, D4 and D16 (one sentence each) and the `WebhookEvent` row of §6 were changed on 2026-11-11.

## Edge cases

- **Labels set while creating the issue:** `opened` and `labeled` are both accepted, in the order received. The
  router handles either order (overview "Edge cases routed to later specs", 5).
- **A label is removed by a sender with no access:** `unauthorized`; the run continues without its label (overview).
- **A lane label is deleted from the repo:** `label-deleted`; the run continues without its label, and the next
  start recreates the label in the repo (spec 3).
- **Two labels added at once with no access:** both removed, one comment per label.
- **Something adds the label again and again** (e.g. a GitHub Action): removed each time, one comment in total.
- **A human deletes the revert comment:** the next revert of that label posts it again.
- **The reverted label was meanwhile re-added by an allowed user** (inside the second before the first event was
  processed): the bot removes it anyway and its comment explains why; the user adds it again. Accepted.
- **The bot's own follow-up events** (its `unlabeled`, its comments, its status labels): `own-event`, so the
  revert and the reply can't trigger the bot.
- **`/approve` on a pull request:** `pr-comment`, whoever sent it; no reply.
- **`/approve` from a sender with no access:** `unauthorized`, no reply (IA4).
- **Access changed after the event was sent,** or the sender's account was renamed or deleted: the level at
  processing time counts (`404` → `none`).
- **Another App or bot with repo access:** GitHub's permission answer decides, like for any user; today it is
  `none` for `github-actions[bot]`.
- **`check_suite`, `installation` and other events GitHub sends unasked:** `unsupported-event`.
- **A pull request from a fork, or opened by a human:** `not-bot-pr`.
- **A Participant pushes to a bot PR:** not possible on GitHub (a push needs Write); it would be `unauthorized`.
- **A comment on a closed issue:** accepted as `COMMENT`; closed issues are spec 5's question.
- **The target repo is renamed:** its events are `other-repo` until `TARGET_REPO` is updated and the app
  restarted.
- **A redelivery:** deduplicated by delivery ID before intake (spec 1), unless the row is `FAILED` (IA13).
- **A `FAILED` event with a permanent cause** (e.g. the issue was deleted) is redelivered: it fails again at once.
- **A re-queued event that then succeeds** keeps the old `last_error` as history (spec 3's open point for spec 5).
- **The repo is renamed or the issue is transferred:** new events get the new reference, so that issue's history
  is split across two `external_ref` values. The stable issue ID is still in the payload.
- **A bot PR and its issue** have different references (`#15` and `#12`). Spec 9's `AgentPullRequest` links them.
- **Events from another repo** also store their reference (e.g. `someone/other-repo#3`), so a history query by
  `external_ref` never mixes repos.

## Boundaries

- **Always:** decide from the payload before any API call; ask the level when the event is processed; search the
  marker before posting; change overview §4 first when a contract changes; run `npm run typecheck`,
  `npm run lint`, `npm test` and `npm run test:integration` before declaring the build done.
- **Ask first:** a new package, env var, column, port method or ignore reason; changing which level an input
  needs; changing a comment text or a marker.
- **Never:** commit or push (the developer does); accept or refuse an event when the lookup failed; cache a
  level; add a setting that fakes a level; answer a sender with no access, except the revert comment; add or
  re-add a `workflow: *` or `grill: skip` label; touch a `status: *` label; read the payload outside
  `github-payload.ts`; log comment text, payloads or tokens; call GitHub from the webhook controller or from a
  test; let the reading of `external_ref` fail or delay a request; re-queue a row that is not `FAILED`.

## Verification matrix

**Setup to observe:** `npm run db:events` (delivery, event, action, `external_ref`, sender, status, ignore
reason, attempts, last error); the app log; the issue timeline. "You" are the repo owner, so an Approver. Signed
test requests and the history query (bot repo, after `npm run db:migrate`; set `N` to an open sandbox issue):

```sh
set -a; source .env; set +a
N=1; ME=<your GitHub login>
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
events_of() {  # events_of <issue or PR number> → its stored events, oldest first
  docker compose exec -T postgres psql -U sdd_agent -d sdd_agent -c "SELECT received_at, event_name, action, \
    status, ignore_reason FROM webhook_events WHERE external_ref = '$TARGET_REPO#$1' ORDER BY received_at"
}
```

**Accepted events (you, real GitHub actions)**
- [x] Open an issue → row `DONE`; the log shows `accepted ISSUE_OPENED`; NO comment appears on the issue.
- [x] Add `workflow: full-sdd` → row `DONE`, log `accepted LANE_ADDED full-sdd`; the label stays; nothing posted.
- [x] Remove `workflow: full-sdd` → row `DONE`, log `accepted LANE_REMOVED full-sdd`.
- [x] Add `grill: skip` → row `DONE`, log `accepted SKIP_ADDED`.
- [x] Comment `looks fine` → row `DONE`, log `accepted COMMENT`; the log does NOT contain `looks fine`.
- [x] Comment `/approve` → row `DONE`, log `accepted APPROVE`. Comment `  /APPROVE` with a blank line after it →
  `accepted APPROVE`.
- [x] Comment `/approve thanks`, then `LGTM, /approve`, then a quoted `> /approve` → three rows `DONE`, each
  `accepted COMMENT`.

**Ignored from the payload alone (you, real GitHub actions)**
- [x] Remove `grill: skip` → row `IGNORED` `skip-removed`.
- [x] Add `bug` → row `IGNORED` `other-label`.
- [x] Add `status: grilling` by hand → row `IGNORED` `status-label`; the label stays (no revert). Remove it →
  `status-label` again.
- [x] Edit one of your comments → `comment-edited`. Delete it → `comment-deleted`.
- [x] Close the issue and reopen it → two rows `IGNORED` `unsupported-event`.
- [x] Open a pull request by hand (a branch with one edit, made in the GitHub UI) → row `IGNORED` `not-bot-pr`.
  Comment `/approve` on it → row `IGNORED` `pr-comment`; nothing posted.
- [x] In the App's "Recent deliveries", redeliver the `ping` → still one row for it, `IGNORED` `ping`.

**Bot pull request** (precondition: issue `N` meets the smoke script's preconditions, setup guide step 11; in the
GitHub UI create branch `smoke/spec-2` from `main` with one small commit, `SHA`; stop `npm run dev`; run
`npm run github:smoke -- --issue N --branch smoke/spec-2 --sha SHA`; start the app again)
- [x] The smoke output shows `getAccessLevel` `approver` for you, `none` for `octocat` and for the invented
  login, and `isSelf` `true` for `<app>[bot]`, `false` for you; every line `PASS`.
- [x] Redeliver the `pull_request.opened` delivery (it failed while the app was stopped) → row `DONE`, sender
  `<app>[bot]`, log `accepted PR_UPDATED` with the PR number and `SHA`.
- [x] Redeliver one of the smoke run's `issue_comment` deliveries → row `IGNORED` `own-event`.
- [x] With the app running, commit another small edit on `smoke/spec-2` in the GitHub UI → a
  `pull_request.synchronize` row `DONE`, sender you, log `accepted PR_UPDATED` with the new head SHA. A
  `check_suite` row, if one arrives, is `IGNORED` `unsupported-event`.

**Sender with no access (signed test requests)**
- [x] `send issues "{\"action\":\"opened\",$(common octocat)}"` → `202`; row `IGNORED` `unauthorized`; nothing
  posted.
- [x] `send issue_comment "{\"action\":\"created\",$(common octocat),$APPROVE}"` → row `IGNORED` `unauthorized`;
  NO reply on the issue.
- [x] `send issues "{\"action\":\"unlabeled\",$(common octocat),$LABELED}"` → row `IGNORED` `unauthorized`;
  nothing changes on the issue.
- [x] Add `workflow: code-only` to issue `N` by hand (row `DONE`), then
  `send issues "{\"action\":\"labeled\",$(common octocat),$LABELED}"` → the label disappears from the issue;
  exactly one bot comment naming `workflow: code-only` and `octocat` (no `@`); row `IGNORED` `label-reverted`.
- [x] After that row: the bot's own `issues.unlabeled` and `issue_comment.created` rows are `IGNORED`
  `own-event`; no further comment or label change follows.
- [x] Add `workflow: code-only` by hand again and send the same request again → the label disappears again; NO
  second comment; row `label-reverted`.
- [x] The same with `"label":{"name":"grill: skip"}` (label added by hand first) → removed; one comment naming
  `grill: skip`.
- [x] Delete the bot's `workflow: code-only` revert comment by hand, add the label and send the request again →
  the label is removed and the comment is posted again, once.

**Other repo and broken payloads (signed test requests)**
- [x] `send issues "{\"action\":\"labeled\",$(common $ME someone/other-repo),$LABELED}"` → row `IGNORED`
  `other-repo`; the log shows no GitHub call for it.
- [x] `send issues '{"action":"labeled"}'` → `202`; row `IGNORED` `invalid-payload`, `attempts = 1`.
- [x] `send issues "{\"action\":\"labeled\",$(common $ME)}"` (no `label`) → row `IGNORED` `label-deleted`.
- [x] `send issue_comment "{\"action\":\"created\",$(common $ME)}"` (no `comment`) → row `IGNORED`
  `invalid-payload`.
- [x] `send installation '{"action":"created"}'` → row `IGNORED` `unsupported-event`.

**Stored reference (`external_ref`)**
- [x] Right after `npm run db:migrate`: rows stored before this spec show their `external_ref` (an old `issues` ·
  `opened` row shows `<TARGET_REPO>#<n>`); `ping` rows show none.
- [x] Every row of issue `N` from the groups above shows `<TARGET_REPO>#N`, and `events_of N` lists exactly those
  rows, oldest first.
- [x] The bot PR's `pull_request` rows and the row of the comment on the hand-made PR show
  `<TARGET_REPO>#<that PR's number>`.
- [x] The `other-repo` row shows `someone/other-repo#N`. The `installation` row and the `{"action":"labeled"}` row
  were stored (`202`) with an empty `external_ref`.

**Fail closed, then retry by redelivery** (`BODY="{\"action\":\"labeled\",$(common $ME),$LABELED}"`)
- [x] Wi-Fi off, then `send issues "$BODY" retry-1` → `202`; after about 35 s the row is `FAILED` with
  `attempts = 3`. It is never `DONE` and never `IGNORED`, and nothing is posted on the issue.
- [x] Wi-Fi on, then the same command again → `202`; there is still ONE row for `retry-1`; the log shows
  `requeued`, then `accepted LANE_ADDED code-only`; the row is `DONE` with `attempts = 1`.
- [x] The same command a third time → `202`; the row stays `DONE`; the log shows `duplicate` and NO new
  `accepted` line.

**Invariants**
- [x] After all rows above: no row has `ignore_reason` `not-handled`, and every `IGNORED` row's reason is one of
  "Ignore reasons".
- [x] No row with sender `octocat` is `DONE`.
- [x] There is one row per delivery ID, whatever was redelivered.
- [x] No issue timeline shows the bot adding a `workflow: *` or `grill: skip` label, or changing a `status: *`
  label, and no issue got a hello comment.
- [x] `grep` the app log for `looks fine`, `ghs_`, `-----BEGIN` and the webhook secret → no match.
- [x] `grep -rn "hasWriteAccess" src test` → no match. `grep -rnE "from '(octokit|@octokit)" src --include='*.ts'
  --exclude-dir=generated` → matches only under `src/github/`. `grep -rn "\.payload" src/intake --include='*.ts'`
  → matches only in `github-payload.ts` and its test.
- [x] `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:integration` all pass.

**Not checked by hand on the sandbox** (a personal repo has no Triage role, IA2); covered by unit and integration
tests with the fake provider:
- A Participant opens an issue, adds or removes a lane label, adds `grill: skip`, comments → accepted.
- A Participant comments `/approve` → exactly one reply that mentions them; row `approve-denied`; a second
  `/approve` → a second reply; a retried event → no extra reply.
- A Participant as the human sender of `PR_UPDATED` → `unauthorized`.

**Organization repo only** (not run in the 2026-11-12 verification: the sandbox is a personal repo) (optional; needs a target repo owned by an organization and a second account with the
Triage role there)
- [ ] The Triage user adds `workflow: full-sdd` → row `DONE`; the label stays.
- [ ] The Triage user comments `/approve` → exactly one reply mentioning them; row `IGNORED` `approve-denied`.

## Success criteria

- [x] Every row of the verification matrix passes on the developer's machine (the organization rows are
  optional).
- [x] Every event stored after the build ends `DONE`, `IGNORED` with a reason of this spec, or `FAILED` with
  `last_error`.
- [x] `src/contracts` matches overview §4; `hasWriteAccess` is gone; only `src/github` imports Octokit; only
  `github-payload.ts` reads the payload.
- [x] `external_ref` is filled for new and old rows, and overview §6 lists the column.
- [x] Spec 5 can replace the placeholder processor and consume `IntakeService.intake()` without changing
  `src/intake`, the controller or the `WebhookEvent` columns.
- [x] The setup guide, `AGENTS.md` (State, Commands) and the overview reflect this spec.

## Agreed for later specs (follow-up interview 2026-11-11)

- **Spec 4, the secret scanner sits at the ports.** Spec 4 wraps the two ports, so every outgoing text (comments,
  PR bodies, check-run summaries) is scanned whoever the caller is. Intake's two comments are then covered
  without a change in `src/intake` (AW7), and the port comment "body is already secret-scanned" goes away.
- **Spec 5, failures before the router.** Overview D16 ("`needs-human` + comment") applies from the router on. A
  failure at intake is a `FAILED` row (IA9).
- **Specs 5 and 6, a task's waiting events** are found through `external_ref` (IA14). The spec that first needs
  them adds the query method to `EventsService`.
- **Spec 5, the router's own ignore reasons** (stale, not expected in this status) go into the same column.
- **Spec 7, a hint for a near miss.** While an issue waits for an approval (`spec-review`, `ready-for-dev`), a
  comment that starts with `/approve` but isn't exactly that gets the reply "To approve, comment exactly
  `/approve`, with nothing else." At most one hint per document. Spec 7 adds the case to the overview's transition
  table (row 20); `approve-command.ts` is the place for the "starts with" check.
- **Future, wording.** The two comments keep their GitHub wording. A second platform's adapter supplies its own
  two phrases.
- **Future, issues and code in different products** (e.g. Jira with Bitbucket): each product answers for its own
  events, and accounts are never matched across products. The tracker answers for labels, comments and
  `/approve` (both levels); the code host only for a human's push to a bot PR. A first mapping, to confirm when
  those adapters get a spec:

  | Platform | Participant | Approver | Human push to a bot PR |
  |---|---|---|---|
  | Jira (tracker) | the project's "Edit issues" permission | a project role named in config (Jira has no fixed roles) | — |
  | Azure DevOps (tracker and code host) | can edit work items | "Contribute" on the repo | "Contribute" on the repo |
  | Bitbucket (code host) | — | — | write on the repo |

## Open questions

None.
