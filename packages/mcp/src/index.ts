#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runMcpServer } from "./server/mcp-server.js";

export * from "./server/mcp-server.js";

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runMcpServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
