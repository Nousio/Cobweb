# Cobweb

One-step installer package for Cobweb CLI, daemon, and MCP server.

```bash
npm install -g cobweb
cobweb --help
```

This package exposes the public commands and bundles the internal workspace packages:

- `cobweb` / `cw`: user-facing CLI.
- `cobwebd`: local daemon.
- `cobweb-mcp`: MCP stdio server.

`cobweb` handles local read-only commands directly and sends writes through the daemon Writer Queue. `cobweb-mcp` only forwards to an already running local daemon; start it with `cobweb daemon start` before MCP use.

The MCP server exposes `status`, `scan`, `skill_graph`, `skill_chain`, FTS-backed `skill_search`, explainable `skill_select`, `skill_context`, and `skill_validate`.

To make a skill available for `sync`, import it with a canonical store path so it is recorded in `cobweb.lock.yaml`:

```bash
cobweb import ./skills/my-skill --write --canonical ~/.local/share/cobweb/skills
cobweb sync --target agents,cursor --write
```

The internal `@cobweb/*` packages remain separate so the core, daemon, CLI, and MCP boundaries stay explicit.
