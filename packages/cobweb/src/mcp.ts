#!/usr/bin/env node
import { runMcpCli } from "@cobweb/mcp";

runMcpCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
