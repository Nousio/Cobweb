# Cobweb

English | [简体中文](./README.zh-CN.md)

Cobweb is a local-first governance and routing toolkit for Agent Skills. It scans existing `SKILL.md` directories, builds a SkillGraph from directory and document references, indexes skills for explainable local search, detects duplicates, registers skills in the local store, and can project canonical skills to agent tool directories such as Agents, Cursor, Claude, and Codex.

Cobweb does not introduce a private skill format. It works around the open `SKILL.md` convention and keeps the final semantic decision with the calling agent. Cobweb provides deterministic local signals: parsed metadata, method summaries, resource links, duplicate checks, FTS matches, score breakdowns, and SkillGraph context.

## Why Cobweb

Agent skills often live in many places: project folders, global tool folders, old workspaces, `.agents/skills`, `.cursor/skills`, `.claude/skills`, and `.codex`-compatible layouts. Over time, duplicate names, stale indexes, missing resources, and policy drift make it harder for an agent to choose the right skill.

Cobweb gives you one local control plane for those skills:

- Discover every `SKILL.md` under a directory.
- Inspect skill topology with an in-memory SkillGraph.
- Validate lightweight structure, resource references, policy alignment, and duplicate risk.
- Register a skill in the local index, or copy it into a canonical store when requested.
- Sync canonical skills into provider directories by link or copy.
- Let agents call the same governance model through an MCP stdio server.

## Installation

Cobweb requires Node.js `>=22`.

```bash
npm install -g cobweb
cobweb --version
```

Run once without installing:

```bash
npx cobweb --help
```

The published package exposes three binaries:

- `cobweb` / `cw`: the user-facing CLI.
- `cobwebd`: the local daemon that owns runtime state and writes.
- `cobweb-mcp`: the MCP stdio server for agent clients.

For normal usage, run `cobweb`. The daemon is started automatically by write commands when a built `cobwebd` entrypoint is available. MCP requests do not auto-start the daemon.

## Quick Start

Read-only inspection commands do not require the daemon:

```bash
cobweb scan ./skills
cobweb graph ./skills
cobweb graph chain ./skills --target my-skill
cobweb lint ./skills/my-skill
cobweb dedup ./skills
```

Write commands preview by default. Add `--write` when you want Cobweb to persist changes through the daemon Writer Queue. `sync` reads canonical records from `cobweb.lock.yaml`, so import with `--canonical <path>` before projecting a skill to provider directories:

```bash
cobweb import ./skills/my-skill
cobweb import ./skills/my-skill --write
cobweb import ./skills/my-skill --write --canonical ~/.local/share/cobweb/skills

cobweb sync --target agents,cursor
cobweb sync --target agents,cursor --write
```

Manage policy, local resources, and merge plans:

```bash
cobweb policy check ./skills/my-skill
cobweb policy ./skills/my-skill --implicit off
cobweb policy ./skills/my-skill --self-contained on

cobweb vendor ./skills/my-skill
cobweb vendor ./skills/my-skill --write

cobweb merge ./skills/old-skill ./skills/my-skill
```

Check runtime health:

```bash
cobweb status
cobweb status --readonly

cobweb daemon start
cobweb daemon status
cobweb daemon status --json
cobweb daemon doctor
cobweb daemon doctor --json
cobweb daemon repair
cobweb daemon stop
```

Most CLI commands print JSON so they can be piped into other tools. `cobweb daemon status` and `cobweb daemon doctor` print human-readable output by default and accept `--json`.

## CLI Commands

- `scan [path]`: recursively finds `SKILL.md` files and reports parsed candidates, duplicate names, and parser warnings.
- `graph [path]`: builds a read-only in-memory SkillGraph from a scan root.
- `graph chain [path] --target <target>`: returns one skill's containment path, outgoing skill references, incoming references, and resources.
- `lint [skill]`: checks description length, body length, and local resource references under the skill root.
- `dedup [path]`: detects exact and near duplicates using content hash, name, description, and lexical similarity.
- `import <path>`: previews an import; with `--write`, registers the source skill in SQLite, or copies it into a canonical store when `--canonical <path>` is provided.
- `sync`: projects canonical skills recorded in `cobweb.lock.yaml` into provider directories. Supported targets are `agents`, `cursor`, `claude`, and `codex`; the default strategy is symlink, and `--copy` uses copies.
- `policy [skill]`: checks or updates invocation and self-contained policy fields across supported tool conventions.
- `vendor <skill>`: copies local resources that escape the skill root into `resources/vendor/` and rewrites references when `--write` is used.
- `merge <source-skill> <target-skill>`: prints a merge plan without writing.
- `status`: reports daemon and store health, with `--readonly` for daemon-free fallback.
- `daemon`: starts, stops, diagnoses, or repairs the local daemon and SQLite index.

For large skill trees, reduce graph enumeration with:

```bash
cobweb graph ./skills --max-depth 16 --max-paths 500
```

## MCP Server

`cobweb-mcp` speaks MCP over stdio and forwards each tool call to the local daemon. Add it to your MCP client configuration:

```json
{
  "mcpServers": {
    "cobweb": {
      "command": "cobweb-mcp",
      "args": []
    }
  }
}
```

The MCP server exposes these tools:

- `status`: returns daemon status.
- `scan`: scans a directory for `SKILL.md` skills.
- `skill_graph`: builds an in-memory SkillGraph with `scan_root`, `skill`, `resource`, and `external` nodes.
- `skill_chain`: returns one skill's chain context from a scan root.
- `skill_search`: searches the daemon-managed SQLite FTS index and returns candidates with scores, score breakdowns, match reasons, and freshness.
- `skill_select`: selects the best indexed candidate for an analyzed routing query and returns recommendation, rejected candidates, optional SkillGraph chain context, and optional `guidance`.
- `skill_context`: returns method summaries, resources, policy, and lint context for one skill.
- `skill_validate`: combines lint, policy, and indexed duplicate checks before a skill is used or imported.

For `skill_select`, MCP callers must provide `workItem.subject`. The `query` should be analyzed routing terms, not the raw user sentence. When the work item is missing, input quality is low, no candidate is found, confidence is low, or top candidates are too close, Cobweb returns a `guidance` object with a reason, checklist, example, and `inspectionTargets` so the agent can refine the query or inspect exact skill paths.

If the daemon is not reachable, `cobweb-mcp` returns a retryable error instead of starting it. Run:

```bash
cobweb daemon start
```

If Cobweb is installed globally, make sure `cobwebd` is on `PATH` and that the MCP client uses the same `COBWEB_DATA_DIR` as the CLI.

## How It Works

Cobweb is split into strict layers:

- `core`: pure business logic for parsing, scanning, SkillGraph, lint, dedup, policy, vendor plans, provider projection, storage types, and search ranking.
- `daemon`: runtime owner for IPC, SQLite, Writer Queue, watchers, index lifecycle, and all persistent writes.
- `cli`: command parsing, daemon calls, read-only fallback, and output formatting.
- `mcp`: MCP stdio server that forwards tool calls to the daemon.

Write paths go through `cobwebd` and its Writer Queue. Read-only commands such as `scan`, `graph`, `lint`, `dedup`, and `merge` can run directly from the CLI without daemon state.

## Search and Freshness

`skill_search` and `skill_select` use SQLite FTS5 with CJK bigram text augmentation, then apply deterministic re-ranking over name coverage, method trigger terms, descriptions, field coverage, content matches, and BM25. Cobweb does not run embedding models, keep a vector table, call external AI APIs, or persist model judgments.

Search results include a `freshness` field:

- `fresh`: the root has been reconciled and can use the warm fast path while the staleness budget is valid.
- `rebuilding`: an index task is running or queued.
- `degraded`: Cobweb can still answer from the local index, but watcher, parser, schema, or reconcile diagnostics need attention.

The default staleness budget is `2000ms`. Set `COBWEB_MAX_STALENESS_MS` to tune it. Cobweb watches known indexed `SKILL.md` files rather than recursively watching whole workspaces; when watcher support is unavailable, it falls back to content-hash reconciliation.

Use `cobweb daemon status` for root-level freshness diagnostics and `cobweb daemon doctor` for SQLite, schema, and FTS/index consistency checks. If doctor reports index drift, run `cobweb daemon repair` or search the affected root to reconcile it.

## Local Trust Model

Cobweb is a local, single-user tool. The default data directory is:

```bash
~/.local/share/cobweb
```

You can override runtime paths with `COBWEB_DATA_DIR`, `COBWEB_DB_PATH`, `COBWEB_SOCKET_PATH`, `COBWEB_LOCK_PATH`, and `COBWEB_DAEMON_LOCK_PATH`.

For write commands such as `import --write`, `sync --write`, policy updates, and `vendor --write`, Cobweb reads and writes the paths supplied by your CLI or MCP client. Only run write commands against trusted workspaces and skill directories.

The daemon creates its data directory as `0700`, its daemon lock as `0600`, and its socket as `0600`. Absolute and external resource references are reported for manual review instead of being vendored automatically.

## Current Boundaries

Cobweb currently focuses on local governance and explainable routing. It intentionally does not provide:

- A new proprietary skill format.
- A remote registry, marketplace, TUI, or Web UI.
- Embeddings, vector search, model hosting, or external AI provider calls.
- Persistent graph edges for SkillGraph. Graphs are built as read-only snapshots.
- Default audit, risk, or blocked judgments over a user's existing skill topology.
