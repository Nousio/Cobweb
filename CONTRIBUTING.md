# Contributing

Cobweb is an npm workspace monorepo. The governance core stays free of transport and presentation concerns, and each layer depends only on the ones beneath it.

Contributions are accepted under the same `AGPL-3.0-only` license as the project.

## Packages

- `packages/core` — pure governance logic: parsing, Method extraction, scanning, linting, dedup, FTS search, canonical storage, projection, providers, runtime paths, schema, and the Writer Queue.
- `packages/daemon` — local JSON-RPC daemon over a Unix domain socket; owns runtime state, runtime leases, index lifecycle, watch root recovery, and all SQLite writes.
- `packages/cli` — the `cobweb` / `cw` commands.
- `packages/mcp` — the MCP stdio server, which exposes governance and explainable skill routing tools by connecting to the daemon and holding a runtime lease for the MCP session.
- `packages/cobweb` — the openCobweb aggregate package published as `opencobweb`; it bundles the others behind the `cobweb`, `cw`, `cobwebd`, and `cobweb-mcp` binaries.
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
- `.github/` and `examples/skills` — CI workflows and smoke fixtures.

Two layers keep them out of the published artifact: tests live outside every package `src` tree, and each package `package.json` uses a `files` allowlist that ships only `dist/**` (plus the aggregate `README.md`).

Keep `examples/skills` for smoke checks and user-facing examples. Do not place parser compatibility matrices there; use `test/fixtures/skills` so tests and examples keep separate responsibilities.

Index lifecycle tests should cover both daemon behavior and core storage primitives. Put parser compatibility cases under `test/fixtures/skills`, database/runtime ledger checks under `test/core/db`, and daemon reconcile/watch-root behavior under `test/daemon`. Writes to `runtime_state` must still happen inside the daemon Writer Queue; reads can happen during daemon startup to restore watch roots.

Runtime lifecycle changes should preserve the single-owner daemon model. MCP may start or reconnect to the daemon at session startup, but tool calls should forward through the daemon client; lease, active request, writer, and index in-flight state must all block idle shutdown.

Release packaging, publish-set verification, and the npm publish are maintainer tasks. They run from local release scripts kept outside this repository, so they are not part of the contributor workflow and are not needed to build, test, or run Cobweb locally.

## Continuous Integration

`.github/workflows/ci.yml` runs the typecheck, the test suite, and CLI and daemon smoke checks on every PR.
