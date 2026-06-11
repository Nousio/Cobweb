import { callDaemon } from "@cobweb/daemon/client";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface ShimRequest {
  id?: string;
  method?: string;
  params?: unknown;
}

export interface ShimStreams {
  input?: Readable;
  output?: Writable;
}

export async function handleShimLine(line: string): Promise<string | null> {
  if (!line.trim()) {
    return null;
  }

  let request: ShimRequest;
  try {
    request = parseLine(line);
  } catch (error) {
    return `${JSON.stringify(shimError("unknown", error))}\n`;
  }

  const id = request.id ?? "unknown";
  try {
    const result = await dispatch(request);
    return `${JSON.stringify({ id, ok: true, result })}\n`;
  } catch (error) {
    return `${JSON.stringify(shimError(id, error))}\n`;
  }
}

export async function runStdioShim(streams: ShimStreams = {}): Promise<void> {
  const input = streams.input ?? processStdin;
  const output = streams.output ?? processStdout;
  const rl = createInterface({ input, output });

  for await (const line of rl) {
    const response = await handleShimLine(line);
    if (response !== null) {
      output.write(response);
    }
  }
}

function shimError(id: string, error: unknown): {
  id: string;
  ok: false;
  error: { code: string; message: string };
} {
  return {
    id,
    ok: false,
    error: {
      code: "MCP_SHIM_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export async function dispatch(request: ShimRequest): Promise<unknown> {
  switch (request.method) {
    case "status":
      return callDaemon("status", undefined);
    case "scan":
      return callDaemon("scan", expectParams<{ path: string }>(request.params));
    case "audit":
      return callDaemon("audit", expectParams<{ path: string }>(request.params));
    case "skill_search":
      return callDaemon("skill_search", expectParams<{ path: string; query: string }>(request.params));
    case "skill_select":
      return callDaemon("skill_select", expectParams<{ path: string; query: string }>(request.params));
    case "skill_context":
      return callDaemon("skill_context", expectParams<{ path: string }>(request.params));
    case "skill_validate":
      return callDaemon("skill_validate", expectParams<{ path: string }>(request.params));
    default:
      throw new Error(`Unsupported phase-one MCP shim method: ${request.method ?? "<missing>"}`);
  }
}

function parseLine(line: string): ShimRequest {
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("MCP shim request must be a JSON object.");
  }
  return parsed as ShimRequest;
}

function expectParams<T>(value: unknown): T {
  if (!value || typeof value !== "object") {
    throw new Error("Request params must be an object.");
  }
  return value as T;
}
