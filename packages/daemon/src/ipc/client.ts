import { SkillRouteError, defaultRuntimePaths } from "@skillroute/core";
import { randomUUID } from "node:crypto";
import net from "node:net";
import type { DaemonMethods, JsonRpcRequest, JsonRpcResponse } from "./protocol.js";

export interface DaemonLeaseHandle {
  leaseId: string;
  expiresAt: string;
  heartbeat(): Promise<string>;
  detach(): Promise<void>;
  close(): void;
}

export async function callDaemon<K extends keyof DaemonMethods>(
  method: K,
  params: DaemonMethods[K]["params"],
  socketPath = defaultRuntimePaths().socketPath,
): Promise<DaemonMethods[K]["result"]> {
  const request: JsonRpcRequest = {
    id: randomUUID(),
    method: String(method),
    params,
  };

  const response = await send(socketPath, request);
  if (!response.ok) {
    throw new SkillRouteError(response.error.code, response.error.message, {
      retryable: response.error.retryable,
    });
  }
  return response.result as DaemonMethods[K]["result"];
}

export async function openDaemonLease(
  params: Omit<DaemonMethods["leaseAttach"]["params"], "socketBound">,
  socketPath = defaultRuntimePaths().socketPath,
): Promise<DaemonLeaseHandle> {
  const connection = await openPersistentConnection(socketPath);
  let attached: DaemonMethods["leaseAttach"]["result"];
  try {
    attached = await connection.call("leaseAttach", { ...params, socketBound: true });
  } catch (error) {
    connection.close();
    throw error;
  }
  const handle: DaemonLeaseHandle = {
    leaseId: attached.leaseId,
    expiresAt: attached.expiresAt,
    async heartbeat() {
      const result = await connection.call("leaseHeartbeat", { leaseId: handle.leaseId, ttlMs: params.ttlMs });
      handle.expiresAt = result.expiresAt;
      return result.expiresAt;
    },
    async detach() {
      try {
        await connection.call("leaseDetach", { leaseId: handle.leaseId });
      } finally {
        connection.close();
      }
    },
    close() {
      connection.close();
    },
  };
  return handle;
}

async function send(socketPath: string, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  return new Promise<JsonRpcResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";

    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }

      const line = buffer.slice(0, newline);
      socket.end();

      try {
        resolve(JSON.parse(line) as JsonRpcResponse);
      } catch (error) {
        reject(new SkillRouteError("BAD_DAEMON_RESPONSE", "Daemon returned invalid JSON.", { cause: error }));
      }
    });

    socket.once("error", (error) => {
      reject(new SkillRouteError("DAEMON_UNAVAILABLE", `Cannot connect to skillrouted: ${error.message}`, { cause: error }));
    });
  });
}

interface PersistentConnection {
  call<K extends keyof DaemonMethods>(method: K, params: DaemonMethods[K]["params"]): Promise<DaemonMethods[K]["result"]>;
  close(): void;
}

function openPersistentConnection(socketPath: string): Promise<PersistentConnection> {
  return new Promise<PersistentConnection>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const pending = new Map<string, { resolve: (response: JsonRpcResponse) => void; reject: (error: unknown) => void }>();
    let buffer = "";
    let connected = false;

    const failPending = (error: unknown) => {
      for (const entry of pending.values()) {
        entry.reject(error);
      }
      pending.clear();
    };

    socket.once("connect", () => {
      connected = true;
      resolve({
        call(method, params) {
          return new Promise((callResolve, callReject) => {
            const request: JsonRpcRequest = {
              id: randomUUID(),
              method: String(method),
              params,
            };
            pending.set(request.id, {
              resolve(response) {
                if (!response.ok) {
                  callReject(
                    new SkillRouteError(response.error.code, response.error.message, {
                      retryable: response.error.retryable,
                    }),
                  );
                  return;
                }
                callResolve(response.result as DaemonMethods[typeof method]["result"]);
              },
              reject: callReject,
            });
            socket.write(`${JSON.stringify(request)}\n`);
          });
        },
        close() {
          socket.end();
          socket.destroy();
        },
      });
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (; ;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          break;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let response: JsonRpcResponse;
        try {
          response = JSON.parse(line) as JsonRpcResponse;
        } catch (error) {
          failPending(new SkillRouteError("BAD_DAEMON_RESPONSE", "Daemon returned invalid JSON.", { cause: error }));
          continue;
        }
        const entry = pending.get(response.id);
        if (!entry) {
          continue;
        }
        pending.delete(response.id);
        entry.resolve(response);
      }
    });

    socket.once("error", (error) => {
      const wrapped = new SkillRouteError("DAEMON_UNAVAILABLE", `Cannot connect to skillrouted: ${error.message}`, { cause: error });
      if (!connected) {
        reject(wrapped);
      }
      failPending(wrapped);
    });

    socket.once("close", () => {
      const error = new SkillRouteError("DAEMON_UNAVAILABLE", "Connection to skillrouted closed.");
      if (!connected) {
        reject(error);
      }
      failPending(error);
    });
  });
}
