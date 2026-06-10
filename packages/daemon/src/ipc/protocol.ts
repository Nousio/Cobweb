import type { AuditResult, DbSkillStatus, DedupResult, ImportedSkillRecord, ScanResult, WriterQueueSnapshot } from "@cobweb/core";

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
    params: { path: string };
    result: ImportedSkillRecord;
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
