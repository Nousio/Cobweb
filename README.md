# Cobweb

Local governance kernel for agent skills — CLI (`cobweb`), daemon (`cobwebd`), SQLite state store, and `SKILL.md` parsing, auditing, dedup, and import.

> Phase one (0.1.0) ships scanning, linting, auditing, dedup, canonical import, provider sync, policy checks, vendoring plans, and daemon-backed writes.

## Phase-One Scope

This repository currently implements the phase-one infrastructure:

- `packages/core`: pure governance logic for parsing, scanning, linting, auditing, dedup, canonical storage, projection, providers, runtime paths, schema, and Writer Queue.
- `packages/daemon`: local JSON-RPC daemon over Unix domain socket.
- `packages/cli`: user-facing `cobweb` / `cw` commands.
- `packages/mcp`: MCP stdio server plus a compatibility shim that forwards to the daemon.
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
npm run dev:cli -- lint examples/skills/normal-review
npm run dev:cli -- vendor examples/skills/escaping-reference
npm run dev:cli -- merge examples/skills/duplicate-review examples/skills/normal-review

# import preview (dry-run) and daemon-backed write
npm run dev:cli -- import examples/skills/normal-review
npm run dev:cli -- import examples/skills/normal-review --write
npm run dev:cli -- sync --target agents --dry-run
npm run dev:cli -- policy check examples/skills/policy-difference

# daemon lifecycle
npm run dev:cli -- daemon start
npm run dev:cli -- daemon status
npm run dev:cli -- daemon doctor
npm run dev:cli -- daemon stop

# status, with read-only fallback when the daemon is down
npm run dev:cli -- status
npm run dev:cli -- status --readonly
```

## Local Trust Model

`cobwebd` is a local single-user write proxy. It can read and write paths supplied by the local CLI/MCP client for commands such as `import --write`, `sync --write`, `policy`, and `vendor --write`; only run those commands against trusted workspaces and skill directories. The daemon creates its data directory with `0700`, its pid lock with `0600`, and its Unix socket with `0600` permissions. Absolute resource references are reported for manual review instead of being vendored automatically.
