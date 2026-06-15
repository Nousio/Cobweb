import type {
  DbSkillStatus,
  ImportedSkillRecord,
  IndexFreshness,
  PolicyCheckResult,
  ProjectionPlan,
  ProjectionResult,
  ScanResult,
  SkillContextResult,
  SkillGraphResult,
  SkillSearchResult,
  SkillSelectResult,
  SkillValidateResult,
  VendorPlan,
  WriterQueueSnapshot,
} from "@cobweb/core";
import type { IndexCheckKind, WatcherState } from "../app-state/app-state.js";

export interface JsonRpcRequest<TParams = unknown> {
  id: string;
  method: string;
  params?: TParams;
}

export type JsonRpcResponse<TResult = unknown> =
  | {
    id: string;
    ok: true;
    result: TResult;
  }
  | {
    id: string;
    ok: false;
    error: {
      code: string;
      message: string;
      retryable: boolean;
    };
  };

export interface DaemonStatus {
  running: true;
  pid: number;
  socketPath: string;
  dbPath: string;
  db: DbSkillStatus;
  freshness: IndexFreshness;
  writer: WriterQueueSnapshot;
  lastError: string | null;
  index: DaemonIndexStatus;
}

export interface DaemonIndexRootStatus {
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
  fastPathEligible: boolean;
  inFlight: boolean;
  stalenessBudgetMs: number;
}

export interface DaemonIndexRecentTask {
  root: string;
  state: IndexFreshness;
  reason: string;
  at: string;
}

export interface DaemonIndexStatus {
  roots: DaemonIndexRootStatus[];
  watchRoots: string[];
  indexedRoots: string[];
  pendingRoots: string[];
  recent: DaemonIndexRecentTask[];
}

export interface DaemonMethods {
  status: {
    params: undefined;
    result: DaemonStatus;
  };
  scan: {
    params: { path: string };
    result: ScanResult;
  };
  importSkill: {
    params: { path: string; canonicalDir?: string };
    result: ImportedSkillRecord;
  };
  checkpointWal: {
    params: undefined;
    result: { checkpoint: string };
  };
  rebuildFromLockfile: {
    params: { lockfilePath?: string; chunkSize?: number };
    result: ImportedSkillRecord[];
  };
  sync: {
    params: { projectRoot: string; target?: string[]; strategy?: "link" | "copy"; dryRun?: boolean };
    result: { plans: ProjectionPlan[]; results: ProjectionResult[] };
  };
  policyCheck: {
    params: { path?: string };
    result: PolicyCheckResult;
  };
  updatePolicy: {
    params: { path: string; implicitInvocation?: boolean; selfContained?: boolean };
    result: { ok: true };
  };
  vendor: {
    params: { path: string; dryRun?: boolean };
    result: VendorPlan;
  };
  skill_search: {
    params: { path: string; query: string; limit?: number };
    result: SkillSearchResult;
  };
  skill_graph: {
    params: { path: string; maxDepth?: number; includeExternal?: boolean };
    result: SkillGraphResult;
  };
  skill_select: {
    params: { path: string; query: string; limit?: number };
    result: SkillSelectResult;
  };
  skill_context: {
    params: { path: string };
    result: SkillContextResult;
  };
  skill_validate: {
    params: { path: string };
    result: SkillValidateResult;
  };
  doctor: {
    params: undefined;
    result: { ok: boolean; checks: Array<{ name: string; ok: boolean; message?: string }> };
  };
  stop: {
    params: undefined;
    result: { stopping: true };
  };
}
