import { defaultRuntimePaths, type IndexFreshness, type RuntimePaths, WriterQueue } from "@cobweb/core";
import { CobwebDatabase } from "@cobweb/core/db";
import type { FSWatcher } from "chokidar";

export type WatcherState = "starting" | "ready" | "unavailable";
export type IndexCheckKind = "fast_path" | "signature_check" | "full_reconcile";

export interface RootStatSignature {
  size: number;
  mtimeMs: number;
}

export interface RootManifest {
  skillRoots: string[];
  signatures: Record<string, RootStatSignature>;
  lastFullReconcileAt: string;
}

export interface IndexRootRuntimeState {
  root: string;
  state: IndexFreshness;
  reason: string;
  lastIndexedAt: string | null;
  lastIndexError: string | null;
  lastCheckedAt: string | null;
  lastVerifiedAt: string | null;
  lastFullReconcileAt: string | null;
  lastEventAt: string | null;
  lastCheckKind: IndexCheckKind | null;
  pending: boolean;
  watching: boolean;
  watcherState: WatcherState;
  dirty: boolean;
}

export interface IndexTimerEntry {
  timer: NodeJS.Timeout;
  firstScheduledAt: number;
}

export interface RecentIndexTask {
  root: string;
  state: IndexFreshness;
  reason: string;
  at: string;
}

export interface IndexInFlightEntry {
  promise: Promise<string[]>;
  rerunRequested: boolean;
  rerunReason: string;
}

export interface AppState {
  paths: RuntimePaths;
  db: CobwebDatabase;
  writer: WriterQueue;
  freshness: "fresh" | "rebuilding" | "degraded";
  lastError: string | null;
  lastRequestAt: number;
  idleTimeoutMs: number;
  maxStalenessMs: number;
  watchers: Map<string, FSWatcher>;
  watchRoots: Set<string>;
  indexedRoots: Set<string>;
  indexTimers: Map<string, IndexTimerEntry>;
  indexRoots: Map<string, IndexRootRuntimeState>;
  rootManifests: Map<string, RootManifest>;
  indexInFlight: Map<string, IndexInFlightEntry>;
  recentIndexTasks: RecentIndexTask[];
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
    maxStalenessMs: readPositiveIntegerEnv("COBWEB_MAX_STALENESS_MS", 2_000),
    watchers: new Map(),
    watchRoots: new Set(),
    indexedRoots: new Set(),
    indexTimers: new Map(),
    indexRoots: new Map(),
    rootManifests: new Map(),
    indexInFlight: new Map(),
    recentIndexTasks: [],
    stopping: false,
  };
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
