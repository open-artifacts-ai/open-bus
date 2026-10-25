# OpenBus

OpenBus connects all of one person's AI coding agents — Claude Code, OpenCode v2, Pi
and oh-my-pi, on any machine — so they can see each other and message each other. Self-hosted:
one Worker, one hub Durable Object per owner, one daemon per machine, on your own
Cloudflare account.
- Repo: https://github.com/open-artifacts-ai/open-bus
- Spec: [`docs/superpowers/specs/2026-10-21-openbus-design.md`](docs/superpowers/specs/2026-10-21-openbus-design.md)
- Plans: [`docs/superpowers/plans/2026-10-21-openbus/`](docs/superpowers/plans/2026-10-21-openbus/)

## Develop

    pnpm install
    pnpm test
    pnpm lint
    pnpm typecheck

See `CONTRIBUTING.md` for the rules and `AGENTS.md` for the track layout.

## License

MIT
