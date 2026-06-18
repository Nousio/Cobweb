import type { RoutingWorkItem, SkillSearchCandidate, SkillSearchResult } from "@cobweb/core";
import {
  applyProjectionPlan,
  applyVendorPlan,
  buildSkillGraph,
  builtinProviders,
  canonicalSkillFromRecord,
  checkPolicyAlignment,
  CobwebError,
  createVendorPlan,
  evaluateRoutingGuidance,
  importCanonicalSkill,
  lintSkillDirectory,
  parseSkillDirectory,
  readCobwebLockfile,
  scanSkills,
  skillChain,
  toErrorMessage,
  updateSkillPolicy,
} from "@cobweb/core";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AppState } from "../app-state/app-state.js";
import {
  ensureIndexedRoot,
  indexStatusSnapshot,
  initializeIndexCoordinator,
  markRootDegraded,
  markRootFresh,
  overallFreshness,
  rootFreshness,
} from "../indexing/index-coordinator.js";
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
  await initializeIndexCoordinator(state);
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
  for (const timer of state.indexTimers.values()) {
    clearTimeout(timer.timer);
  }
  state.indexTimers.clear();
  await Promise.all(Array.from(state.watchers.values()).map((watcher) => watcher.close()));
  state.watchers.clear();
  // Truncate the WAL before closing so a crash cannot strand uncheckpointed pages;
  // never block socket cleanup on a checkpoint failure.
  try {
    state.db.checkpointWal();
  } catch {
    // ignore: best-effort durability step during shutdown
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
        freshness: overallFreshness(state),
        writer: state.writer.snapshot(),
        lastError: state.lastError,
        index: indexStatusSnapshot(state),
      };
    case "scan": {
      const params = expectParams<{ path: string }>(request.params);
      // scan is read-only discovery; it must not start a recursive watcher on the
      // query path, which can stall the daemon on large workspaces. Warm-up happens
      // through skill_search/skill_graph, which index and watch only SKILL.md files.
      return scanSkills(params.path);
    }
    case "importSkill": {
      const params = expectParams<{ path: string; canonicalDir?: string }>(request.params);
      return state.writer.enqueue("ImportSkill", async () => {
        const sourcePath = resolve(params.path);
        const importPath = params.canonicalDir
          ? (await importCanonicalSkill(sourcePath, {
            canonicalDir: resolve(params.canonicalDir),
            lockfilePath: state.paths.lockPath,
          })).canonicalPath
          : sourcePath;
        const parsed = await parseSkillDirectory(importPath);
        const duplicates = state.db.findDuplicateCandidates(parsed);
        const record = state.db.upsertSkill(parsed);
        markRootFresh(state, importPath, "imported_skill");
        return { ...record, duplicates };
      });
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
        // rebuildFromLockfile prunes every skill outside the lockfile, so any ad-hoc root
        // indexed in this session must be re-indexed on its next search.
        state.indexedRoots.clear();
        for (const root of state.watchRoots) {
          markRootDegraded(state, root, "lockfile_rebuild_requires_reconcile");
        }
        state.freshness = overallFreshness(state);
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
          Array.from(new Set(plans.map((plan) => plan.sourcePath))).map((sourcePath) => parseSkillDirectory(sourcePath)),
        );
        state.db.bulkUpsertSkills(skills);

        for (const plan of plans) {
          const result = await applyProjectionPlan(plan);
          state.db.recordProjectionInstall(plan.sourcePath, result);
          results.push(result);
        }
        for (const skill of skills) {
          markRootFresh(state, skill.rootPath, "sync_upserted_skill");
        }
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
        markRootDegraded(state, resolve(params.path), "policy_updated");
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
    case "skill_search": {
      const params = expectParams<{ path: string; query: string; limit?: number }>(request.params);
      const root = resolve(params.path);
      const warnings = await ensureIndexedRoot(state, root);
      const candidates = state.db.searchSkills(params.query, { limit: params.limit, root });
      return {
        query: params.query,
        freshness: rootFreshness(state, root),
        candidates,
        warnings,
      };
    }
    case "skill_graph": {
      const params = expectParams<{ path: string; maxDepth?: number; maxPaths?: number; includeExternal?: boolean; watch?: boolean }>(request.params);
      const root = resolve(params.path);
      // Graph is a read-only topology snapshot; only warm the root when the caller
      // explicitly wants it ready for later skill_search. Warming indexes the root and
      // watches its SKILL.md files instead of recursively watching the whole tree.
      if (params.watch) {
        await ensureIndexedRoot(state, root);
      }
      return buildSkillGraph(root, {
        maxDepth: params.maxDepth,
        maxPaths: params.maxPaths,
        includeExternal: params.includeExternal,
      });
    }
    case "skill_chain": {
      const params = expectParams<{ path: string; target: string; maxDepth?: number; maxPaths?: number; includeExternal?: boolean; watch?: boolean }>(
        request.params,
      );
      const root = resolve(params.path);
      if (params.watch) {
        await ensureIndexedRoot(state, root);
      }
      const graph = await buildSkillGraph(root, {
        maxDepth: params.maxDepth,
        maxPaths: params.maxPaths,
        includeExternal: params.includeExternal,
      });
      return skillChain(graph, params.target);
    }
    case "skill_select": {
      const params = expectParams<{ path: string; query: string; limit?: number; workItem?: RoutingWorkItem }>(request.params);
      const result = await dispatch(state, {
        ...request,
        method: "skill_search",
        params: { ...params, limit: params.limit ?? 5 },
      });
      const search = result as SkillSearchResult;
      const selected = search.candidates[0] ?? null;
      const root = resolve(params.path);
      const chain = selected ? skillChain(await buildSkillGraph(root, { maxDepth: 16, maxPaths: 200 }), selected.path) : null;
      const guidance = evaluateRoutingGuidance(params.query, search.candidates, params.workItem, {
        inspectionFallbackPaths: [root],
      });
      return {
        query: params.query,
        freshness: search.freshness,
        selected,
        chain,
        recommendation: selected
          ? {
            reason: selectionReason(selected),
            confidence: selected.score,
          }
          : {
            reason: "No indexed skill matched the query.",
            confidence: 0,
          },
        rejected: search.candidates
          .filter((candidate) => candidate.path !== selected?.path)
          .map((candidate) => ({
            path: candidate.path,
            name: candidate.name,
            reason: "Lower ranked match.",
          })),
        ...(guidance ? { guidance } : {}),
      };
    }
    case "skill_context": {
      const params = expectParams<{ path: string }>(request.params);
      const skillPath = resolve(params.path);
      const parsed = await parseSkillDirectory(skillPath);
      const policy = await checkPolicyAlignment(skillPath);
      return {
        path: parsed.rootPath,
        name: parsed.name,
        description: parsed.description,
        summary: parsed.methodSummaries[0]?.summary ?? parsed.description,
        methods: parsed.methodSummaries,
        resources: parsed.resources,
        policy: { ...parsed.policy, check: policy },
        lint: await lintSkillDirectory(skillPath),
      };
    }
    case "skill_validate": {
      const params = expectParams<{ path: string }>(request.params);
      const skillPath = resolve(params.path);
      const parsed = await parseSkillDirectory(skillPath);
      await ensureIndexedRoot(state, dirname(skillPath));
      const lint = await lintSkillDirectory(skillPath);
      const policy = await checkPolicyAlignment(skillPath);
      return {
        valid: lint.valid && policy.ok,
        lint,
        policy,
        duplicates: state.db.findDuplicateCandidates(parsed, { root: dirname(skillPath) }),
      };
    }
    case "doctor":
      const checks = [
        { name: "ipc", ok: true, message: state.paths.socketPath },
        { name: "writer_queue", ok: state.writer.snapshot().running === null },
        { name: "db_path", ok: true, message: state.paths.dbPath },
        ...state.db.schemaHealthChecks(),
      ];
      return {
        ok: checks.every((check) => check.ok),
        checks,
      };
    case "stop":
      return { stopping: true };
    default:
      throw new CobwebError("UNKNOWN_METHOD", `Unknown daemon method: ${request.method}`);
  }
}

function selectionReason(selected: SkillSearchCandidate): string {
  const strongest = [...selected.scoreBreakdown]
    .sort((left, right) => right.contribution - left.contribution)
    .filter((item) => item.contribution > 0)
    .slice(0, 3)
    .map((item) => item.signal.replace(/_/g, " "));
  if (strongest.length === 0) {
    return `Selected ${selected.name} as the highest ranked indexed skill.`;
  }
  return `Selected ${selected.name} because it matched ${strongest.join(", ")}.`;
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
    if (
      !state.stopping &&
      idleFor >= state.idleTimeoutMs &&
      writer.pending === 0 &&
      writer.running === null &&
      state.indexTimers.size === 0
    ) {
      void stopServer(state, server, markStopping);
    }
  }, Math.min(Math.max(state.idleTimeoutMs, 1000), 60_000));
  timer.unref();
  return timer;
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
