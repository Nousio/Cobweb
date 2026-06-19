# openCobweb

<sub>License: AGPL-3.0-only.</sub>

openCobweb is an MCP server package for working with local Agent Skills from MCP-compatible clients.

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

`cobweb-mcp` connects to or starts one local `cobwebd` runtime, opens a runtime lease for the MCP session, and keeps the daemon alive while that lease is active. After the MCP session disconnects and the lease is released or expires, the daemon returns to its normal idle shutdown policy.

openCobweb requires Node.js `>=22`.
