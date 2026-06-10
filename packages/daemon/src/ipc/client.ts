import { CobwebError, defaultRuntimePaths } from "@cobweb/core";
import { randomUUID } from "node:crypto";
import net from "node:net";
import type { DaemonMethods, JsonRpcRequest, JsonRpcResponse } from "./protocol.js";

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
    throw new CobwebError(response.error.code, response.error.message, {
      retryable: response.error.retryable,
    });
  }
  return response.result as DaemonMethods[K]["result"];
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
        reject(new CobwebError("BAD_DAEMON_RESPONSE", "Daemon returned invalid JSON.", { cause: error }));
      }
    });

    socket.once("error", (error) => {
      reject(new CobwebError("DAEMON_UNAVAILABLE", `Cannot connect to cobwebd: ${error.message}`, { cause: error }));
    });
  });
}
