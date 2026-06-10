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

  it("dedups through the daemon", async () => {
    const result = await callDaemon("dedup", { path: skillRoot }, socketPath);
    expect(result.matches).toHaveLength(0);
  });

  it("imports a skill via the Writer Queue and reflects it in status", async () => {
    const record = await callDaemon("importSkill", { path: skillRoot }, socketPath);
    expect(record.name).toBe("review");

    const status = await callDaemon("status", undefined, socketPath);
    expect(status.db.total).toBe(1);
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
