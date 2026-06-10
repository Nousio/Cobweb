# Cobweb

Local governance kernel for agent skills — CLI (`cobweb`), daemon (`cobwebd`), SQLite state store, and `SKILL.md` parsing, validation, auditing, dedup, and sync.

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
npm run check
npm test
```

Useful smoke checks:

```bash
npm run dev:cli -- scan examples/skills
npm run dev:cli -- audit examples/skills/high-risk-script
npm run dev:cli -- dedup examples/skills
```
