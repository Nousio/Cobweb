# Cobweb

Cobweb is a local governance kernel for agent skills. It scans your `SKILL.md` files, audits them for risky patterns, finds duplicates, imports a single canonical copy into a local store, and syncs that copy out to your agent tools (Agents, Cursor, Claude, Codex).

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
| `lint` | Check a skill's description length, body length, and resource references. |
| `audit` | Flag risky patterns such as `curl \| sh`, destructive deletes, secret reads, `sudo`, and out-of-bounds references. |
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
cobweb lint ./skills/my-skill
cobweb audit ./skills/my-skill --strict
cobweb dedup ./skills
```

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

## Local Trust Model

`cobwebd` is a local, single-user write proxy. For write commands such as `import --write`, `sync --write`, `policy` updates, and `vendor --write`, it reads and writes the paths your CLI or MCP client supplies, so only run them against trusted workspaces and skill directories. The daemon creates its data directory as `0700`, its pid lock as `0600`, and its socket as `0600`. Absolute resource references are reported for manual review rather than vendored automatically.
