# Contributing

Cobweb is an npm workspace monorepo. The governance core stays free of transport and presentation concerns, and each layer depends only on the ones beneath it.

## Packages

- `packages/core` — pure governance logic: parsing, Method extraction, scanning, linting, dedup, FTS search, canonical storage, projection, providers, runtime paths, schema, and the Writer Queue.
- `packages/daemon` — local JSON-RPC daemon over a Unix domain socket; owns runtime state, index lifecycle, watch root recovery, and all SQLite writes.
- `packages/cli` — the `cobweb` / `cw` commands.
- `packages/mcp` — the MCP stdio server, which exposes governance and explainable skill routing tools by forwarding to the daemon.
- `packages/cobweb` — the public aggregate package that bundles the others behind the `cobweb`, `cw`, `cobwebd`, and `cobweb-mcp` binaries.
- `test` — unit and integration tests, organized by package and feature area; parser compatibility fixtures live under `test/fixtures/skills`.
- `examples/skills` — smoke-test skills covering normal, duplicate, linked-resource, script-reference, and policy-difference cases.

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

## Development-only Files

Tests and release verification never ship to users. The following are dev/CI-only and are excluded from every published package:

- `test/**/*.test.ts` — unit and integration tests, centralized under the root `test` directory.
- `test/fixtures/skills` — parser compatibility fixtures for the agentskills.io / Agent Skills format.
- `vitest.config.ts` — test runner configuration.
- `scripts/` — release packaging (`pack-release.sh`), install smoke (`smoke-install.sh`), and the publish guard (`verify-pack.sh`).
- `.github/` and `examples/skills` — CI workflows and smoke fixtures.

Two layers keep them out of the published artifact: tests live outside every package `src` tree, and each package `package.json` uses a `files` allowlist that ships only `dist/**` (plus the aggregate `README.md`). The smoke test (`npm run smoke:install`) is a local/CI verification step, not a publish requirement.

Keep `examples/skills` for smoke checks and user-facing examples. Do not place parser compatibility matrices there; use `test/fixtures/skills` so tests and examples keep separate responsibilities.

Index lifecycle tests should cover both daemon behavior and core storage primitives. Put parser compatibility cases under `test/fixtures/skills`, database/runtime ledger checks under `test/core/db`, and daemon reconcile/watch-root behavior under `test/daemon`. Writes to `runtime_state` must still happen inside the daemon Writer Queue; reads can happen during daemon startup to restore watch roots.

Run the publish guard to assert no test, `src`, or dev-only file would be published:

```bash
npm run build        # produce dist for each package
npm run verify:pack  # fail if any package would ship test/src/dev files
```

## Continuous Integration

`.github/workflows/ci.yml` runs the typecheck, the publish guard, the test suite, CLI and daemon smoke checks, and an install smoke test against the packed aggregate tarball on every PR.
