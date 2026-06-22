# openCobweb

<sub>License: AGPL-3.0-only.</sub>

openCobweb helps an AI agent quickly find a better-matching skill from your local `SKILL.md` library: it searches with a local index and match reasons, then loads the selected skill context on demand. This can reduce the token waste of putting every skill's full text into the conversation, though the actual savings depend on your skill set and MCP client behavior.

You get a small local workflow for using skills across tools: search and load selected skill context from an MCP client, check skills from the CLI, and preview projection into tool directories such as Cursor and Claude.

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

Put this in `.cursor/mcp.json` (Cursor), `claude_desktop_config.json` (Claude Desktop), or any client file that accepts the standard `mcpServers` block, then restart your MCP client.

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

If the client cannot find `cobweb-mcp`, make sure the global npm bin directory is available in that client's `PATH`; if necessary, set `command` to the actual absolute path of the binary.

## MCP Tools

Once connected, the agent can call these tools. Each takes a directory `path` (a scan root containing skills) unless noted; absolute paths are recommended across clients.

| Tool | Description |
| --- | --- |
| `skill_search` | Full-text search across indexed skills, returning candidates with the reasons each one matched. |
| `skill_select` | Pick the best skill for an analyzed routing query, with a deterministic score breakdown and SkillGraph chain context. Returns `guidance` when the input is ambiguous or confidence is low. |
| `skill_context` | Return a skill's methods, resources, policy, and lint context. |
| `skill_graph` | Build an in-memory, read-only SkillGraph topology from a scan root. |
| `skill_chain` | Return one skill's root-to-skill path, references, and resources within the graph. |
| `skill_validate` | Validate a skill with lint, policy, and indexed duplicate checks. |
| `scan` | Discover `SKILL.md` skills under a directory (read-only). |
| `status` | Report daemon status, index freshness, and runtime/lease state. |

## Common CLI Commands

The `cobweb` CLI manages skills as a governed library and prints JSON output:

```bash
npx -y --package opencobweb cobweb scan ./demo-skills
npx -y --package opencobweb cobweb lint ./demo-skills/review-pr
npx -y --package opencobweb cobweb dedup ./demo-skills
npx -y --package opencobweb cobweb sync --target cursor,claude
npx -y --package opencobweb cobweb status
```

Write commands go through the daemon's Writer Queue. `sync --write` writes to tool-specific target directories; confirm the target paths and permissions before using it. The example above keeps the preview command. Run `npx -y --package opencobweb cobweb --help` for the full command list.

## Configuration reference

Set the same `COBWEB_DATA_DIR` for your MCP client and the CLI so they share one daemon and index.

| Variable | Description | Default |
| --- | --- | --- |
| `COBWEB_DATA_DIR` | Base directory for the index, socket, and lockfile. | `~/.local/share/cobweb` |
| `COBWEB_DB_PATH` | SQLite index path. | `$COBWEB_DATA_DIR/cobweb.db` |
| `COBWEB_SOCKET_PATH` | Daemon IPC socket path. | `$COBWEB_DATA_DIR/cobwebd.sock` |
| `COBWEB_LOCK_PATH` | Canonical lockfile path. | `$COBWEB_DATA_DIR/cobweb.lock.yaml` |
| `COBWEB_IDLE_TIMEOUT_MS` | Idle time before the daemon shuts itself down. | `600000` |

## How it works

`cobweb-mcp` connects to or starts one local `cobwebd` runtime, opens a runtime lease for the MCP session, and keeps the daemon alive while that lease is active. The daemon is the sole owner of the SQLite index, the Writer Queue, and the file watchers; the MCP server and CLI are both clients of it. After the MCP session disconnects and the lease is released or expires, the daemon returns to its normal idle shutdown policy.

## License

AGPL-3.0-only.
