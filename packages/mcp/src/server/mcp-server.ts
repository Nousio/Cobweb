import type { DaemonMethods } from "@cobweb/daemon";
import { callDaemon } from "@cobweb/daemon/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type ToolName = keyof Pick<
  DaemonMethods,
  "status" | "scan" | "audit" | "skill_search" | "skill_select" | "skill_context" | "skill_validate"
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
    name: "audit",
    description: "Audit a skill directory for risk findings.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "skill_search",
    description: "Search scanned skills lexically through the daemon.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, query: { type: "string" } },
      required: ["path", "query"],
    },
  },
  {
    name: "skill_select",
    description: "Select the first matching skill candidate for a query.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, query: { type: "string" } },
      required: ["path", "query"],
    },
  },
  {
    name: "skill_context",
    description: "Return audit and lint context for a skill.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "skill_validate",
    description: "Validate a skill with lint, audit, and policy checks.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    {
      name: "cobweb",
      version: "0.1.0",
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
      return callDaemon("status", undefined);
    case "scan":
      return callDaemon("scan", expectArgs<DaemonMethods["scan"]["params"]>(args));
    case "audit":
      return callDaemon("audit", expectArgs<DaemonMethods["audit"]["params"]>(args));
    case "skill_search":
      return callDaemon("skill_search", expectArgs<DaemonMethods["skill_search"]["params"]>(args));
    case "skill_select":
      return callDaemon("skill_select", expectArgs<DaemonMethods["skill_select"]["params"]>(args));
    case "skill_context":
      return callDaemon("skill_context", expectArgs<DaemonMethods["skill_context"]["params"]>(args));
    case "skill_validate":
      return callDaemon("skill_validate", expectArgs<DaemonMethods["skill_validate"]["params"]>(args));
  }
}

function expectArgs<T>(value: unknown): T {
  if (!value || typeof value !== "object") {
    throw new Error("Tool arguments must be an object.");
  }
  return value as T;
}
