import { defaultRuntimePaths, type RuntimePaths, WriterQueue } from "@cobweb/core";
import { CobwebDatabase } from "@cobweb/core/db";

export interface AppState {
  paths: RuntimePaths;
  db: CobwebDatabase;
  writer: WriterQueue;
  freshness: "fresh" | "rebuilding" | "degraded";
  lastError: string | null;
}

export function createAppState(paths = defaultRuntimePaths()): AppState {
  return {
    paths,
    db: new CobwebDatabase(paths.dbPath),
    writer: new WriterQueue(),
    freshness: "fresh",
    lastError: null,
  };
}
