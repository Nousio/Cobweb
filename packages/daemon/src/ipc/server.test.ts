import { importCanonicalSkill } from "@cobweb/core";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppState } from "../app-state/app-state.js";
import { callDaemon } from "./client.js";
import { type DaemonServer, startIpcServer } from "./server.js";

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

  it("audits through the daemon", async () => {
    const result = await callDaemon("audit", { path: skillRoot }, socketPath);
    expect(result.riskLevel).toBe("low");
  });

  it("imports a skill via the Writer Queue and reflects it in status", async () => {
    const record = await callDaemon("importSkill", { path: skillRoot }, socketPath);
    expect(record.name).toBe("review");

    const status = await callDaemon("status", undefined, socketPath);
    expect(status.db.total).toBe(1);
  });

  it("runs skill validation through the daemon", async () => {
    const validation = await callDaemon("skill_validate", { path: skillRoot }, socketPath);
    expect(validation.audit.riskLevel).toBe("low");
    expect(validation.lint.valid).toBe(true);
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

  it("runs doctor with an ok integrity check", async () => {
    const result = await callDaemon("doctor", undefined, socketPath);
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "sqlite_integrity")?.ok).toBe(true);
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
