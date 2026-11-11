# sdd-agent

A GitHub App bot that receives issue webhooks and moves issues through a
Grill Me → Spec → Plan → Coder → Quality Gate workflow, driven by labels. It works on a separate sandbox
(target) repo, never on this one.

**Status:** specs #1 (walking skeleton) and #3 (GitHub providers) built. The bot receives signed webhooks,
stores each delivery once, checks its GitHub App at startup (and creates its labels), and posts a hello comment
when an issue is opened in the sandbox repo.

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
