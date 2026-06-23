# openCobweb

<sub>License: AGPL-3.0-only.</sub>

openCobweb helps an AI agent quickly find a better-matching skill from your local `SKILL.md` library. Instead of pasting every skill's full text into the conversation, the agent searches a local index, gets match reasons, and loads only the selected skill's context on demand. This can reduce token waste from loading every skill up front.

## Why openCobweb

- Less manual prompting: the agent can search local skills through MCP and load the matching context on demand.
- Less irrelevant context: select a candidate first, then read its context instead of loading every skill's full text at the start.
- Less duplicate maintenance: use the CLI to check, deduplicate, and preview projection into Cursor, Claude, and other tool directories.
- Easier debugging: search results include match reasons so you can see why the agent selected a skill.

## Requirements

- Node.js `>= 22` (check with `node --version`)

## Quick start: use npx

Most users should use this path: **do not install anything globally; configure your MCP client to start `cobweb-mcp` through `npx`**. Do these three steps first, then decide whether you need the optional global install below.

### 1. Confirm Node.js

```bash
node --version
```

If this prints `v22` or higher, you're ready. If not, install Node 22+ first.

### 2. Add Cobweb to your MCP client

Copy this example and replace `/Users/you/skills` with your skills directory. It uses the recommended setup: `npx` downloads and runs the `cobweb-mcp` binary from the npm package as needed.

This is **client configuration**, not a terminal command. Open your client's MCP config file and add the `cobweb` block inside `mcpServers`:

```json
{
  "mcpServers": {
    "cobweb": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "opencobweb",
        "cobweb-mcp",
        "--path",
        "/Users/you/skills"
      ]
    }
  }
}
```

Multiple-path configuration example:

```json
{
  "mcpServers": {
    "cobweb": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "opencobweb",
        "cobweb-mcp",
        "--path",
        "/Users/you/work-skills",
        "/Users/you/personal-skills"
      ]
    }
  }
}
```

Where the file lives:

- **Cursor**: `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for all projects
- **Claude Desktop**: `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`)
- **Other clients**: any file that accepts the standard `mcpServers` block

What each part means:

| Field | Meaning |
| --- | --- |
| `command: "npx"` | Run a package binary without installing it globally. |
| `-y` | Auto-confirm the one-time download, so the client doesn't hang on a prompt. |
| `--package opencobweb` | The npm package to fetch. Needed because the binary name differs from the package name. |
| `cobweb-mcp` | The binary to launch inside that package — this is the MCP server (not the CLI). |
| `--path /Users/you/skills` | The skill directory this MCP server should serve by default. |

> Want a fixed version instead of always-latest? Pin it: `"--package", "opencobweb@0.4.1"`. The `@0.4.1` part means version `0.4.1`.

### 3. Restart the client and confirm the tools appear

Restart (or reload) your MCP client. Cobweb's tools (`skill_search`, `skill_select`, `skill_context`, …) should now show up in the client's MCP/tools list. The first launch may take a few seconds while `npx` downloads the package.

Cobweb is now installed and configured. When the agent calls `scan`, `skill_search`, or `skill_select` without an explicit tool `path`, Cobweb uses the `--path` directory from your MCP config.

## Optional: global install

This is not required. If your MCP client is already configured with the recommended `npx` setup above, you can skip this section. Use a global install only if you often run the `cobweb` CLI manually and want shorter terminal commands.

```bash
npm install -g opencobweb
```

Then you can run:

```bash
cobweb scan ./skills
cobweb lint ./skills/some-skill
```

To point your MCP client at the global binary instead of `npx`:

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

If the client reports that `cobweb-mcp` can't be found, the global npm bin directory isn't on that client's `PATH`. Either fix the client's `PATH`, or set `command` to the binary's absolute path (find it with `which cobweb-mcp`).

Simple choice:

- **Only want Cobweb in Cursor, Claude Desktop, or another MCP client**: use the recommended `npx` config above; no global install needed.
- **Often run `cobweb scan` or `cobweb lint` in a terminal**: install globally for shorter CLI commands.

## Everyday use

To quickly confirm the directory is discoverable from the terminal:

```bash
npx -y --package opencobweb cobweb scan /Users/you/skills
```

### Configure one or more skill directories

List several directories after a single `--path` (a directory array) to let one MCP server serve several skill directories:

```json
{
  "mcpServers": {
    "cobweb": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "opencobweb",
        "cobweb-mcp",
        "--path",
        "/Users/you/work-skills",
        "/Users/you/personal-skills"
      ]
    }
  }
}
```

If you prefer, repeating `--path` works too — both forms are equivalent.

After one or more `--path` entries are configured, `scan`, `skill_search`, and `skill_select` may omit the tool `path`; with multiple directories, Cobweb queries each configured directory and merges the candidates.

Note that `skill_context` reads one concrete skill, so it still needs the selected skill path. The usual flow is `skill_select` first, then pass its returned `selected.path` into `skill_context`.

If a `--path` entry is present but its value is empty, `cobweb-mcp` refuses to start and exits with an error, so the misconfiguration surfaces in the client instead of quietly running a server with no skill directory.

The CLI can specify a directory per command:

```bash
npx -y --package opencobweb cobweb scan /Users/you/skills
npx -y --package opencobweb cobweb dedup /Users/you/skills
npx -y --package opencobweb cobweb graph /Users/you/skills
```

CLI directory arguments only affect that one command; they do not update the MCP config.

## Try it out (optional — for testing only)

Everything in this section is just to verify the setup against a throwaway skill. It is not part of normal usage; skip it once you're pointing Cobweb at your real skills.

### Create a demo skill

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

### Check it from the CLI

```bash
npx -y --package opencobweb cobweb scan ./demo-skills
npx -y --package opencobweb cobweb lint ./demo-skills/review-pr
```

### Ask your agent to use it

In your MCP client, ask:

```text
Use Cobweb to find a skill for reviewing a pull request in ./demo-skills.
```

The client typically calls `skill_select` (or `skill_search`) to pick a skill, then `skill_context` to load its details. Use an **absolute path** if your client's working directory is unclear.

## MCP tools

Once connected, the agent can call these tools. Each takes a directory `path` (a scan root containing skills) unless noted; absolute paths work most reliably across clients.

| Tool | What it does |
| --- | --- |
| `skill_search` | Full-text search across indexed skills, returning candidates and why each one matched. |
| `skill_select` | Pick the best skill for an analyzed routing query, with a deterministic score breakdown and SkillGraph chain context. Returns `selectionStatus`; low-confidence results are tentative and include `guidance` plus inspection targets. |
| `skill_context` | Return a skill's methods, resources, policy, and lint context. |
| `skill_graph` | Build an in-memory, read-only SkillGraph topology from a scan root. |
| `skill_chain` | Return one skill's root-to-skill path, references, and resources within the graph. |
| `skill_validate` | Validate a skill with lint, policy, and indexed duplicate checks. |
| `scan` | Discover `SKILL.md` skills under a directory (read-only). |
| `status` | Report daemon status, index freshness, and runtime/lease state. |

## CLI commands

The `cobweb` CLI manages skills as a governed library and prints JSON. The most common commands:

| Command | Purpose |
| --- | --- |
| `cobweb scan [path]` | List the `SKILL.md` skills under a directory. Read-only. |
| `cobweb lint [skill]` | Check one skill for structural and content issues. |
| `cobweb dedup [path]` | Find near-duplicate skills under a directory. |
| `cobweb status` | Show daemon status and index freshness (`--readonly` skips the daemon). |
| `cobweb sync` | Project skills into tool directories (Cursor, Claude, etc.). Preview by default. |

`scan`, `lint`, and `dedup` are read-only and run without a daemon. Commands that change files (such as `sync --write`, `import --write`) go through the daemon's Writer Queue. `sync` previews by default; add `--write` to actually write, and confirm target paths and permissions first:

```bash
# Preview which providers would receive which skills
npx -y --package opencobweb cobweb sync --target cursor,claude

# Available providers: agents, cursor, claude, codex
```

Run `cobweb --help` (or `npx -y --package opencobweb cobweb --help`) for the full list.

## Configuration reference

Cobweb keeps its runtime under one data directory. By default that is `~/.local/share/cobweb`, and **both the MCP server and the CLI use this same default automatically** — so out of the box they already share one daemon and index, and you don't need to set anything.

You only need these variables if you want a custom location (for example, an isolated per-project setup). If you do set one, set it for **both** the MCP client and your shell, or the two clients will point at different data directories.

| Variable | What it controls | Default |
| --- | --- | --- |
| `COBWEB_DATA_DIR` | Base directory for the index, socket, and lockfile. | `~/.local/share/cobweb` |
| `COBWEB_DB_PATH` | SQLite index path. | `$COBWEB_DATA_DIR/cobweb.db` |
| `COBWEB_SOCKET_PATH` | Daemon IPC socket path. | `$COBWEB_DATA_DIR/cobwebd.sock` |
| `COBWEB_LOCK_PATH` | Canonical lockfile path. | `$COBWEB_DATA_DIR/cobweb.lock.yaml` |
| `COBWEB_IDLE_TIMEOUT_MS` | How long the daemon stays alive while idle before shutting itself down, in milliseconds. | `600000` (10 minutes) |

To use a custom data directory, add `env` to the MCP config and export the same value in your shell:

```json
{
  "mcpServers": {
    "cobweb": {
      "command": "npx",
      "args": ["-y", "--package", "opencobweb", "cobweb-mcp"],
      "env": {
        "COBWEB_DATA_DIR": "/Users/you/.local/share/cobweb"
      }
    }
  }
}
```

```bash
export COBWEB_DATA_DIR="/Users/you/.local/share/cobweb"
```

## How it works

`cobweb-mcp` connects to (or starts) one local `cobwebd` daemon and opens a runtime lease for the MCP session, keeping the daemon alive while the session is active. The daemon is the sole owner of the SQLite index, the Writer Queue, and the file watchers; the MCP server and the CLI are both clients of it. After the MCP session disconnects and the lease expires, the daemon falls back to its idle-shutdown policy (`COBWEB_IDLE_TIMEOUT_MS`).

## Troubleshooting

- **Client says `cobweb-mcp` not found.** With the `npx` config this shouldn't happen; double-check `command` is `npx`. With a global install, your client's `PATH` is missing the npm bin directory — use the absolute path from `which cobweb-mcp`.
- **First launch is slow or times out.** `npx` is downloading the package. Try once in a terminal: `npx -y --package opencobweb cobweb --version`, then reconnect the client.
- **`node: command not found` or version errors.** Ensure Node `>= 22` is installed and visible to the client (GUI apps don't always inherit your shell `PATH`).
- **CLI and agent seem to disagree.** They use different data directories. Either leave `COBWEB_DATA_DIR` unset everywhere (recommended), or set the exact same value in both the MCP config and your shell.
- **Tools return empty results.** Confirm the `path` you pass actually contains `SKILL.md` files, and prefer an absolute path.

## License

AGPL-3.0-only.
