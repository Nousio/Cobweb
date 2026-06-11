# Cobweb

One-step installer package for Cobweb.

```bash
npm install -g cobweb
cobweb --help
cobweb-mcp
```

This package exposes the public commands and bundles the internal workspace packages:

- `cobweb` / `cw`: user-facing CLI.
- `cobwebd`: local daemon.
- `cobweb-mcp`: MCP stdio server.

The internal `@cobweb/*` packages remain separate so the core, daemon, CLI, and MCP boundaries stay explicit.
