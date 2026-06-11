import type {
  AuditResult,
  DbSkillStatus,
  ImportedSkillRecord,
  PolicyCheckResult,
  ProjectionPlan,
  ProjectionResult,
  ScanResult,
  SkillContextResult,
  SkillSearchResult,
  SkillSelectResult,
  SkillValidateResult,
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
