#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runMcpServer } from "./server/mcp-server.js";
import { runStdioShim } from "./shim/stdio.js";

export * from "./server/mcp-server.js";
export * from "./shim/stdio.js";

export async function runMcpCli(argv = process.argv): Promise<void> {
  const runner = argv.includes("--shim") ? runStdioShim : runMcpServer;
  await runner();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runMcpCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
