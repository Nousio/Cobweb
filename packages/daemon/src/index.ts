#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
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

export interface EnsureDaemonRunningResult {
  started: boolean;
  alreadyRunning: boolean;
  pid?: number;
}

export interface EnsureDaemonRunningOptions {
  attempts?: number;
  intervalMs?: number;
}

export async function ensureDaemonRunning(options: EnsureDaemonRunningOptions = {}): Promise<EnsureDaemonRunningResult> {
  try {
    await callDaemon("status", undefined);
    return { started: false, alreadyRunning: true };
  } catch {
    // Continue below and start the local runtime on demand.
  }

  const pid = spawnDaemonProcess();
  if (pid === null) {
    throw new Error("Cobweb runtime is not reachable and could not be started automatically.");
  }

  const attempts = options.attempts ?? 20;
  const intervalMs = options.intervalMs ?? 100;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      await callDaemon("status", undefined);
      return { started: true, alreadyRunning: false, pid };
    } catch {
      // Keep waiting for the daemon socket to become ready.
    }
  }

  throw new Error("Cobweb runtime start timed out before it became ready.");
}

export function resolveDaemonEntrypoint(): string | null {
  if (process.env.COBWEBD_BIN) {
    return process.env.COBWEBD_BIN;
  }

  const entrypoint = fileURLToPath(import.meta.url);
  return entrypoint.endsWith(".js") && existsSync(entrypoint) ? entrypoint : null;
}

export function spawnDaemonProcess(): number | null {
  const entrypoint = resolveDaemonEntrypoint();
  if (!entrypoint) {
    return null;
  }

  const child = spawn(process.execPath, [entrypoint], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? null;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runDaemonCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
