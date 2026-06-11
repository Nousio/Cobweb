import type {
  AuditResult,
  DbSkillStatus,
  DedupResult,
  ImportedSkillRecord,
  LintResult,
  MergePlan,
  PolicyCheckResult,
  ProjectionPlan,
  ProjectionResult,
  ScanResult,
  VendorPlan,
  WriterQueueSnapshot,
} from "@cobweb/core";

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
  freshness: "fresh" | "rebuilding" | "degraded";
  writer: WriterQueueSnapshot;
  lastError: string | null;
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
  audit: {
    params: { path: string };
    result: AuditResult;
  };
  dedup: {
    params: { path: string; threshold?: number };
    result: DedupResult;
  };
  importSkill: {
    params: { path: string; canonicalDir?: string };
    result: ImportedSkillRecord;
  };
  importMany: {
    params: { paths: string[]; chunkSize?: number };
    result: ImportedSkillRecord[];
  };
  lint: {
    params: { path: string };
    result: LintResult;
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
  merge: {
    params: { sourcePath: string; targetPath: string };
    result: MergePlan;
  };
  skill_search: {
    params: { path: string; query: string };
    result: ScanResult;
  };
  skill_select: {
    params: { path: string; query: string };
    result: ScanResult["candidates"][number] | null;
  };
  skill_context: {
    params: { path: string };
    result: { audit: AuditResult; lint: LintResult };
  };
  skill_validate: {
    params: { path: string };
    result: { audit: AuditResult; lint: LintResult; policy: PolicyCheckResult };
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
