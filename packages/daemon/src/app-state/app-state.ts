import { defaultRuntimePaths, type IndexFreshness, type RuntimePaths, WriterQueue } from "@skillroute/core";
import { SkillRouteDatabase } from "@skillroute/core/db";
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

export interface RuntimeLease {
  id: string;
  client: string;
  pid: number | null;
  transport: string;
  attachedAt: string;
  lastHeartbeatAt: string;
  expiresAt: number;
  socketBound: boolean;
}

export interface AppState {
  paths: RuntimePaths;
  db: SkillRouteDatabase;
  writer: WriterQueue;
  freshness: "fresh" | "rebuilding" | "degraded";
  lastError: string | null;
  lastRequestAt: number;
  lastActivityAt: number;
  idleTimeoutMs: number;
  idleGraceMs: number;
  leaseTtlMs: number;
  activeRequests: number;
  lastShutdownReason: string | null;
  maxStalenessMs: number;
  leases: Map<string, RuntimeLease>;
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

export function createAppState(
  paths = defaultRuntimePaths(),
  options: { idleTimeoutMs?: number; idleGraceMs?: number; leaseTtlMs?: number } = {},
): AppState {
  const now = Date.now();
  return {
    paths,
    db: new SkillRouteDatabase(paths.dbPath),
    writer: new WriterQueue(),
    freshness: "fresh",
    lastError: null,
    lastRequestAt: now,
    lastActivityAt: now,
    idleTimeoutMs: options.idleTimeoutMs ?? Number(process.env.SKILLROUTE_IDLE_TIMEOUT_MS ?? 10 * 60 * 1000),
    idleGraceMs: options.idleGraceMs ?? readPositiveIntegerEnv("SKILLROUTE_IDLE_GRACE_MS", 30_000),
    leaseTtlMs: options.leaseTtlMs ?? readPositiveIntegerEnv("SKILLROUTE_LEASE_TTL_MS", 30_000),
    activeRequests: 0,
    lastShutdownReason: null,
    maxStalenessMs: readPositiveIntegerEnv("SKILLROUTE_MAX_STALENESS_MS", 2_000),
    leases: new Map(),
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
