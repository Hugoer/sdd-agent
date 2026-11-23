# sdd-agent

A GitHub App bot that receives issue webhooks and moves issues through a
Grill Me → Spec → Plan → Coder → Quality Gate workflow, driven by labels. It works on a separate sandbox
(target) repo, never on this one.

**Status:** specs #1 (walking skeleton), #3 (GitHub providers), #2 (intake and authorization), #4 (LLM foundation),
#5 (router and session lease), #6 (Grill Me), #11 (skill discovery) and #7 (Spec, Plan and approvals) built. The bot
receives signed webhooks, stores each delivery once, checks its GitHub App at startup (and creates its labels), and
decides for each event what it is and whether its sender may do it: an issue opened, a workflow label added or
removed, a comment, `/approve`, `/retry`, `/refresh` or `/restore`. A workflow label added by someone without access
is removed again, and so is a `model: max-*` label added by anyone below Approver. The model call every step will
use is built and checked with `npm run llm:smoke`: the step's skill and model come from the target repo's
`workflow.json`, untrusted text is guarded, every call is recorded, and everything posted passes a secret scanner.
The router acts on accepted events, one at a time per issue: it shows the issue's status as a label, starts, cancels
and restarts runs from the `workflow:` labels, reminds about conflicting labels, and stops a failed run with one
comment offering `/retry` or a restart. Grill Me, the first step of `workflow: full-sdd` and `workflow: spec-code`,
judges whether an issue says enough to write a Spec; if it doesn't, it asks the issue's people a few numbered
questions per comment, each with its guess, reads their answers, and stops at a round limit. Every model step sees
the target repo's own instructions: its root `AGENTS.md` is always in the prompt, and the model loads the repo's
skills and other `AGENTS.md` files when the issue needs them, within a limit per answer; the comment says what it
read, and every file it got is recorded with its size and tokens. After Grill Me the bot writes the Spec and, in
`full-sdd`, the Plan as issue comments people edit and approve with `/approve`; `/refresh` brings one up to date
with `main`, `/restore` brings back a deleted one, and every reply links the comment it answers. The code steps are
not built yet, so the last `/approve` stops the run at the `workspace` step.

## Get started

- **Setup from zero:** [docs/guides/setup-github-agent-local.md](docs/guides/setup-github-agent-local.md)
- **Commands and project rules:** [AGENTS.md](AGENTS.md)

## Docs

- `docs/specs/`: specs, the source of truth. Start with
  [the architecture overview](docs/specs/spec-github-agent-architecture-overview.md).
- `docs/plans/`: implementation plans (same file name as their spec).
- `docs/guides/`: setup and runbooks.
- `docs/idea/`: the original idea doc (parts not yet moved into specs).

## License

[MIT](LICENSE)
