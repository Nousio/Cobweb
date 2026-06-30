#!/usr/bin/env node
import { runDaemonCli } from "@skillroute/daemon";

runDaemonCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
