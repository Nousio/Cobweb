import type { DaemonMethods } from "@skillroute/daemon";
import { ensureDaemonRunning } from "@skillroute/daemon";
import { callDaemon, openDaemonLease, type DaemonLeaseHandle } from "@skillroute/daemon/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";

const MCP_LEASE_TTL_MS = 30_000;
const MCP_LEASE_HEARTBEAT_MS = 10_000;
const MCP_LEASE_DETACH_TIMEOUT_MS = 1_000;

type ToolName = keyof Pick<
  DaemonMethods,
  "status" | "scan" | "skill_graph" | "skill_chain" | "skill_search" | "skill_select" | "skill_context" | "skill_validate"
>;

export interface McpServerOptions {
  skillRoots?: string[];
}

type McpToolDefinition = { name: ToolName; description: string; inputSchema: Record<string, unknown> };

const baseMcpTools: McpToolDefinition[] = [
  {
    name: "status",
    description: "Return SkillRoute daemon status.",
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
      "Select the best indexed skill for a query with deterministic score breakdown and SkillGraph chain context. Before calling, analyze the user's task and provide `workItem.subject` for the concrete thing being handled; this is required so SkillRoute can distinguish raw user text from an agent-analyzed routing request, and `subject` now also feeds ranking (candidates covering the core object rank higher), so set it to the real task object, not filler. Pass `query` as analyzed routing terms (intent verb + discriminative subject + optional constraints), NOT the raw user sentence; for a multi-step task (e.g. implement, then review, then trace logic) call this once per step. The result includes `selectionStatus`: use `selected` directly only when it is `confident`; when it is `needs_inspection`, treat `selected` as a tentative top-ranked candidate and inspect `guidance.inspectionTargets` or call `skill_context` before using it; when it is `no_candidate`, inspect the scan root or refine the query. The result may include a `guidance` object when workItem is missing, input quality is low, candidate confidence is low, or top candidates are close (reason one of missing_work_item | no_candidate | query_too_long | missing_subject | top1_confidence_low | top1_gap_small, with optional secondaryReasons): follow its `checklist` to re-analyze the task and call again. After a confident selection, call `skill_context` for the chosen skill to get its methods, policy, and resources.",
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

export function createMcpTools(options: McpServerOptions = {}): McpToolDefinition[] {
  const roots = normalizeSkillRoots(options.skillRoots);
  if (roots.length === 0) {
    return baseMcpTools;
  }

  const optionalPathTools = new Set<ToolName>(["scan", "skill_search", "skill_select"]);
  if (roots.length === 1) {
    optionalPathTools.add("skill_graph");
    optionalPathTools.add("skill_chain");
  }

  return baseMcpTools.map((tool) => {
    if (!optionalPathTools.has(tool.name)) {
      return tool;
    }
    return {
      ...tool,
      description: `${tool.description} If omitted, path defaults to configured skillroute-mcp --path root${roots.length > 1 ? "s" : ""}.`,
      inputSchema: schemaWithOptionalPath(tool.inputSchema),
    };
  });
}

export const mcpTools = createMcpTools();

// Server-level instructions returned in the MCP `initialize` response. Hosts
// surface this as the server's usage guidance, so the agent can self-route to
// SkillRoute without each user adding a manual rule. Keep it about when/how to use
// the tools, not a copy of every tool schema.
export const mcpInstructions = `# SkillRoute — local SKILL.md routing over an indexed skill library

SkillRoute helps you reuse a better-matching local skill instead of reasoning from
scratch. When you start a non-trivial task (implement, refactor, debug, review,
trace logic, or author/validate a skill), check SkillRoute first rather than waiting
to be told.

## When to use

- Starting a task a local skill might already cover: route with \`skill_select\`.
- Exploring what skills exist or why one matched: \`skill_search\`.
- After choosing a skill: load its methods, policy, and resources with \`skill_context\`.
- Authoring or changing a skill: \`skill_validate\`, plus \`skill_graph\` / \`skill_chain\` for topology.
- Multi-step work: route each step separately (e.g. implement, then review).

## How to route (skill_select)

- Analyze the task first. Pass \`query\` as analyzed routing terms (intent verb + discriminative subject + optional constraints), NOT the raw user sentence.
- Always pass \`workItem.subject\`: the concrete object under work (module, error, feature, config, code path). It is required and also feeds ranking.
- Read \`selectionStatus\`:
  - \`confident\`: use \`selected\` directly.
  - \`needs_inspection\`: treat \`selected\` as tentative; follow \`guidance.inspectionTargets\` or call \`skill_context\` before relying on it.
  - \`no_candidate\`: refine the query or inspect the scan root.
- When a \`guidance\` object is returned, follow its checklist and re-route.
- After a confident selection, call \`skill_context\` for the chosen skill before using it.

## Path

- If the server was started with \`--path\`, you may omit the tool \`path\` for \`scan\` / \`skill_search\` / \`skill_select\`; otherwise pass an absolute scan root.
- \`skill_context\` always needs the concrete skill path (use \`selected.path\` from \`skill_select\`).

## Boundaries

- SkillRoute routes local SKILL.md skills. It is not a code index, symbol search, or file reader — use your code tools for that.
- No audit/risk/blocked judgment, no embedding or vector search, no external registry. Ranking is deterministic FTS plus structural signals; semantic judgment stays with you.`;

export async function runMcpServer(options: McpServerOptions = {}): Promise<void> {
  const lease = await attachMcpRuntimeLease();
  const cleanupLease = registerMcpLeaseCleanup(lease);
  const tools = createMcpTools(options);
  const server = new Server(
    {
      name: "skillroute",
      version: "0.4.3",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: mcpInstructions,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name as ToolName;
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const result = await dispatchMcpTool(name, request.params.arguments ?? {}, options);
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

export async function dispatchMcpTool(name: ToolName, args: unknown, options: McpServerOptions = {}): Promise<unknown> {
  switch (name) {
    case "status":
      return callDaemonForMcp("status", undefined);
    case "scan": {
      const params = expectArgs<Partial<DaemonMethods["scan"]["params"]>>(args);
      const roots = resolveToolRoots(name, params.path, options);
      if (roots.length === 1) {
        return callDaemonForMcp("scan", { path: roots[0] });
      }
      return mergeScanResults(await Promise.all(roots.map((path) => callDaemonForMcp("scan", { path }))));
    }
    case "skill_graph": {
      const params = expectArgs<Partial<DaemonMethods["skill_graph"]["params"]>>(args);
      return callDaemonForMcp("skill_graph", { ...params, path: resolveSingleToolRoot(name, params.path, options) });
    }
    case "skill_chain": {
      const params = expectArgs<Partial<DaemonMethods["skill_chain"]["params"]>>(args);
      if (!params.target) {
        throw new Error("skill_chain requires target.");
      }
      return callDaemonForMcp("skill_chain", { ...params, target: params.target, path: resolveSingleToolRoot(name, params.path, options) });
    }
    case "skill_search": {
      const params = expectArgs<Partial<DaemonMethods["skill_search"]["params"]>>(args);
      if (!params.query) {
        throw new Error("skill_search requires query.");
      }
      const query = params.query;
      const roots = resolveToolRoots(name, params.path, options);
      if (roots.length === 1) {
        return callDaemonForMcp("skill_search", { ...params, query, path: roots[0] });
      }
      return mergeSkillSearchResults(
        query,
        await Promise.all(roots.map((path) => callDaemonForMcp("skill_search", { ...params, query, path }))),
        params.limit,
      );
    }
    case "skill_select": {
      const params = expectArgs<Partial<DaemonMethods["skill_select"]["params"]>>(args);
      if (!params.query) {
        throw new Error("skill_select requires query.");
      }
      const query = params.query;
      const roots = resolveToolRoots(name, params.path, options);
      if (roots.length === 1) {
        return callDaemonForMcp("skill_select", { ...params, query, path: roots[0] });
      }
      return mergeSkillSelectResults(
        await Promise.all(roots.map((path) => callDaemonForMcp("skill_select", { ...params, query, path }))),
      );
    }
    case "skill_context": {
      const params = expectArgs<Partial<DaemonMethods["skill_context"]["params"]>>(args);
      if (!params.path) {
        throw new Error("skill_context requires path to the selected skill.");
      }
      return callDaemonForMcp("skill_context", { path: params.path });
    }
    case "skill_validate": {
      const params = expectArgs<Partial<DaemonMethods["skill_validate"]["params"]>>(args);
      if (!params.path) {
        throw new Error("skill_validate requires path to the skill directory.");
      }
      return callDaemonForMcp("skill_validate", { path: params.path });
    }
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

function normalizeSkillRoots(paths: string[] | undefined): string[] {
  const roots = (paths ?? []).map((path) => path.trim()).filter(Boolean).map((path) => resolve(path));
  return Array.from(new Set(roots));
}

function resolveToolRoots(toolName: ToolName, path: string | undefined, options: McpServerOptions): string[] {
  if (path) {
    return [path];
  }
  const roots = normalizeSkillRoots(options.skillRoots);
  if (roots.length === 0) {
    throw new Error(`${toolName} requires path unless skillroute-mcp is started with --path.`);
  }
  return roots;
}

function resolveSingleToolRoot(toolName: ToolName, path: string | undefined, options: McpServerOptions): string {
  const roots = resolveToolRoots(toolName, path, options);
  if (roots.length !== 1) {
    throw new Error(`${toolName} requires an explicit path when skillroute-mcp has multiple --path entries.`);
  }
  return roots[0]!;
}

function schemaWithOptionalPath(schema: Record<string, unknown>): Record<string, unknown> {
  const required = Array.isArray(schema.required) ? schema.required.filter((item) => item !== "path") : undefined;
  return required && required.length > 0 ? { ...schema, required } : { ...schema, required: undefined };
}

function mergeScanResults(results: Array<DaemonMethods["scan"]["result"]>): DaemonMethods["scan"]["result"] {
  return {
    candidates: results.flatMap((result) => result.candidates),
    warnings: results.flatMap((result) => result.warnings),
  };
}

function mergeSkillSearchResults(
  query: string,
  results: Array<DaemonMethods["skill_search"]["result"]>,
  limit: number | undefined,
): DaemonMethods["skill_search"]["result"] {
  const candidates = results.flatMap((result) => result.candidates).sort((left, right) => right.score - left.score);
  return {
    query,
    freshness: mergeFreshness(results.map((result) => result.freshness)),
    candidates: typeof limit === "number" ? candidates.slice(0, limit) : candidates,
    warnings: results.flatMap((result) => result.warnings),
  };
}

function mergeSkillSelectResults(results: Array<DaemonMethods["skill_select"]["result"]>): DaemonMethods["skill_select"]["result"] {
  const ranked = results
    .filter((result) => result.selected)
    .sort((left, right) => (right.selected?.score ?? 0) - (left.selected?.score ?? 0));
  const winner = ranked[0] ?? results[0];
  if (!winner) {
    throw new Error("skill_select did not return a result.");
  }
  const rejected = results.flatMap((result) => [
    ...(result.selected && result.selected.path !== winner.selected?.path
      ? [{ path: result.selected.path, name: result.selected.name, reason: "Lower ranked match from another configured root." }]
      : []),
    ...result.rejected,
  ]);
  return {
    ...winner,
    freshness: mergeFreshness(results.map((result) => result.freshness)),
    rejected: rejected.filter((candidate) => candidate.path !== winner.selected?.path),
  };
}

function mergeFreshness(values: Array<DaemonMethods["skill_search"]["result"]["freshness"]>): DaemonMethods["skill_search"]["result"]["freshness"] {
  if (values.includes("degraded")) {
    return "degraded";
  }
  if (values.includes("rebuilding")) {
    return "rebuilding";
  }
  return "fresh";
}
