import { importCanonicalSkill } from "@cobweb/core";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppState } from "../../../packages/daemon/src/app-state/app-state.js";
import { callDaemon, openDaemonLease } from "../../../packages/daemon/src/ipc/client.js";
import { type DaemonServer, startIpcServer } from "../../../packages/daemon/src/ipc/server.js";

function sendRaw(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) {
        socket.end();
        resolve(buffer.slice(0, buffer.indexOf("\n")));
      }
    });
    socket.once("error", reject);
  });
}

async function waitForRootStatus(
  socketPath: string,
  rootPath: string,
  predicate: (root: Awaited<ReturnType<typeof callDaemon<"status">>>["index"]["roots"][number]) => boolean,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = await callDaemon("status", undefined, socketPath);
    const root = status.index.roots.find((entry) => entry.root === rootPath);
    if (root && predicate(root)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for root status: ${rootPath}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let dir: string;
let socketPath: string;
let skillRoot: string;
let server: DaemonServer;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cobweb-daemon-"));
  socketPath = join(dir, "cobwebd.sock");

  skillRoot = join(dir, "skills", "review");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: review\ndescription: Review skill\n---\n\n# Review\n\nSafe body.\n",
  );

  const state = createAppState({
    dataDir: dir,
    dbPath: join(dir, "cobweb.db"),
    socketPath,
    lockPath: join(dir, "lock.yaml"),
  });
  server = await startIpcServer(state);
});

afterAll(async () => {
  await server.close();
});

describe("daemon IPC", () => {
  it("returns running status with db stats", async () => {
    const status = await callDaemon("status", undefined, socketPath);
    expect(status.running).toBe(true);
    expect(status.socketPath).toBe(socketPath);
    expect(status.db.total).toBe(0);
  });

  it("scans through the daemon", async () => {
    const result = await callDaemon("scan", { path: skillRoot }, socketPath);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.name).toBe("review");
  });

  it("builds a SkillGraph through the daemon", async () => {
    const graphRoot = await mkdtemp(join(tmpdir(), "cobweb-daemon-graph-"));
    const graphSkill = join(graphRoot, "workflow");
    await mkdir(graphSkill, { recursive: true });
    await writeFile(join(graphSkill, "SKILL.md"), "---\nname: workflow\ndescription: Workflow\n---\n\n# Workflow\n\nUse [missing](../missing.md).\n");

    const result = await callDaemon("skill_graph", { path: graphRoot, includeExternal: false }, socketPath);

    expect(result.nodes.some((node) => node.kind === "scan_root")).toBe(true);
    expect(result.nodes.some((node) => node.kind === "skill" && node.name === "workflow")).toBe(true);
    expect(result.edges.some((edge) => edge.kind === "references" && edge.unresolved)).toBe(true);
    expect(result.edges.some((edge) => edge.kind === "contains" && edge.toRelativePath === "workflow")).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("referenced path does not exist"))).toBe(true);

    const status = await callDaemon("status", undefined, socketPath);
    expect(status.index.roots.some((entry) => entry.root === resolve(graphRoot))).toBe(false);
  });

  it("returns a SkillGraph chain through the daemon", async () => {
    const graphRoot = await mkdtemp(join(tmpdir(), "cobweb-daemon-chain-"));
    const parentSkill = join(graphRoot, "parent");
    const childSkill = join(graphRoot, "child");
    await mkdir(parentSkill, { recursive: true });
    await mkdir(childSkill, { recursive: true });
    await writeFile(join(parentSkill, "SKILL.md"), "---\nname: parent\ndescription: Parent\n---\n\n# Parent\n\nUse [child](../child/SKILL.md).\n");
    await writeFile(join(childSkill, "SKILL.md"), "---\nname: child\ndescription: Child\n---\n\n# Child\n\nBody.\n");

    const result = await callDaemon("skill_chain", { path: graphRoot, target: "parent" }, socketPath);

    expect(result?.target.name).toBe("parent");
    expect(result?.references.some((item) => item.node.relativePath === "child")).toBe(true);
    expect(result?.containmentPath.map((node) => node.relativePath)).toEqual([".", "parent"]);
  });

  it("warms the root and watches its SKILL.md files for skill_graph only when watch is requested", async () => {
    const watchRoot = await mkdtemp(join(tmpdir(), "cobweb-daemon-graph-watch-"));
    const watchSkill = join(watchRoot, "workflow");
    await mkdir(watchSkill, { recursive: true });
    await writeFile(join(watchSkill, "SKILL.md"), "---\nname: workflow\ndescription: Workflow\n---\n\n# Workflow\n\nBody.\n");

    const watchSocket = join(watchRoot, "cobwebd.sock");
    const watchState = createAppState({
      dataDir: watchRoot,
      dbPath: join(watchRoot, "cobweb.db"),
      socketPath: watchSocket,
      lockPath: join(watchRoot, "lock.yaml"),
    });
    const watchServer = await startIpcServer(watchState);

    try {
      await callDaemon("skill_graph", { path: watchRoot, watch: true }, watchSocket);
      await waitForRootStatus(watchSocket, resolve(watchRoot), (root) => root.watching);

      const status = await callDaemon("status", undefined, watchSocket);
      expect(status.index.roots.find((entry) => entry.root === resolve(watchRoot))?.watching).toBe(true);
      const watchedPaths = Object.keys(watchState.watchers.get(resolve(watchRoot))?.getWatched() ?? {});
      expect(watchedPaths).toContain(resolve(watchSkill));
    } finally {
      await watchServer.close();
    }
  });

  it("imports a skill via the Writer Queue and reflects it in status", async () => {
    const record = await callDaemon("importSkill", { path: skillRoot }, socketPath);
    expect(record.name).toBe("review");

    const status = await callDaemon("status", undefined, socketPath);
    expect(status.db.total).toBe(1);
  });

  it("normalizes relative import paths before indexing", async () => {
    const relativeSkill = relative(process.cwd(), skillRoot);
    const record = await callDaemon("importSkill", { path: relativeSkill }, socketPath);
    expect(record.name).toBe("review");

    await callDaemon("skill_search", { path: skillRoot, query: "review" }, socketPath);
    const status = await callDaemon("status", undefined, socketPath);
    expect(status.db.total).toBe(1);
  });

  it("runs skill validation through the daemon", async () => {
    const validation = await callDaemon("skill_validate", { path: skillRoot }, socketPath);
    expect(validation.valid).toBe(true);
    expect(validation.lint.valid).toBe(true);
    expect(validation.duplicates).toHaveLength(0);
  });

  it("searches indexed skills with explanations", async () => {
    const result = await callDaemon("skill_search", { path: skillRoot, query: "review" }, socketPath);
    expect(result.freshness).toBe("fresh");
    expect(result.candidates[0]?.name).toBe("review");
    expect(result.candidates[0]?.matchReasons.length).toBeGreaterThan(0);
  });

  it("watches indexed SKILL.md files without recursively watching the query root", async () => {
    const broadDir = await mkdtemp(join(tmpdir(), "cobweb-broad-root-"));
    const broadSkill = join(broadDir, "skills", "review");
    const noiseDir = join(broadDir, "workspace", "repo", "logs");
    await mkdir(broadSkill, { recursive: true });
    await mkdir(noiseDir, { recursive: true });
    await writeFile(join(broadSkill, "SKILL.md"), "---\nname: broad-review\ndescription: Broad review\n---\n\n# Body\n\nReview body.\n");

    const broadSocket = join(broadDir, "cobwebd.sock");
    const broadState = createAppState({
      dataDir: broadDir,
      dbPath: join(broadDir, "cobweb.db"),
      socketPath: broadSocket,
      lockPath: join(broadDir, "lock.yaml"),
    });
    const broadServer = await startIpcServer(broadState);

    try {
      await callDaemon("skill_search", { path: broadDir, query: "review" }, broadSocket);
      await waitForRootStatus(broadSocket, broadDir, (root) => root.watcherState === "ready");

      const watchedPaths = Object.keys(broadState.watchers.get(broadDir)?.getWatched() ?? {});
      expect(watchedPaths).toContain(broadSkill);
      expect(watchedPaths).not.toContain(noiseDir);
    } finally {
      await broadServer.close();
    }
  });

  it("uses content hashes to skip unchanged roots on later searches", async () => {
    const hashDir = await mkdtemp(join(tmpdir(), "cobweb-hash-reconcile-"));
    const hashSkill = join(hashDir, "review");
    await mkdir(hashSkill, { recursive: true });
    await writeFile(join(hashSkill, "SKILL.md"), "---\nname: hash-review\ndescription: Hash review\n---\n\n# Body\n\nStable body.\n");

    const hashSocket = join(hashDir, "cobwebd.sock");
    const hashServer = await startIpcServer(
      createAppState({
        dataDir: hashDir,
        dbPath: join(hashDir, "cobweb.db"),
        socketPath: hashSocket,
        lockPath: join(hashDir, "lock.yaml"),
      }),
    );

    try {
      await callDaemon("skill_search", { path: hashDir, query: "stable" }, hashSocket);
      await waitForRootStatus(hashSocket, hashDir, (root) => root.watcherState === "ready");
      await callDaemon("skill_search", { path: hashDir, query: "stable" }, hashSocket);

      const status = await callDaemon("status", undefined, hashSocket);
      const root = status.index.roots.find((entry) => entry.root === hashDir);
      expect(root?.lastCheckKind).toBe("fast_path");
      expect(root?.fastPathEligible).toBe(true);
    } finally {
      await hashServer.close();
    }
  });

  it("uses signature checks after the staleness budget expires", async () => {
    const staleDir = await mkdtemp(join(tmpdir(), "cobweb-staleness-budget-"));
    const staleSkill = join(staleDir, "review");
    await mkdir(staleSkill, { recursive: true });
    await writeFile(join(staleSkill, "SKILL.md"), "---\nname: stale-review\ndescription: Stale review\n---\n\n# Body\n\nStable body.\n");

    const staleSocket = join(staleDir, "cobwebd.sock");
    const state = createAppState({
      dataDir: staleDir,
      dbPath: join(staleDir, "cobweb.db"),
      socketPath: staleSocket,
      lockPath: join(staleDir, "lock.yaml"),
    });
    state.maxStalenessMs = 1;
    const staleServer = await startIpcServer(state);

    try {
      await callDaemon("skill_search", { path: staleDir, query: "stable" }, staleSocket);
      await waitForRootStatus(staleSocket, staleDir, (root) => root.watcherState === "ready");
      await delay(5);
      await callDaemon("skill_search", { path: staleDir, query: "stable" }, staleSocket);

      const status = await callDaemon("status", undefined, staleSocket);
      const root = status.index.roots.find((entry) => entry.root === staleDir);
      expect(root?.lastCheckKind).toBe("signature_check");
      expect(root?.stalenessBudgetMs).toBe(1);
    } finally {
      await staleServer.close();
    }
  });

  it("does not extend the staleness budget on repeated fast-path checks", async () => {
    const missedDir = await mkdtemp(join(tmpdir(), "cobweb-missed-watch-budget-"));
    const missedSkill = join(missedDir, "changing");
    const missedSkillFile = join(missedSkill, "SKILL.md");
    await mkdir(missedSkill, { recursive: true });
    await writeFile(missedSkillFile, "---\nname: missed-watch\ndescription: Missed watch\n---\n\n# Body\n\nOld body.\n");

    const missedSocket = join(missedDir, "cobwebd.sock");
    const state = createAppState({
      dataDir: missedDir,
      dbPath: join(missedDir, "cobweb.db"),
      socketPath: missedSocket,
      lockPath: join(missedDir, "lock.yaml"),
    });
    state.maxStalenessMs = 40;
    const missedServer = await startIpcServer(state);

    try {
      await callDaemon("skill_search", { path: missedDir, query: "old" }, missedSocket);
      await waitForRootStatus(missedSocket, missedDir, (root) => root.watcherState === "ready");
      await state.watchers.get(missedDir)?.close();
      state.watchers.delete(missedDir);
      const rootState = state.indexRoots.get(missedDir);
      expect(rootState).toBeDefined();
      rootState!.lastVerifiedAt = new Date(Date.now() - 35).toISOString();

      await writeFile(missedSkillFile, "---\nname: missed-watch\ndescription: Missed watch\n---\n\n# Body\n\nUpdated needle.\n");

      let found = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const result = await callDaemon("skill_search", { path: missedDir, query: "updated" }, missedSocket);
        found = result.candidates[0]?.name === "missed-watch";
        if (found) {
          break;
        }
        await delay(5);
      }

      expect(found).toBe(true);
      const status = await callDaemon("status", undefined, missedSocket);
      const root = status.index.roots.find((entry) => entry.root === missedDir);
      expect(root?.lastCheckKind).toBe("full_reconcile");
    } finally {
      await missedServer.close();
    }
  });

  it("reflects SKILL.md changes through the watcher within the staleness budget", async () => {
    const watchDir = await mkdtemp(join(tmpdir(), "cobweb-watch-update-"));
    const watchSkill = join(watchDir, "changing");
    const watchSkillFile = join(watchSkill, "SKILL.md");
    await mkdir(watchSkill, { recursive: true });
    await writeFile(watchSkillFile, "---\nname: watch-update\ndescription: Watch update\n---\n\n# Body\n\nOld body.\n");

    const watchSocket = join(watchDir, "cobwebd.sock");
    const watchServer = await startIpcServer(
      createAppState({
        dataDir: watchDir,
        dbPath: join(watchDir, "cobweb.db"),
        socketPath: watchSocket,
        lockPath: join(watchDir, "lock.yaml"),
      }),
    );

    try {
      await callDaemon("skill_search", { path: watchDir, query: "old" }, watchSocket);
      await waitForRootStatus(watchSocket, watchDir, (root) => root.watcherState === "ready");
      await writeFile(watchSkillFile, "---\nname: watch-update\ndescription: Watch update\n---\n\n# Body\n\nUpdated needle.\n");

      const deadline = Date.now() + 2_000;
      let found = false;
      while (Date.now() < deadline) {
        const result = await callDaemon("skill_search", { path: watchDir, query: "updated" }, watchSocket);
        found = result.candidates[0]?.name === "watch-update";
        if (found) {
          break;
        }
        await delay(50);
      }
      expect(found).toBe(true);
    } finally {
      await watchServer.close();
    }
  });

  it("falls back to full reconcile when a watcher is unavailable", async () => {
    const unavailableDir = await mkdtemp(join(tmpdir(), "cobweb-watch-unavailable-"));
    const unavailableSkill = join(unavailableDir, "changing");
    const unavailableSkillFile = join(unavailableSkill, "SKILL.md");
    await mkdir(unavailableSkill, { recursive: true });
    await writeFile(
      unavailableSkillFile,
      "---\nname: unavailable-watch\ndescription: Watch unavailable\n---\n\n# Body\n\nOld body.\n",
    );

    const unavailableSocket = join(unavailableDir, "cobwebd.sock");
    const state = createAppState({
      dataDir: unavailableDir,
      dbPath: join(unavailableDir, "cobweb.db"),
      socketPath: unavailableSocket,
      lockPath: join(unavailableDir, "lock.yaml"),
    });
    const unavailableServer = await startIpcServer(state);

    try {
      await callDaemon("skill_search", { path: unavailableDir, query: "old" }, unavailableSocket);
      const root = state.indexRoots.get(unavailableDir);
      expect(root).toBeDefined();
      Object.assign(root!, {
        state: "degraded",
        reason: "watch_unavailable",
        watcherState: "unavailable",
        watching: false,
        dirty: false,
      });
      await state.watchers.get(unavailableDir)?.close();
      state.watchers.delete(unavailableDir);

      await writeFile(
        unavailableSkillFile,
        "---\nname: unavailable-watch\ndescription: Watch unavailable\n---\n\n# Body\n\nUpdated needle.\n",
      );
      const result = await callDaemon("skill_search", { path: unavailableDir, query: "updated" }, unavailableSocket);
      expect(result.candidates[0]?.name).toBe("unavailable-watch");

      const status = await callDaemon("status", undefined, unavailableSocket);
      const updatedRoot = status.index.roots.find((entry) => entry.root === unavailableDir);
      expect(updatedRoot?.watcherState).toBe("unavailable");
      expect(updatedRoot?.fastPathEligible).toBe(false);
    } finally {
      await unavailableServer.close();
    }
  });

  it("coalesces concurrent searches for the same cold root", async () => {
    const coalesceDir = await mkdtemp(join(tmpdir(), "cobweb-coalesce-"));
    const coalesceSkill = join(coalesceDir, "review");
    await mkdir(coalesceSkill, { recursive: true });
    await writeFile(join(coalesceSkill, "SKILL.md"), "---\nname: coalesce-review\ndescription: Coalesce review\n---\n\n# Body\n\nConcurrent needle.\n");

    const coalesceSocket = join(coalesceDir, "cobwebd.sock");
    const state = createAppState({
      dataDir: coalesceDir,
      dbPath: join(coalesceDir, "cobweb.db"),
      socketPath: coalesceSocket,
      lockPath: join(coalesceDir, "lock.yaml"),
    });
    let reconciles = 0;
    const originalListHashes = state.db.listSkillContentHashesUnderRoot.bind(state.db);
    state.db.listSkillContentHashesUnderRoot = (rootPath: string) => {
      reconciles += 1;
      return originalListHashes(rootPath);
    };
    const coalesceServer = await startIpcServer(state);

    try {
      const [left, right] = await Promise.all([
        callDaemon("skill_search", { path: coalesceDir, query: "concurrent" }, coalesceSocket),
        callDaemon("skill_search", { path: coalesceDir, query: "concurrent" }, coalesceSocket),
      ]);
      expect(left.candidates[0]?.name).toBe("coalesce-review");
      expect(right.candidates[0]?.name).toBe("coalesce-review");
      expect(reconciles).toBe(1);
    } finally {
      await coalesceServer.close();
    }
  });

  it("isolates a bad SKILL.md while indexing the rest of the root", async () => {
    const partialDir = await mkdtemp(join(tmpdir(), "cobweb-partial-index-"));
    const goodSkill = join(partialDir, "good");
    const badSkill = join(partialDir, "bad");
    await mkdir(goodSkill, { recursive: true });
    await mkdir(badSkill, { recursive: true });
    await writeFile(join(goodSkill, "SKILL.md"), "---\nname: good\ndescription: Good skill\n---\n\n# Body\n\nNeedle content.\n");
    await writeFile(join(badSkill, "SKILL.md"), "---\nname: [\n---\n\n# Broken\n");

    const partialSocket = join(partialDir, "cobwebd.sock");
    const partialServer = await startIpcServer(
      createAppState({
        dataDir: partialDir,
        dbPath: join(partialDir, "cobweb.db"),
        socketPath: partialSocket,
        lockPath: join(partialDir, "lock.yaml"),
      }),
    );

    try {
      const result = await callDaemon("skill_search", { path: partialDir, query: "needle" }, partialSocket);
      expect(result.candidates[0]?.name).toBe("good");
      expect(result.warnings.some((warning) => warning.includes(badSkill))).toBe(true);

      const status = await callDaemon("status", undefined, partialSocket);
      const root = status.index.roots.find((entry) => entry.root === partialDir);
      expect(root?.state).toBe("degraded");
      expect(root?.lastIndexError).toContain(badSkill);
    } finally {
      await partialServer.close();
    }
  });

  it("returns freshness for the requested root instead of the global index summary", async () => {
    const multiRootDir = await mkdtemp(join(tmpdir(), "cobweb-root-freshness-"));
    const freshRoot = join(multiRootDir, "fresh-root");
    const freshSkill = join(freshRoot, "good");
    const degradedRoot = join(multiRootDir, "degraded-root");
    const degradedSkill = join(degradedRoot, "bad");
    const degradedSkillFile = join(degradedSkill, "SKILL.md");
    await mkdir(freshSkill, { recursive: true });
    await mkdir(degradedSkill, { recursive: true });
    await writeFile(join(freshSkill, "SKILL.md"), "---\nname: local-fresh\ndescription: Fresh root\n---\n\n# Body\n\nFresh needle.\n");
    await writeFile(degradedSkillFile, "---\nname: blocked-read\ndescription: Blocked read\n---\n\n# Body\n\nBroken needle.\n");
    await chmod(degradedSkillFile, 0o000);

    const multiSocket = join(multiRootDir, "cobwebd.sock");
    const multiServer = await startIpcServer(
      createAppState({
        dataDir: multiRootDir,
        dbPath: join(multiRootDir, "cobweb.db"),
        socketPath: multiSocket,
        lockPath: join(multiRootDir, "lock.yaml"),
      }),
    );

    try {
      const degraded = await callDaemon("skill_search", { path: degradedRoot, query: "broken" }, multiSocket);
      expect(degraded.freshness).toBe("degraded");

      const fresh = await callDaemon("skill_search", { path: freshRoot, query: "needle" }, multiSocket);
      expect(fresh.freshness).toBe("fresh");
      expect(fresh.candidates[0]?.name).toBe("local-fresh");
    } finally {
      await chmod(degradedSkillFile, 0o600).catch(() => undefined);
      await multiServer.close();
    }
  });

  it("keeps previously indexed skills when SKILL.md is temporarily unreadable", async () => {
    const unreadableDir = await mkdtemp(join(tmpdir(), "cobweb-unreadable-index-"));
    const unreadableSkill = join(unreadableDir, "kept");
    const skillFile = join(unreadableSkill, "SKILL.md");
    await mkdir(unreadableSkill, { recursive: true });
    await writeFile(skillFile, "---\nname: kept\ndescription: Kept skill\n---\n\n# Body\n\nRetained needle.\n");

    const unreadableSocket = join(unreadableDir, "cobwebd.sock");
    const state = createAppState({
      dataDir: unreadableDir,
      dbPath: join(unreadableDir, "cobweb.db"),
      socketPath: unreadableSocket,
      lockPath: join(unreadableDir, "lock.yaml"),
    });
    const unreadableServer = await startIpcServer(state);

    try {
      const initial = await callDaemon("skill_search", { path: unreadableDir, query: "retained" }, unreadableSocket);
      expect(initial.candidates[0]?.name).toBe("kept");

      await chmod(skillFile, 0o000);
      Object.assign(state.indexRoots.get(unreadableDir)!, { dirty: true, reason: "test_dirty_reconcile" });
      const degraded = await callDaemon("skill_search", { path: unreadableDir, query: "retained" }, unreadableSocket);
      expect(degraded.freshness).toBe("degraded");
      expect(degraded.candidates[0]?.name).toBe("kept");
      expect(degraded.warnings.some((warning) => warning.includes(unreadableSkill))).toBe(true);
    } finally {
      await chmod(skillFile, 0o600).catch(() => undefined);
      await unreadableServer.close();
    }
  });

  it("selects the best low-risk skill with a recommendation", async () => {
    const result = await callDaemon("skill_select", { path: skillRoot, query: "review" }, socketPath);
    expect(result.selected?.name).toBe("review");
    expect(result.selected?.scoreBreakdown.length).toBeGreaterThan(0);
    expect(result.chain?.target.name).toBe("review");
    expect(result.selectionStatus).toBe("needs_inspection");
    expect(result.recommendation.confidence).toBeGreaterThan(0);
    expect(result.guidance?.reason).toBe("missing_work_item");
  });

  it("keeps the selected candidate while returning low-confidence guidance", async () => {
    const result = await callDaemon("skill_select", {
      path: skillRoot,
      query: "review alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu",
      workItem: { subject: "pull request" },
    }, socketPath);
    expect(result.selected?.name).toBe("review");
    expect(result.selectionStatus).toBe("needs_inspection");
    expect(result.recommendation.confidence).toBeGreaterThan(0);
    expect(result.recommendation.reason).toMatch(/Tentatively ranked/);
    expect(result.rejected).toEqual([]);
    expect(result.chain?.target.name).toBe("review");
    expect(["query_too_long", "top1_confidence_low"]).toContain(result.guidance?.reason);
    expect(result.guidance?.inspectionTargets[0]).toMatchObject({
      path: skillRoot,
      name: "review",
      kind: "skill",
    });
  });

  it("returns no_candidate guidance when nothing matches", async () => {
    const result = await callDaemon("skill_select", {
      path: skillRoot,
      query: "zzzznomatchquery",
      workItem: { subject: "unknown daemon issue" },
    }, socketPath);
    expect(result.selected).toBeNull();
    expect(result.selectionStatus).toBe("no_candidate");
    expect(result.recommendation.confidence).toBe(0);
    expect(result.guidance?.reason).toBe("no_candidate");
    expect(Array.isArray(result.guidance?.checklist)).toBe(true);
    expect(result.guidance?.inspectionTargets).toEqual([
      expect.objectContaining({
        path: skillRoot,
        name: "scan root",
        kind: "scan_root",
      }),
    ]);
  });

  it("returns skill context with methods, resources, and policy", async () => {
    const context = await callDaemon("skill_context", { path: skillRoot }, socketPath);
    expect(context.name).toBe("review");
    expect(context.methods[0]?.summary).toContain("Safe body");
    expect(context.policy.check.ok).toBe(true);
  });

  it("updates policy and checks alignment through the Writer Queue", async () => {
    const updated = await callDaemon("updatePolicy", { path: skillRoot, implicitInvocation: false }, socketPath);
    expect(updated.ok).toBe(true);

    const result = await callDaemon("policyCheck", { path: skillRoot }, socketPath);
    expect(result.ok).toBe(true);
  });

  it("imports to canonical store and returns sync dry-run plans", async () => {
    const record = await callDaemon("importSkill", { path: skillRoot, canonicalDir: join(dir, "canonical") }, socketPath);
    expect(record.name).toBe("review");

    const sync = await callDaemon("sync", { projectRoot: dir, target: ["agents"], dryRun: true }, socketPath);
    expect(sync.plans.length).toBeGreaterThanOrEqual(1);
    expect(sync.results).toHaveLength(0);
  });

  it("checkpoints WAL through the Writer Queue", async () => {
    const result = await callDaemon("checkpointWal", undefined, socketPath);
    expect(result.checkpoint).toContain("checkpointed");
  });

  it("sync --write upserts lockfile skills before recording provider installs", async () => {
    const syncDir = await mkdtemp(join(tmpdir(), "cobweb-sync-empty-db-"));
    const source = join(syncDir, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: synced\ndescription: Synced skill\n---\n\n# Body\n");

    const lockfilePath = join(syncDir, "cobweb.lock.yaml");
    await importCanonicalSkill(source, { canonicalDir: join(syncDir, "canonical"), lockfilePath });

    const syncSocket = join(syncDir, "cobwebd.sock");
    const syncServer = await startIpcServer(
      createAppState({
        dataDir: syncDir,
        dbPath: join(syncDir, "empty.db"),
        socketPath: syncSocket,
        lockPath: lockfilePath,
      }),
    );

    try {
      const result = await callDaemon(
        "sync",
        { projectRoot: syncDir, target: ["agents"], strategy: "copy", dryRun: false },
        syncSocket,
      );
      expect(result.results).toHaveLength(1);

      const status = await callDaemon("status", undefined, syncSocket);
      expect(status.db.total).toBe(1);
    } finally {
      await syncServer.close();
    }
  });

  it("re-indexes ad-hoc roots after a lockfile rebuild prunes them", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "cobweb-rebuild-reindex-"));
    const projectRoot = join(baseDir, "project");
    const projectSkill = join(projectRoot, "review");
    await mkdir(projectSkill, { recursive: true });
    await writeFile(
      join(projectSkill, "SKILL.md"),
      "---\nname: review\ndescription: Review skill\n---\n\n# Review\n\nSafe body.\n",
    );

    const source = join(baseDir, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: other\ndescription: Other skill\n---\n\n# Body\n");

    const rebuildSocket = join(baseDir, "cobwebd.sock");
    const rebuildServer = await startIpcServer(
      createAppState({
        dataDir: baseDir,
        dbPath: join(baseDir, "rebuild.db"),
        socketPath: rebuildSocket,
        lockPath: join(baseDir, "cobweb.lock.yaml"),
      }),
    );

    try {
      const indexed = await callDaemon("skill_search", { path: projectRoot, query: "review" }, rebuildSocket);
      expect(indexed.candidates[0]?.name).toBe("review");

      await callDaemon("importSkill", { path: source, canonicalDir: join(baseDir, "canonical") }, rebuildSocket);
      await callDaemon("rebuildFromLockfile", {}, rebuildSocket);

      const afterRebuild = await callDaemon("skill_search", { path: projectRoot, query: "review" }, rebuildSocket);
      expect(afterRebuild.candidates[0]?.name).toBe("review");
    } finally {
      await rebuildServer.close();
    }
  });

  it("restores watch roots after daemon restart without marking them fresh", async () => {
    const restoreDir = await mkdtemp(join(tmpdir(), "cobweb-restore-watch-"));
    const restoreSkill = join(restoreDir, "watch");
    await mkdir(restoreSkill, { recursive: true });
    await writeFile(join(restoreSkill, "SKILL.md"), "---\nname: watch\ndescription: Watch skill\n---\n\n# Body\n\nWatch body.\n");
    const restoreDb = join(restoreDir, "cobweb.db");
    const restoreLock = join(restoreDir, "lock.yaml");
    const firstSocket = join(restoreDir, "first.sock");
    const firstServer = await startIpcServer(
      createAppState({
        dataDir: restoreDir,
        dbPath: restoreDb,
        socketPath: firstSocket,
        lockPath: restoreLock,
      }),
    );

    await callDaemon("skill_search", { path: restoreDir, query: "watch" }, firstSocket);
    await firstServer.close();

    const secondSocket = join(restoreDir, "second.sock");
    const secondServer = await startIpcServer(
      createAppState({
        dataDir: restoreDir,
        dbPath: restoreDb,
        socketPath: secondSocket,
        lockPath: restoreLock,
      }),
    );

    try {
      const status = await callDaemon("status", undefined, secondSocket);
      const root = status.index.roots.find((entry) => entry.root === restoreDir);
      expect(root?.state).toBe("degraded");
      expect(root?.watching).toBe(true);
      expect(root?.reason).toBe("restored_watch_root");
    } finally {
      await secondServer.close();
    }
  });

  it("reconciles changes made while the daemon was stopped on the first query after restart", async () => {
    const restartDir = await mkdtemp(join(tmpdir(), "cobweb-restart-reconcile-"));
    const restartSkill = join(restartDir, "changing");
    await mkdir(restartSkill, { recursive: true });
    await writeFile(join(restartSkill, "SKILL.md"), "---\nname: changing\ndescription: Changing skill\n---\n\n# Body\n\nOld body.\n");
    const restartDb = join(restartDir, "cobweb.db");
    const restartLock = join(restartDir, "lock.yaml");
    const firstSocket = join(restartDir, "first.sock");
    const firstServer = await startIpcServer(
      createAppState({
        dataDir: restartDir,
        dbPath: restartDb,
        socketPath: firstSocket,
        lockPath: restartLock,
      }),
    );

    await callDaemon("skill_search", { path: restartDir, query: "old" }, firstSocket);
    await firstServer.close();
    await writeFile(join(restartSkill, "SKILL.md"), "---\nname: changing\ndescription: Changing skill\n---\n\n# Body\n\nUpdated needle.\n");

    const secondSocket = join(restartDir, "second.sock");
    const secondServer = await startIpcServer(
      createAppState({
        dataDir: restartDir,
        dbPath: restartDb,
        socketPath: secondSocket,
        lockPath: restartLock,
      }),
    );

    try {
      const result = await callDaemon("skill_search", { path: restartDir, query: "updated" }, secondSocket);
      expect(result.candidates[0]?.name).toBe("changing");
      expect(result.candidates[0]?.matchReasons.some((reason) => reason.snippet?.toLowerCase().includes("updated"))).toBe(true);
    } finally {
      await secondServer.close();
    }
  });

  it("runs doctor with an ok integrity check", async () => {
    const result = await callDaemon("doctor", undefined, socketPath);
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "sqlite_quick_check")?.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "fts_consistency")?.ok).toBe(true);
  });

  it("rejects unknown methods", async () => {
    await expect(
      callDaemon("status".replace("status", "bogus") as "status", undefined, socketPath),
    ).rejects.toThrow(/Unknown daemon method/);
  });

  it("rejects malformed params", async () => {
    await expect(callDaemon("scan", undefined as never, socketPath)).rejects.toThrow(/params/);
  });

  it("fails to connect to a missing socket", async () => {
    await expect(callDaemon("status", undefined, join(dir, "missing.sock"))).rejects.toThrow(/cobwebd/);
  });

  it("returns BAD_JSON for malformed input without crashing", async () => {
    const raw = await sendRaw(socketPath, "not json\n");
    const response = JSON.parse(raw);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("BAD_JSON");
  });

  it("keeps runtime leases while the control socket is open", async () => {
    const lease = await openDaemonLease({ client: "mcp-test", pid: process.pid, transport: "stdio", ttlMs: 1_000 }, socketPath);
    const statusWithLease = await callDaemon("status", undefined, socketPath);
    expect(statusWithLease.runtime.activeLeases.some((candidate) => candidate.id === lease.leaseId)).toBe(true);

    lease.close();
    await delay(25);

    const statusAfterClose = await callDaemon("status", undefined, socketPath);
    expect(statusAfterClose.runtime.activeLeases.some((candidate) => candidate.id === lease.leaseId)).toBe(false);
  });

  it("does not idle-stop while a runtime lease is active", async () => {
    const leaseDir = await mkdtemp(join(tmpdir(), "cobweb-lease-"));
    const leaseSocket = join(leaseDir, "cobwebd.sock");
    const leaseServer = await startIpcServer(
      createAppState(
        {
          dataDir: leaseDir,
          dbPath: join(leaseDir, "cobweb.db"),
          socketPath: leaseSocket,
          lockPath: join(leaseDir, "lock.yaml"),
        },
        { idleTimeoutMs: 20, idleGraceMs: 20, leaseTtlMs: 2_000 },
      ),
    );
    const lease = await openDaemonLease({ client: "mcp-test", pid: process.pid, transport: "stdio", ttlMs: 2_000 }, leaseSocket);

    try {
      await delay(1_100);
      await expect(callDaemon("status", undefined, leaseSocket)).resolves.toMatchObject({ running: true });
      await lease.detach();
      await delay(1_100);
      await expect(callDaemon("status", undefined, leaseSocket)).rejects.toThrow(/cobwebd|closed/i);
    } finally {
      lease.close();
      await leaseServer.close();
    }
  });

  it("refuses to start a second daemon on the same socket", async () => {
    const state = createAppState({
      dataDir: dir,
      dbPath: join(dir, "cobweb.db"),
      socketPath,
      lockPath: join(dir, "lock.yaml"),
    });
    await expect(startIpcServer(state)).rejects.toThrow(/already/i);
    state.db.close();
  });

  it("stops the daemon and removes the socket", async () => {
    const result = await callDaemon("stop", undefined, socketPath);
    expect(result.stopping).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(callDaemon("status", undefined, socketPath)).rejects.toThrow();
  });
});
