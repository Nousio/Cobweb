# Cobweb

Local governance kernel for agent skills — CLI (`cobweb`), daemon (`cobwebd`), SQLite state store, and `SKILL.md` parsing, auditing, dedup, and import.

> Phase one (0.1.0) ships scanning, auditing, dedup, and daemon-backed import. Multi-provider `sync`, `lint`, `policy`, and `vendor` are planned for later phases and currently exit as not-implemented stubs.

## Phase-One Scope

This repository currently implements the phase-one infrastructure:

- `packages/core`: pure governance logic for parsing, scanning, auditing, dedup, providers, runtime paths, schema, and Writer Queue.
- `packages/daemon`: local JSON-RPC daemon over Unix domain socket.
- `packages/cli`: user-facing `cobweb` / `cw` commands.
- `packages/mcp`: phase-one stdio shim that forwards to the daemon.
- `examples/skills`: smoke-test skills for normal, duplicate, escaping, high-risk, and policy-difference cases.

Phase two will add FTS and full MCP routing. Phase three will add embedding.

## Development

```bash
npm install
npm run check          # tsc -b project references
npm test               # vitest unit + integration tests
npm test -- --coverage # coverage report (target: > 70%)
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests, and CLI/daemon smoke checks on every PR.

## CLI commands (0.1.0)

```bash
# read-only governance (no daemon required)
npm run dev:cli -- scan examples/skills
npm run dev:cli -- audit examples/skills/high-risk-script --strict
npm run dev:cli -- dedup examples/skills

# import preview (dry-run) and daemon-backed write
npm run dev:cli -- import examples/skills/normal-review
npm run dev:cli -- import examples/skills/normal-review --write

# daemon lifecycle
npm run dev:cli -- daemon start
npm run dev:cli -- daemon status
npm run dev:cli -- daemon doctor
npm run dev:cli -- daemon stop

# status, with read-only fallback when the daemon is down
npm run dev:cli -- status
npm run dev:cli -- status --readonly
```
