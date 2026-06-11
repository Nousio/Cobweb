# Contributing

Cobweb is an npm workspace monorepo. The governance core stays free of transport and presentation concerns, and each layer depends only on the ones beneath it.

## Packages

- `packages/core` — pure governance logic: parsing, Method extraction, scanning, linting, auditing, dedup, FTS search, canonical storage, projection, providers, runtime paths, schema, and the Writer Queue.
- `packages/daemon` — local JSON-RPC daemon over a Unix domain socket; owns runtime state, index lifecycle, and all SQLite writes.
- `packages/cli` — the `cobweb` / `cw` commands.
- `packages/mcp` — the MCP stdio server, which exposes governance and explainable skill routing tools by forwarding to the daemon.
- `packages/cobweb` — the public aggregate package that bundles the others behind the `cobweb`, `cw`, `cobwebd`, and `cobweb-mcp` binaries.
- `examples/skills` — smoke-test skills covering normal, duplicate, escaping, high-risk, and policy-difference cases.

## Local Development

```bash
npm install
npm run check          # tsc -b project references
npm test               # vitest unit + integration tests
npm test -- --coverage # coverage report (target: > 70%)
```

Run the CLI from source without building first:

```bash
npm run dev:cli -- scan examples/skills
```

## Continuous Integration

`.github/workflows/ci.yml` runs the typecheck, the test suite, CLI and daemon smoke checks, and an install smoke test against the packed aggregate tarball on every PR.
