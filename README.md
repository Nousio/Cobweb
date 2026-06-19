# openCobweb

English | [简体中文](./README.zh-CN.md)

<sub>License: [AGPL-3.0-only](./LICENSE).</sub>

openCobweb is an MCP server for working with local Agent Skills from MCP-compatible clients.

## Use with npx

Add openCobweb to your MCP client configuration:

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

## Global Installation

If your MCP client does not run packages through `npx`, install openCobweb first:

```bash
npm install -g opencobweb
```

Then configure your MCP client to run the installed command:

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

## Runtime Lifecycle

`cobweb-mcp` acts as a stdio MCP client shim for the local `cobwebd` runtime. When the MCP server starts, it connects to or starts the single local daemon, opens a runtime lease, and keeps that lease alive while the MCP session is connected. The daemon does not idle-stop while a lease, request, writer task, or index task is active; after the MCP session disconnects and the lease is released or expires, the daemon returns to its normal idle shutdown policy.

## Requirements

openCobweb requires Node.js `>=22`.

After updating the MCP configuration, restart your MCP client.
