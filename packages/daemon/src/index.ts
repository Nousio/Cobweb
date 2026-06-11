#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createAppState } from "./app-state/app-state.js";
import { callDaemon } from "./ipc/client.js";
import { startIpcServer } from "./ipc/server.js";

export * from "./app-state/app-state.js";
export * from "./ipc/client.js";
export * from "./ipc/protocol.js";
export * from "./ipc/server.js";

export async function runDaemon(): Promise<void> {
  const state = createAppState();
  await startIpcServer(state);
  process.stdout.write(
    JSON.stringify({
      ok: true,
      pid: process.pid,
      socketPath: state.paths.socketPath,
      dbPath: state.paths.dbPath,
    }) + "\n",
  );
}

export async function runDaemonCli(argv = process.argv): Promise<void> {
  if (argv.includes("--status")) {
    const status = await callDaemon("status", undefined);
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }

  await runDaemon();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runDaemonCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
