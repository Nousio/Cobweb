import { CobwebError } from "@cobweb/core";
import type { DaemonMethods } from "@cobweb/daemon";
import { callDaemon } from "@cobweb/daemon/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type ToolName = keyof Pick<
  DaemonMethods,
  "status" | "scan" | "skill_graph" | "skill_search" | "skill_select" | "skill_context" | "skill_validate"
>;

export const mcpTools: Array<{ name: ToolName; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: "status",
    description: "Return Cobweb daemon status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "scan",
    description: "Scan a directory for SKILL.md skills.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "skill_graph",
    description:
      "Build an in-memory, read-only SkillGraph topology from a scan root. Nodes: scan_root | skill | resource | external. Edges: contains (directory hierarchy) | references (resource/URL) | references_skill (points at another skill). Each edge carries fromRelativePath/toRelativePath plus rawPath/resolvedPath; missing targets are flagged unresolved, external URLs are flagged external, and direct/indirect skill reference cycles are flagged invalidCycle and excluded from path expansion. No audit/risk judgment, no persistence. By default it does not start a file watcher.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Scan root directory to build the topology from." },
        maxDepth: { type: "number", description: "Maximum root-to-leaf path enumeration depth (default 32)." },
        maxPaths: { type: "number", description: "Maximum number of root-to-leaf paths to enumerate (default 1000)." },
        includeExternal: { type: "boolean", description: "Include external URL nodes and edges (default true)." },
        watch: {
          type: "boolean",
          description: "Register a daemon file watcher on the root to keep it warm for later skill_search (default false).",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "skill_search",
    description: "Search indexed skills with FTS-backed match reasons.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, query: { type: "string" }, limit: { type: "number" } },
      required: ["path", "query"],
    },
  },
  {
    name: "skill_select",
    description: "Select the best indexed skill for a query and explain the recommendation.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, query: { type: "string" }, limit: { type: "number" } },
      required: ["path", "query"],
    },
  },
  {
    name: "skill_context",
    description: "Return method, resource, policy, and lint context for a skill.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "skill_validate",
    description: "Validate a skill with lint, policy, and indexed duplicate checks.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    {
      name: "cobweb",
      version: "0.2.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name as ToolName;
    const tool = mcpTools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const result = await dispatchMcpTool(name, request.params.arguments ?? {});
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  });

  await server.connect(new StdioServerTransport());
}

export async function dispatchMcpTool(name: ToolName, args: unknown): Promise<unknown> {
  switch (name) {
    case "status":
      return callDaemonForMcp("status", undefined);
    case "scan":
      return callDaemonForMcp("scan", expectArgs<DaemonMethods["scan"]["params"]>(args));
    case "skill_graph":
      return callDaemonForMcp("skill_graph", expectArgs<DaemonMethods["skill_graph"]["params"]>(args));
    case "skill_search":
      return callDaemonForMcp("skill_search", expectArgs<DaemonMethods["skill_search"]["params"]>(args));
    case "skill_select":
      return callDaemonForMcp("skill_select", expectArgs<DaemonMethods["skill_select"]["params"]>(args));
    case "skill_context":
      return callDaemonForMcp("skill_context", expectArgs<DaemonMethods["skill_context"]["params"]>(args));
    case "skill_validate":
      return callDaemonForMcp("skill_validate", expectArgs<DaemonMethods["skill_validate"]["params"]>(args));
  }
}

async function callDaemonForMcp<K extends keyof DaemonMethods>(
  method: K,
  params: DaemonMethods[K]["params"],
): Promise<DaemonMethods[K]["result"]> {
  try {
    return await callDaemon(method, params);
  } catch (error) {
    if (error instanceof CobwebError && error.code === "DAEMON_UNAVAILABLE") {
      throw new CobwebError(
        error.code,
        [
          "Cobweb daemon is not reachable.",
          "Start it with `cobweb daemon start`, then retry the MCP request.",
          "If the daemon was installed globally, confirm `cobwebd` is on PATH and the MCP client uses the same COBWEB_DATA_DIR.",
          `Cause: ${error.message}`,
        ].join(" "),
        { retryable: true, cause: error },
      );
    }
    throw error;
  }
}

function expectArgs<T>(value: unknown): T {
  if (!value || typeof value !== "object") {
    throw new Error("Tool arguments must be an object.");
  }
  return value as T;
}
