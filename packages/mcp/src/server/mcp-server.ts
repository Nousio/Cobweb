import type { DaemonMethods } from "@cobweb/daemon";
import { ensureDaemonRunning } from "@cobweb/daemon";
import { callDaemon, openDaemonLease, type DaemonLeaseHandle } from "@cobweb/daemon/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const MCP_LEASE_TTL_MS = 30_000;
const MCP_LEASE_HEARTBEAT_MS = 10_000;
const MCP_LEASE_DETACH_TIMEOUT_MS = 1_000;

type ToolName = keyof Pick<
  DaemonMethods,
  "status" | "scan" | "skill_graph" | "skill_chain" | "skill_search" | "skill_select" | "skill_context" | "skill_validate"
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
    name: "skill_chain",
    description:
      "Return the chain for one skill in an in-memory SkillGraph: the root-to-skill path, outgoing skill references, incoming references, and referenced local/external resources. Target may be a skill relative path, absolute path, id, or skill name. No persistence and no audit/risk judgment.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Scan root directory to build the topology from." },
        target: { type: "string", description: "Skill relative path, absolute path, id, or skill name." },
        maxDepth: { type: "number", description: "Maximum graph traversal depth (default 32)." },
        maxPaths: { type: "number", description: "Maximum number of graph paths to enumerate (default 1000)." },
        includeExternal: { type: "boolean", description: "Include external URL nodes and edges (default true)." },
        watch: {
          type: "boolean",
          description: "Register a daemon file watcher on the root to keep it warm for later skill_search (default false).",
        },
      },
      required: ["path", "target"],
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
    description:
      "Select the best indexed skill for a query with deterministic score breakdown and SkillGraph chain context. Before calling, analyze the user's task and provide `workItem.subject` for the concrete thing being handled; this is required so Cobweb can distinguish raw user text from an agent-analyzed routing request, and `subject` now also feeds ranking (candidates covering the core object rank higher), so set it to the real task object, not filler. Pass `query` as analyzed routing terms (intent verb + discriminative subject + optional constraints), NOT the raw user sentence; for a multi-step task (e.g. implement, then review, then trace logic) call this once per step. The result includes `selectionStatus`: use `selected` directly only when it is `confident`; when it is `needs_inspection`, treat `selected` as a tentative top-ranked candidate and inspect `guidance.inspectionTargets` or call `skill_context` before using it; when it is `no_candidate`, inspect the scan root or refine the query. The result may include a `guidance` object when workItem is missing, input quality is low, candidate confidence is low, or top candidates are close (reason one of missing_work_item | no_candidate | query_too_long | missing_subject | top1_confidence_low | top1_gap_small, with optional secondaryReasons): follow its `checklist` to re-analyze the task and call again. After a confident selection, call `skill_context` for the chosen skill to get its methods, policy, and resources.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Scan root directory whose indexed skills are searched." },
        query: {
          type: "string",
          description: "Analyzed routing terms: intent verb + discriminative subject + optional constraints. Avoid raw user sentences and filler words.",
        },
        workItem: {
          type: "object",
          description: "The agent's analysis of the concrete thing being handled in this step. Required for controlled-agent routing.",
          properties: {
            subject: {
              type: "string",
              description: "Concrete object under work, such as a module, error, feature, config, skill, or code path.",
            },
          },
          required: ["subject"],
        },
        limit: { type: "number", description: "Maximum candidates to consider before selection (default 5)." },
      },
      required: ["path", "query", "workItem"],
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
  const lease = await attachMcpRuntimeLease();
  const cleanupLease = registerMcpLeaseCleanup(lease);
  const server = new Server(
    {
      name: "cobweb",
      version: "0.4.1",
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

  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await cleanupLease();
    throw error;
  }
}

export async function attachMcpRuntimeLease(): Promise<DaemonLeaseHandle> {
  await ensureDaemonRunning();
  return openDaemonLease({
    client: "mcp",
    pid: process.pid,
    transport: "stdio",
    ttlMs: MCP_LEASE_TTL_MS,
  });
}

export function registerMcpLeaseCleanup(lease: DaemonLeaseHandle, detachTimeoutMs = MCP_LEASE_DETACH_TIMEOUT_MS): () => Promise<void> {
  const heartbeat = setInterval(() => {
    void lease.heartbeat().catch(() => {
      // The next tool call will surface daemon availability; lease TTL protects cleanup.
    });
  }, MCP_LEASE_HEARTBEAT_MS);
  heartbeat.unref();

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    clearInterval(heartbeat);
    process.stdin.off("close", onStdinClose);
    process.stdin.off("end", onStdinEnd);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await detachLeaseBestEffort(lease, detachTimeoutMs);
  };

  const onStdinClose = () => {
    void cleanup();
  };
  const onStdinEnd = () => {
    void cleanup();
  };
  const onSigint = () => {
    void cleanup().finally(() => {
      process.exit(130);
    });
  };
  const onSigterm = () => {
    void cleanup().finally(() => {
      process.exit(143);
    });
  };

  process.stdin.once("close", onStdinClose);
  process.stdin.once("end", onStdinEnd);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return cleanup;
}

async function detachLeaseBestEffort(lease: DaemonLeaseHandle, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const detach = lease.detach().catch(() => {
    lease.close();
  });
  const timeoutFallback = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      // The control socket is lease-bound, so closing it is enough for daemon-side cleanup.
      lease.close();
      resolve();
    }, timeoutMs);
    timeout.unref();
  });

  await Promise.race([detach, timeoutFallback]);
  if (timeout) {
    clearTimeout(timeout);
  }
}

export async function dispatchMcpTool(name: ToolName, args: unknown): Promise<unknown> {
  switch (name) {
    case "status":
      return callDaemonForMcp("status", undefined);
    case "scan":
      return callDaemonForMcp("scan", expectArgs<DaemonMethods["scan"]["params"]>(args));
    case "skill_graph":
      return callDaemonForMcp("skill_graph", expectArgs<DaemonMethods["skill_graph"]["params"]>(args));
    case "skill_chain":
      return callDaemonForMcp("skill_chain", expectArgs<DaemonMethods["skill_chain"]["params"]>(args));
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
  return callDaemon(method, params);
}

function expectArgs<T>(value: unknown): T {
  if (!value || typeof value !== "object") {
    throw new Error("Tool arguments must be an object.");
  }
  return value as T;
}
