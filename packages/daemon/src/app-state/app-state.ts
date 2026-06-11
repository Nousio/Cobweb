import { defaultRuntimePaths, type RuntimePaths, WriterQueue } from "@cobweb/core";
import { CobwebDatabase } from "@cobweb/core/db";
import type { FSWatcher } from "node:fs";

export interface AppState {
  paths: RuntimePaths;
  db: CobwebDatabase;
  writer: WriterQueue;
  freshness: "fresh" | "rebuilding" | "degraded";
  lastError: string | null;
  lastRequestAt: number;
  idleTimeoutMs: number;
  watchers: FSWatcher[];
  watchRoots: Set<string>;
  stopping: boolean;
}

export function createAppState(paths = defaultRuntimePaths(), options: { idleTimeoutMs?: number } = {}): AppState {
  return {
    paths,
    db: new CobwebDatabase(paths.dbPath),
    writer: new WriterQueue(),
    freshness: "fresh",
    lastError: null,
    lastRequestAt: Date.now(),
    idleTimeoutMs: options.idleTimeoutMs ?? Number(process.env.COBWEB_IDLE_TIMEOUT_MS ?? 10 * 60 * 1000),
    watchers: [],
    watchRoots: new Set(),
    stopping: false,
  };
}
