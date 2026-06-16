# Cobweb

Cobweb is a local governance kernel for agent skills. It scans your `SKILL.md` files, indexes them for routing, finds duplicates, imports a single canonical copy into a local store, and syncs that copy out to your agent tools (Agents, Cursor, Claude, Codex).

Everything runs on your machine: a CLI (`cobweb`), a background daemon (`cobwebd`) that owns every write, and an MCP server (`cobweb-mcp`) so agents can call Cobweb directly.

## Installation

```bash
npm install -g cobweb
cobweb --version
```

Run it once without installing:

```bash
npx cobweb --help
```

Installing the package gives you three commands: `cobweb` (alias `cw`) for the CLI, `cobwebd` for the daemon, and `cobweb-mcp` for the MCP server. The daemon starts on demand whenever a command needs to write, so day to day you only run `cobweb`.

## Features

Every command prints JSON, so results are easy to read or pipe into other tools.

| Command | What it does |
| --- | --- |
| `scan` | Discover every `SKILL.md` under a directory and report the skills it finds. |
| `graph` | Build a read-only SkillGraph showing skill hierarchy and document references from a scan root. |
| `lint` | Check a skill's description length, body length, and resource references. |
| `dedup` | Detect duplicate or near-duplicate skills by content hash, name, and lexical similarity. |
| `import` | Preview, then write, a skill into the local canonical store. |
| `sync` | Project the canonical copy out to your agent providers. |
| `policy` | Inspect or update a skill's invocation and self-contained policy. |
| `vendor` | Copy a skill's external local resources next to it so it stays self-contained. |
| `merge` | Plan a merge of one skill into another. |
| `status` | Report daemon and store health. |

## Usage

Inspect skills (read-only, no daemon needed):

```bash
cobweb scan ./skills
cobweb graph ./skills
cobweb lint ./skills/my-skill
cobweb dedup ./skills
```

Use `cobweb graph ./skills --max-depth 16 --max-paths 500` when a large skill tree needs a smaller path enumeration budget.

Import into the local store and sync to your tools. These write through the daemon, which starts automatically; pass `--write` to persist, or omit it for a dry-run preview:

```bash
cobweb import ./skills/my-skill            # dry-run preview
cobweb import ./skills/my-skill --write     # persist
cobweb sync --target agents,cursor          # dry-run preview
cobweb sync --target agents,cursor --write  # project the files
```

Manage policy and resources:

```bash
cobweb policy check ./skills/my-skill
cobweb policy ./skills/my-skill --implicit off
cobweb vendor ./skills/my-skill             # dry-run preview
cobweb merge ./skills/old-skill ./skills/my-skill
```

Check status and control the daemon:

```bash
cobweb status              # falls back to read-only output when the daemon is down
cobweb status --readonly
cobweb daemon status
cobweb daemon doctor
cobweb daemon stop
```

## MCP Client Config

`cobweb-mcp` speaks MCP over stdio and forwards each tool call to the local daemon. Point your MCP client at the installed command:

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

The MCP server exposes the same local governance model to agents:

- `status` and `scan` report daemon health and discovered skills.
- `skill_graph` builds a topology graph of skill directories and document references from a scan root.
- `skill_search` searches the daemon-managed FTS index and returns candidates with scores, match reasons, and freshness.
- `skill_select` chooses the best indexed candidate and explains the recommendation.
- `skill_context` returns method summaries, resources, policy, and lint context for one skill.
- `skill_validate` combines lint, policy, and indexed duplicate checks before a skill is used or imported.

If the daemon is not reachable, `cobweb-mcp` does not start it for you. Start the daemon with `cobweb daemon start`, then retry the MCP request. If the command was installed globally, make sure `cobwebd` is on `PATH` and the MCP client uses the same `COBWEB_DATA_DIR` as the CLI.

## Index Freshness

`skill_search` and `skill_select` include a `freshness` field:

- `fresh` means Cobweb has reconciled the requested root and, while the root remains warm, can answer repeated queries from its in-memory manifest without rereading every `SKILL.md`.
- `rebuilding` means an index task is running or queued.
- `degraded` means Cobweb can still answer from the local index, but a watcher, parser, schema, or recent reconcile issue needs attention.

Cobweb uses a bounded staleness budget for warm roots. The default is `2000ms`; set `COBWEB_MAX_STALENESS_MS` to tune it. Within that budget, a clean warm root can use the fast path. After the time since the last real disk verification expires, Cobweb checks the `SKILL.md` path list plus `size` and `mtimeMs`; if the signature changed, it performs a full content-hash reconcile. If the watcher is unavailable, the root falls back to full content-hash reconcile on every query.

Use `cobweb daemon status` for the human-readable root diagnostics. It shows watcher state, dirty roots, in-flight indexing, fast-path eligibility, the staleness budget, last query check time, last disk verification time, last full reconcile time, and the last per-root index error. `cobweb daemon doctor` checks SQLite quick health, foreign keys, schema shape, and FTS/index consistency; if it reports index drift, run `cobweb daemon repair` or search the affected root to reconcile it.

## Local Trust Model

`cobwebd` is a local, single-user write proxy. For write commands such as `import --write`, `sync --write`, `policy` updates, and `vendor --write`, it reads and writes the paths your CLI or MCP client supplies, so only run them against trusted workspaces and skill directories. The daemon creates its data directory as `0700`, its pid lock as `0600`, and its socket as `0600`. Absolute resource references are reported for manual review rather than vendored automatically.

The daemon remembers explicitly indexed roots so it can restore their file watchers after a restart. Restored roots are not treated as fresh until the next query or file event reconciles their `SKILL.md` content hashes. Cobweb hashes only the `SKILL.md` source for index freshness; changes that only touch `scripts/`, `references/`, or `assets/` are reflected by live validation tools, while cached methods and FTS content update on the next `SKILL.md` reconcile or repair.
