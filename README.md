# sdd-agent

A GitHub App bot that receives issue webhooks and moves issues through a
Grill Me → Spec → Plan → Coder → Quality Gate workflow, driven by labels. It works on a separate sandbox
(target) repo, never on this one.

**Status:** specs #1 (walking skeleton), #3 (GitHub providers) and #2 (intake and authorization) built. The bot
receives signed webhooks, stores each delivery once, checks its GitHub App at startup (and creates its labels),
and decides for each event what it is and whether its sender may do it: an issue opened, a workflow label added or
removed, a comment or `/approve`. A workflow label added by someone without access is removed again. The workflow
itself (Grill Me onwards) is not built yet, so the bot doesn't act on accepted events.

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
