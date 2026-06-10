import { callDaemon } from "@cobweb/daemon/client";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

interface ShimRequest {
  id?: string;
  method?: string;
  params?: unknown;
}

export async function runStdioShim(): Promise<void> {
  const rl = createInterface({ input, output });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    const request = parseLine(line);
    const id = request.id ?? "unknown";

    try {
      const result = await dispatch(request);
      output.write(`${JSON.stringify({ id, ok: true, result })}\n`);
    } catch (error) {
      output.write(
        `${JSON.stringify({
          id,
          ok: false,
          error: {
            code: "MCP_SHIM_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        })}\n`,
      );
    }
  }
}

async function dispatch(request: ShimRequest): Promise<unknown> {
  switch (request.method) {
    case "status":
      return callDaemon("status", undefined);
    case "scan":
      return callDaemon("scan", expectParams<{ path: string }>(request.params));
    case "audit":
      return callDaemon("audit", expectParams<{ path: string }>(request.params));
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
