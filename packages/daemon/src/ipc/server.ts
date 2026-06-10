import {
  auditParsedSkill,
  CobwebError,
  dedupSkills,
  parseSkillDirectory,
  scanSkills,
  toErrorMessage,
} from "@cobweb/core";
import { access, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";
import type { AppState } from "../app-state/app-state.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./protocol.js";

export interface DaemonServer {
  close(): Promise<void>;
}

export async function startIpcServer(state: AppState): Promise<DaemonServer> {
  await mkdir(dirname(state.paths.socketPath), { recursive: true });
  if (await pathExists(state.paths.socketPath)) {
    if (await isSocketAlive(state.paths.socketPath)) {
      throw new CobwebError("DAEMON_ALREADY_RUNNING", `cobwebd is already listening on ${state.paths.socketPath}`);
    }
    await rm(state.paths.socketPath, { force: true });
  }

  let stopping = false;
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

  return {
    async close() {
      if (!stopping) {
        await stopServer(state, server, () => {
          stopping = true;
        });
      }
    },
  };
}

async function stopServer(state: AppState, server: net.Server, markStopping: () => void): Promise<void> {
  markStopping();
  await state.writer.waitForIdle();
  state.db.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(state.paths.socketPath, { force: true });
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
      const params = expectParams<{ path: string }>(request.params);
      return state.writer.enqueue("ImportSkill", async () => {
        const parsed = await parseSkillDirectory(params.path);
        const audit = auditParsedSkill(parsed);
        return state.db.upsertSkill(parsed, audit);
      });
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
