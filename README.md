# openCobweb

English | [简体中文](./README.zh-CN.md)

<sub>License: [AGPL-3.0-only](./LICENSE).</sub>

openCobweb helps an AI agent quickly find a better-matching skill from your local `SKILL.md` library: it searches with a local index and match reasons, then loads the selected skill context on demand. This can reduce the token waste of putting every skill's full text into the conversation, though the actual savings depend on your skill set and MCP client behavior.

## Why openCobweb

- Less manual prompting: the agent can search local skills through MCP and load the selected skill context.
- Less irrelevant context: select a candidate first, then load its context instead of starting with every skill's full text.
- Less duplicate maintenance: use the CLI to scan, lint, deduplicate, and preview projection into Cursor, Claude, and other tool directories.
- Easier debugging: search results include match reasons so you can see why a skill was selected.

## Requirements

- Node.js `>= 22`

## Quick Start

### 1. Check Node.js

openCobweb requires Node.js `>= 22`:

```bash
node --version
```

### 2. Configure Your MCP Client

This is MCP client configuration, not a command to run in a terminal. Add it to your MCP client config file:

```json
{
  "mcpServers": {
    "cobweb": {
      "command": "npx",
      "args": ["-y", "--package", "opencobweb", "cobweb-mcp"]
    }
  }
}
```

Common locations:

- **Cursor** — `.cursor/mcp.json` in your project, or the global MCP settings.
- **Claude Desktop** — `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`).
- **Other MCP clients** — any file that accepts the standard `mcpServers` block.

Restart your MCP client after saving the config. Once connected, your agent can see Cobweb tools such as `skill_search`, `skill_select`, and `skill_context`.

### 3. Create a Demo Skill

```bash
mkdir -p ./demo-skills/review-pr
cat > ./demo-skills/review-pr/SKILL.md <<'EOF'
---
name: review-pr
description: Review pull requests for correctness and risk.
---

# When to use

Use this skill when reviewing a pull request or checking a branch diff.

# Workflow

Input: repository diff.
Output: concise review findings.
Tools: git, tests.
EOF
```

### 4. Check It with the CLI

```bash
npx -y --package opencobweb cobweb scan ./demo-skills
npx -y --package opencobweb cobweb lint ./demo-skills/review-pr
npx -y --package opencobweb cobweb dedup ./demo-skills
```

### 5. Ask Your Agent to Use It

In your MCP client, ask:

```text
Use Cobweb to find a skill for reviewing a pull request in ./demo-skills.
```

The client will typically call `skill_select` or `skill_search`, then call `skill_context` for the selected skill.

## Installation Options

The quick start uses `npx`, so no global installation is required. If you use the CLI often, install it globally:

```bash
npm install -g opencobweb
```

Then you can run:

```bash
cobweb scan ./demo-skills
cobweb lint ./demo-skills/review-pr
```

If you want your MCP client to use the global command instead, configure:

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

If the client cannot find `cobweb-mcp`, make sure the global npm bin directory is available in that client's `PATH`; if necessary, set `command` to the actual absolute path of the `cobweb-mcp` binary.

## MCP Tools

Once connected, the agent can call these tools. Each takes a directory `path` (a scan root containing skills) unless noted; absolute paths are recommended across clients.

| Tool | Description |
| --- | --- |
| `skill_search` | Full-text search across indexed skills, returning candidates with the reasons each one matched. |
| `skill_select` | Pick the best skill for an analyzed routing query, with a deterministic score breakdown and SkillGraph chain context. Returns `guidance` (and inspection targets) when the input is ambiguous or confidence is low. |
| `skill_context` | Return a skill's methods, resources, policy, and lint context — call this after selecting a skill, before acting on it. |
| `skill_graph` | Build an in-memory, read-only SkillGraph topology (scan roots, skills, resources, references) from a scan root. |
| `skill_chain` | Return one skill's root-to-skill path, outgoing/incoming references, and referenced resources within the graph. |
| `skill_validate` | Validate a skill with lint, policy, and indexed duplicate checks. |
| `scan` | Discover `SKILL.md` skills under a directory (read-only). |
| `status` | Report daemon status, index freshness, and runtime/lease state. |

## Common CLI Commands

The `cobweb` CLI manages skills as a governed library. Commands print JSON so they compose well in scripts. Common workflow:

```bash
# Discover skills in a directory
npx -y --package opencobweb cobweb scan ./demo-skills

# Lint a single skill
npx -y --package opencobweb cobweb lint ./demo-skills/review-pr

# Find near-duplicate skills
npx -y --package opencobweb cobweb dedup ./demo-skills

# Import a skill into the canonical store (writes through the daemon)
npx -y --package opencobweb cobweb import ./demo-skills/review-pr --write --canonical ./canonical-skills

# Preview projection into tool install directories
npx -y --package opencobweb cobweb sync --target cursor,claude

# Inspect runtime state
npx -y --package opencobweb cobweb status
npx -y --package opencobweb cobweb daemon status
```

Write commands (`import --write`, `sync --write`, `vendor --write`, `policy` updates) go through the daemon's Writer Queue. Read-only commands (`scan`, `lint`, `dedup`, `graph`) run without a daemon. `sync --write` writes to tool-specific target directories; confirm the target paths and permissions before using it. The example above keeps the preview command. Run `npx -y --package opencobweb cobweb --help` for the full command list.

## Configuration reference

openCobweb stores its runtime under a single data directory. Set the same `COBWEB_DATA_DIR` for both your MCP client and the CLI so they share one daemon and index.

| Variable | Description | Default |
| --- | --- | --- |
| `COBWEB_DATA_DIR` | Base directory for the index, socket, and lockfile. | `~/.local/share/cobweb` |
| `COBWEB_DB_PATH` | SQLite index path. | `$COBWEB_DATA_DIR/cobweb.db` |
| `COBWEB_SOCKET_PATH` | Daemon IPC socket path. | `$COBWEB_DATA_DIR/cobwebd.sock` |
| `COBWEB_LOCK_PATH` | Canonical lockfile path. | `$COBWEB_DATA_DIR/cobweb.lock.yaml` |
| `COBWEB_IDLE_TIMEOUT_MS` | Idle time before the daemon shuts itself down. | `600000` |

## How it works

`cobweb-mcp` is a stdio shim for the local `cobwebd` runtime. When the MCP server starts, it connects to (or starts) the single local daemon, opens a runtime lease, and keeps that lease alive for the duration of the MCP session. The daemon does not idle-stop while a lease, request, writer task, or index task is active. After the MCP session disconnects and the lease is released or expires, the daemon returns to its normal idle shutdown policy.

The daemon is the sole owner of runtime state — the SQLite index, the Writer Queue, and the file watchers. The MCP server and the CLI are both clients of that daemon, which keeps writes single-threaded and the index consistent.

## License

[AGPL-3.0-only](./LICENSE).
