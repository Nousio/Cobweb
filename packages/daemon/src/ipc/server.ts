import {
  applyProjectionPlan,
  applyVendorPlan,
  auditParsedSkill,
  builtinProviders,
  canonicalSkillFromRecord,
  checkPolicyAlignment,
  CobwebError,
  createMergePlan,
  createVendorPlan,
  dedupSkills,
  importCanonicalSkill,
  lintSkillDirectory,
  parseSkillDirectory,
  readCobwebLockfile,
  scanSkills,
  toErrorMessage,
  updateSkillPolicy,
} from "@cobweb/core";
import { watch } from "node:fs";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import type { AppState } from "../app-state/app-state.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./protocol.js";

export interface DaemonServer {
  close(): Promise<void>;
}

export async function startIpcServer(state: AppState): Promise<DaemonServer> {
  await mkdir(dirname(state.paths.socketPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(state.paths.socketPath), 0o700);
  if (await pathExists(state.paths.socketPath)) {
    if (await isSocketAlive(state.paths.socketPath)) {
      throw new CobwebError("DAEMON_ALREADY_RUNNING", `cobwebd is already listening on ${state.paths.socketPath}`);
    }
    await rm(state.paths.socketPath, { force: true });
  }
  await acquireDaemonLock(state);

  let stopping = false;
  let idleTimer: NodeJS.Timeout | null = null;
  const server = net.createServer((socket) => {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      for (; ;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          break;
        }

        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);

        void handleLine(state, line).then((response) => {
          socket.write(`${JSON.stringify(response)}\n`);
          if (response.ok && response.result && typeof response.result === "object" && "stopping" in response.result) {
            void stopServer(state, server, () => {
              stopping = true;
            });
          }
        });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(state.paths.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(state.paths.socketPath, 0o600);
  idleTimer = startIdleTimer(state, server, () => {
    stopping = true;
  });

  return {
    async close() {
      if (idleTimer) {
        clearInterval(idleTimer);
      }
      if (!stopping) {
        await stopServer(state, server, () => {
          stopping = true;
        });
      }
    },
  };
}

async function stopServer(state: AppState, server: net.Server, markStopping: () => void): Promise<void> {
  if (state.stopping) {
    return;
  }
  state.stopping = true;
  markStopping();
  await state.writer.waitForIdle();
  for (const watcher of state.watchers.splice(0)) {
    watcher.close();
  }
  state.db.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(state.paths.socketPath, { force: true });
  await rm(daemonLockPath(state), { force: true });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    const done = (alive: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive);
    };

    socket.setTimeout(250);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function handleLine(state: AppState, line: string): Promise<JsonRpcResponse> {
  state.lastRequestAt = Date.now();
  let request: JsonRpcRequest;

  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch (error) {
    return failure("unknown", new CobwebError("BAD_JSON", "Invalid JSON-RPC request.", { cause: error }));
  }

  try {
    const result = await dispatch(state, request);
    return { id: request.id, ok: true, result };
  } catch (error) {
    state.lastError = toErrorMessage(error);
    return failure(request.id, error);
  }
}

async function dispatch(state: AppState, request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case "status":
      return {
        running: true,
        pid: process.pid,
        socketPath: state.paths.socketPath,
        dbPath: state.paths.dbPath,
        db: state.db.skillStatus(),
        freshness: state.freshness,
        writer: state.writer.snapshot(),
        lastError: state.lastError,
      };
    case "scan": {
      const params = expectParams<{ path: string }>(request.params);
      rememberWatchRoot(state, params.path);
      return scanSkills(params.path);
    }
    case "audit": {
      const params = expectParams<{ path: string }>(request.params);
      return auditParsedSkill(await parseSkillDirectory(params.path));
    }
    case "dedup": {
      const params = expectParams<{ path: string; threshold?: number }>(request.params);
      const scan = await scanSkills(params.path);
      const parsed = await Promise.all(scan.candidates.map((candidate) => parseSkillDirectory(candidate.path)));
      return dedupSkills(parsed, { threshold: params.threshold });
    }
    case "importSkill": {
      const params = expectParams<{ path: string; canonicalDir?: string }>(request.params);
      return state.writer.enqueue("ImportSkill", async () => {
        const importPath = params.canonicalDir
          ? (await importCanonicalSkill(params.path, {
            canonicalDir: params.canonicalDir,
            lockfilePath: state.paths.lockPath,
          })).canonicalPath
          : params.path;
        const parsed = await parseSkillDirectory(importPath);
        const audit = auditParsedSkill(parsed);
        state.freshness = "fresh";
        return state.db.upsertSkill(parsed, audit);
      });
    }
    case "importMany": {
      const params = expectParams<{ paths: string[]; chunkSize?: number }>(request.params);
      return state.writer.enqueue("ImportMany", async () => {
        const records = await Promise.all(
          params.paths.map(async (path) => {
            const skill = await parseSkillDirectory(path);
            return { skill, audit: auditParsedSkill(skill) };
          }),
        );
        state.freshness = "fresh";
        return state.db.bulkUpsertSkills(records, { chunkSize: params.chunkSize });
      });
    }
    case "lint": {
      const params = expectParams<{ path: string }>(request.params);
      return lintSkillDirectory(params.path);
    }
    case "checkpointWal":
      return state.writer.enqueue("CheckpointWal", async () => ({ checkpoint: state.db.checkpointWal() }));
    case "rebuildFromLockfile": {
      const params = (request.params ?? {}) as { lockfilePath?: string; chunkSize?: number };
      return state.writer.enqueue("RebuildFromLockfile", async () => {
        state.freshness = "rebuilding";
        const result = await state.db.rebuildFromLockfile(params.lockfilePath ?? state.paths.lockPath, {
          chunkSize: params.chunkSize,
        });
        state.freshness = "fresh";
        return result;
      });
    }
    case "sync": {
      const params = expectParams<{ projectRoot: string; target?: string[]; strategy?: "link" | "copy"; dryRun?: boolean }>(
        request.params,
      );
      if (!isAbsolute(params.projectRoot)) {
        throw new CobwebError("BAD_PARAMS", "sync projectRoot must be an absolute path.");
      }
      const lockfile = await readCobwebLockfile(state.paths.lockPath);
      const providers = builtinProviders().filter((provider) => !params.target || params.target.includes(provider.name));
      const plans = lockfile.skills.flatMap((record) =>
        providers.map((provider) =>
          provider.project(canonicalSkillFromRecord(record), {
            providerName: provider.name,
            projectRoot: params.projectRoot,
            strategy: params.strategy ?? "link",
          }),
        ),
      );

      if (params.dryRun ?? true) {
        return { plans, results: [] };
      }

      return state.writer.enqueue("SyncProjection", async () => {
        const results = [];
        const skills = await Promise.all(
          Array.from(new Set(plans.map((plan) => plan.sourcePath))).map(async (sourcePath) => {
            const skill = await parseSkillDirectory(sourcePath);
            return { skill, audit: auditParsedSkill(skill) };
          }),
        );
        state.db.bulkUpsertSkills(skills);

        for (const plan of plans) {
          const result = await applyProjectionPlan(plan);
          state.db.recordProjectionInstall(plan.sourcePath, result);
          results.push(result);
        }
        state.freshness = "fresh";
        return { plans, results };
      });
    }
    case "policyCheck": {
      const params = (request.params ?? {}) as { path?: string };
      if (params.path) {
        return checkPolicyAlignment(params.path);
      }
      const lockfile = await readCobwebLockfile(state.paths.lockPath);
      const results = await Promise.all(lockfile.skills.map((record) => checkPolicyAlignment(record.canonicalPath)));
      return {
        ok: results.every((result) => result.ok),
        findings: results.flatMap((result) => result.findings),
      };
    }
    case "updatePolicy": {
      const params = expectParams<{ path: string; implicitInvocation?: boolean; selfContained?: boolean }>(request.params);
      return state.writer.enqueue("UpdatePolicy", async () => {
        await updateSkillPolicy(params.path, {
          implicitInvocation: params.implicitInvocation,
          selfContained: params.selfContained,
        });
        state.freshness = "degraded";
        return { ok: true };
      });
    }
    case "vendor": {
      const params = expectParams<{ path: string; dryRun?: boolean }>(request.params);
      const plan = await createVendorPlan(params.path, params.dryRun ?? true);
      if (plan.dryRun) {
        return plan;
      }
      return state.writer.enqueue("VendorResource", async () => applyVendorPlan(plan));
    }
    case "merge": {
      const params = expectParams<{ sourcePath: string; targetPath: string }>(request.params);
      return createMergePlan(params.sourcePath, params.targetPath);
    }
    case "skill_search": {
      const params = expectParams<{ path: string; query: string }>(request.params);
      const result = await scanSkills(params.path);
      const query = params.query.toLowerCase();
      return {
        ...result,
        candidates: result.candidates.filter((candidate) =>
          `${candidate.name} ${candidate.description}`.toLowerCase().includes(query),
        ),
      };
    }
    case "skill_select": {
      const result = (await dispatch(state, { ...request, method: "skill_search" })) as Awaited<ReturnType<typeof scanSkills>>;
      return result.candidates[0] ?? null;
    }
    case "skill_context": {
      const params = expectParams<{ path: string }>(request.params);
      const parsed = await parseSkillDirectory(params.path);
      return { audit: auditParsedSkill(parsed), lint: await lintSkillDirectory(params.path) };
    }
    case "skill_validate": {
      const params = expectParams<{ path: string }>(request.params);
      const parsed = await parseSkillDirectory(params.path);
      return {
        audit: auditParsedSkill(parsed),
        lint: await lintSkillDirectory(params.path),
        policy: await checkPolicyAlignment(params.path),
      };
    }
    case "doctor":
      const integrity = state.db.integrityCheck();
      return {
        ok: integrity === "ok",
        checks: [
          { name: "ipc", ok: true, message: state.paths.socketPath },
          { name: "writer_queue", ok: state.writer.snapshot().running === null },
          { name: "db_path", ok: true, message: state.paths.dbPath },
          { name: "sqlite_integrity", ok: integrity === "ok", message: integrity },
        ],
      };
    case "stop":
      return { stopping: true };
    default:
      throw new CobwebError("UNKNOWN_METHOD", `Unknown daemon method: ${request.method}`);
  }
}

async function acquireDaemonLock(state: AppState): Promise<void> {
  const path = daemonLockPath(state);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);

  if (await pathExists(path)) {
    const existing = await readDaemonLock(path);
    if (existing && processAlive(existing.pid)) {
      throw new CobwebError("DAEMON_ALREADY_RUNNING", `cobwebd lock is held by pid ${existing.pid}`);
    }
    await rm(path, { force: true });
  }

  await writeFile(path, JSON.stringify({ pid: process.pid, socketPath: state.paths.socketPath, startedAt: new Date().toISOString() }), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function startIdleTimer(state: AppState, server: net.Server, markStopping: () => void): NodeJS.Timeout {
  const timer = setInterval(() => {
    const idleFor = Date.now() - state.lastRequestAt;
    const writer = state.writer.snapshot();
    if (!state.stopping && idleFor >= state.idleTimeoutMs && writer.pending === 0 && writer.running === null) {
      void stopServer(state, server, markStopping);
    }
  }, Math.min(Math.max(state.idleTimeoutMs, 1000), 60_000));
  timer.unref();
  return timer;
}

function rememberWatchRoot(state: AppState, root: string): void {
  if (state.watchRoots.has(root)) {
    return;
  }
  state.watchRoots.add(root);
  try {
    const watchOptions = process.platform === "darwin" || process.platform === "win32" ? { recursive: true } : {};
    const watcher = watch(root, watchOptions, () => {
      state.freshness = "degraded";
    });
    watcher.unref();
    state.watchers.push(watcher);
  } catch {
    state.freshness = "degraded";
  }
}

async function readDaemonLock(path: string): Promise<{ pid: number } | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? { pid: parsed.pid } : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function daemonLockPath(state: AppState): string {
  return state.paths.daemonLockPath ?? join(state.paths.dataDir, "cobwebd.lock.json");
}

function expectParams<T>(value: unknown): T {
  if (!value || typeof value !== "object") {
    throw new CobwebError("BAD_PARAMS", "Request params must be an object.");
  }
  return value as T;
}

function failure(id: string, error: unknown): JsonRpcResponse {
  if (error instanceof CobwebError) {
    return {
      id,
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    };
  }

  return {
    id,
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: toErrorMessage(error),
      retryable: false,
    },
  };
}
