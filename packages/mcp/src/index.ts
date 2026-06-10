#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runStdioShim } from "./shim/stdio.js";

export * from "./shim/stdio.js";

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runStdioShim().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
