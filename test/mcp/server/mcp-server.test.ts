import { afterEach, describe, expect, it, vi } from "vitest";
import { CobwebError } from "../../../packages/core/src/errors.js";

const callDaemon = vi.fn();
const ensureDaemonRunning = vi.fn();
const openDaemonLease = vi.fn();

vi.mock("@cobweb/daemon", () => ({
  ensureDaemonRunning: (...args: unknown[]) => ensureDaemonRunning(...args),
}));

vi.mock("@cobweb/daemon/client", () => ({
  callDaemon: (...args: unknown[]) => callDaemon(...args),
  openDaemonLease: (...args: unknown[]) => openDaemonLease(...args),
}));

const { attachMcpRuntimeLease, createMcpTools, dispatchMcpTool, mcpInstructions, mcpTools, registerMcpLeaseCleanup } = await import(
  "../../../packages/mcp/src/server/mcp-server.js"
);
const { parseMcpServerOptions, startMcpServerCli } = await import("../../../packages/mcp/src/index.js");

afterEach(() => {
  callDaemon.mockReset();
  ensureDaemonRunning.mockReset();
  openDaemonLease.mockReset();
});

describe("MCP server tool dispatch", () => {
  it("lists phase-one and validation tools", () => {
    expect(mcpTools.map((tool) => tool.name)).toContain("skill_validate");
    expect(mcpTools.map((tool) => tool.name)).toContain("skill_graph");
    expect(mcpTools.map((tool) => tool.name)).toContain("skill_chain");
  });

  it("dispatches status without arguments", async () => {
    callDaemon.mockResolvedValue({ running: true });
    await expect(dispatchMcpTool("status", {})).resolves.toEqual({ running: true });
    expect(callDaemon).toHaveBeenCalledWith("status", undefined);
  });

  it("dispatches skill_validate with arguments", async () => {
    callDaemon.mockResolvedValue({ lint: { valid: true } });
    await dispatchMcpTool("skill_validate", { path: "/skill" });
    expect(callDaemon).toHaveBeenCalledWith("skill_validate", { path: "/skill" });
  });

  it("dispatches skill_search with routing options", async () => {
    callDaemon.mockResolvedValue({ candidates: [] });
    await dispatchMcpTool("skill_search", { path: "/skills", query: "review", limit: 3 });
    expect(callDaemon).toHaveBeenCalledWith("skill_search", { path: "/skills", query: "review", limit: 3 });
  });

  it("parses repeated MCP --path options", () => {
    expect(parseMcpServerOptions(["--path", "/skills/a", "--path=/skills/b"], {})).toEqual({
      skillRoots: ["/skills/a", "/skills/b"],
    });
  });

  it("accepts an array of directories after a single --path", () => {
    expect(parseMcpServerOptions(["--path", "/skills/a", "/skills/b"], {})).toEqual({
      skillRoots: ["/skills/a", "/skills/b"],
    });
  });

  it("rejects an empty or whitespace --path value", () => {
    expect(() => parseMcpServerOptions(["--path", ""], {})).toThrow(/non-empty directory/);
    expect(() => parseMcpServerOptions(["--path", "   "], {})).toThrow(/non-empty directory/);
    expect(() => parseMcpServerOptions(["--path", "/skills/a", ""], {})).toThrow(/non-empty directory/);
    expect(() => parseMcpServerOptions(["--path="], {})).toThrow(/non-empty directory/);
    expect(() => parseMcpServerOptions(["--path=   "], {})).toThrow(/non-empty directory/);
  });

  it("rejects --path with no directory value", () => {
    expect(() => parseMcpServerOptions(["--path"], {})).toThrow(/requires a directory value/);
    expect(() => parseMcpServerOptions(["--path", "--path=/skills"], {})).toThrow(/requires a directory value/);
  });

  it("fails fast without starting the server on an invalid --path", async () => {
    const previousExitCode = process.exitCode;
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await startMcpServerCli(["--path", ""], {});
      expect(process.exitCode).toBe(1);
      expect(ensureDaemonRunning).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("non-empty directory"));
    } finally {
      stderr.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it("makes path optional for configured scan roots", () => {
    const tool = createMcpTools({ skillRoots: ["/skills"] }).find((candidate) => candidate.name === "skill_search");
    expect((tool?.inputSchema as { required?: string[] }).required).toEqual(["query"]);
  });

  it("uses configured single path when tool path is omitted", async () => {
    callDaemon.mockResolvedValue({ candidates: [] });
    await dispatchMcpTool("skill_search", { query: "review" }, { skillRoots: ["/configured-skills"] });
    expect(callDaemon).toHaveBeenCalledWith("skill_search", { query: "review", path: "/configured-skills" });
  });

  it("merges search results across configured paths", async () => {
    callDaemon.mockImplementation(async (_method: string, params: { path: string }) => ({
      query: "review",
      freshness: params.path.endsWith("a") ? "fresh" : "rebuilding",
      candidates: [
        {
          path: `${params.path}/skill`,
          name: params.path.endsWith("a") ? "a" : "b",
          description: "",
          duplicateOf: null,
          warnings: [],
          score: params.path.endsWith("a") ? 0.5 : 0.9,
          scoreBreakdown: [],
          matchReasons: [],
          methods: [],
        },
      ],
      warnings: [`${params.path}: warning`],
    }));

    await expect(dispatchMcpTool("skill_search", { query: "review", limit: 1 }, { skillRoots: ["/skills/a", "/skills/b"] })).resolves.toMatchObject({
      freshness: "rebuilding",
      candidates: [{ name: "b" }],
      warnings: ["/skills/a: warning", "/skills/b: warning"],
    });
    expect(callDaemon).toHaveBeenCalledTimes(2);
  });

  it("selects the highest scoring skill across configured paths", async () => {
    callDaemon.mockImplementation(async (_method: string, params: { path: string }) => {
      const score = params.path.endsWith("a") ? 0.5 : 0.9;
      const candidate = {
        path: `${params.path}/skill`,
        name: params.path.endsWith("a") ? "a" : "b",
        description: "",
        duplicateOf: null,
        warnings: [],
        score,
        scoreBreakdown: [],
        matchReasons: [],
        methods: [],
      };
      return {
        query: "review",
        freshness: "fresh",
        selectionStatus: "confident",
        selected: candidate,
        chain: null,
        recommendation: { reason: "selected", confidence: score },
        rejected: [],
      };
    });

    await expect(dispatchMcpTool("skill_select", { query: "review" }, { skillRoots: ["/skills/a", "/skills/b"] })).resolves.toMatchObject({
      selected: { name: "b" },
      rejected: [{ name: "a" }],
    });
  });

  it("requires explicit graph path when multiple paths are configured", async () => {
    await expect(dispatchMcpTool("skill_graph", {}, { skillRoots: ["/skills/a", "/skills/b"] })).rejects.toThrow(/explicit path/);
  });

  it("describes the skill_select query contract and guidance", () => {
    const tool = mcpTools.find((candidate) => candidate.name === "skill_select");
    expect(tool?.description).toMatch(/intent verb/);
    expect(tool?.description).toMatch(/workItem\.subject/);
    expect(tool?.description).toMatch(/feeds ranking/);
    expect(tool?.description).toMatch(/selectionStatus/);
    expect(tool?.description).toMatch(/needs_inspection/);
    expect(tool?.description).toMatch(/guidance/);
    expect(tool?.description).toMatch(/inspectionTargets/);
    const schema = tool?.inputSchema as {
      required?: string[];
      properties?: { workItem?: { required?: string[]; properties?: Record<string, unknown> } };
    } | undefined;
    expect(schema?.required).toContain("workItem");
    expect(schema?.properties?.workItem?.required).toEqual(["subject"]);
    expect(schema?.properties?.workItem?.properties).not.toHaveProperty("type");
  });

  it("ships server instructions that recommend the routing contract", () => {
    expect(mcpInstructions).toMatch(/skill_select/);
    expect(mcpInstructions).toMatch(/workItem\.subject/);
    expect(mcpInstructions).toMatch(/selectionStatus/);
    expect(mcpInstructions).toMatch(/needs_inspection/);
    expect(mcpInstructions).toMatch(/skill_context/);
    expect(mcpInstructions).toMatch(/analyzed routing terms/);
  });

  it("states boundaries so the agent does not treat Cobweb as a code index", () => {
    expect(mcpInstructions).toMatch(/not a code index/);
    expect(mcpInstructions).toMatch(/No audit/);
    expect(mcpInstructions).toMatch(/no embedding/);
  });

  it("dispatches skill_select with the analyzed work item", async () => {
    callDaemon.mockResolvedValue({ selected: null });
    await dispatchMcpTool("skill_select", {
      path: "/skills",
      query: "debug websocket reconnect",
      workItem: { subject: "websocket reconnect hang" },
      limit: 3,
    });
    expect(callDaemon).toHaveBeenCalledWith("skill_select", {
      path: "/skills",
      query: "debug websocket reconnect",
      workItem: { subject: "websocket reconnect hang" },
      limit: 3,
    });
  });

  it("dispatches skill_graph with graph options", async () => {
    callDaemon.mockResolvedValue({ nodes: [], edges: [] });
    await dispatchMcpTool("skill_graph", { path: "/skills", maxDepth: 4, maxPaths: 10, includeExternal: false, watch: true });
    expect(callDaemon).toHaveBeenCalledWith("skill_graph", {
      path: "/skills",
      maxDepth: 4,
      maxPaths: 10,
      includeExternal: false,
      watch: true,
    });
  });

  it("dispatches skill_chain with graph options", async () => {
    callDaemon.mockResolvedValue({ target: { name: "review" } });
    await dispatchMcpTool("skill_chain", { path: "/skills", target: "review", includeExternal: false });
    expect(callDaemon).toHaveBeenCalledWith("skill_chain", {
      path: "/skills",
      target: "review",
      includeExternal: false,
    });
  });

  it("attaches a runtime lease before serving MCP tools", async () => {
    ensureDaemonRunning.mockResolvedValue({ started: false, alreadyRunning: true });
    openDaemonLease.mockResolvedValue({
      leaseId: "lease-1",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      heartbeat: vi.fn(),
      detach: vi.fn(),
      close: vi.fn(),
    });

    await expect(attachMcpRuntimeLease()).resolves.toMatchObject({ leaseId: "lease-1" });
    expect(ensureDaemonRunning).toHaveBeenCalledWith();
    expect(openDaemonLease).toHaveBeenCalledWith({
      client: "mcp",
      pid: process.pid,
      transport: "stdio",
      ttlMs: 30_000,
    });
  });

  it("does not lazy-start the runtime from individual tool dispatch", async () => {
    callDaemon.mockRejectedValue(new CobwebError("DAEMON_UNAVAILABLE", "Cannot connect to cobwebd"));

    await expect(dispatchMcpTool("status", {})).rejects.toThrow(/Cannot connect to cobwebd/);
    expect(ensureDaemonRunning).not.toHaveBeenCalled();
    expect(openDaemonLease).not.toHaveBeenCalled();
  });

  it("surfaces runtime startup failures during lease attach", async () => {
    ensureDaemonRunning.mockRejectedValue(new Error("missing runtime entrypoint"));

    await expect(attachMcpRuntimeLease()).rejects.toThrow(/missing runtime entrypoint/);
    expect(openDaemonLease).not.toHaveBeenCalled();
  });

  it("closes the lease connection when detach does not finish", async () => {
    const lease = {
      leaseId: "lease-1",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      heartbeat: vi.fn(),
      detach: vi.fn(() => new Promise<void>(() => { })),
      close: vi.fn(),
    };
    const cleanup = registerMcpLeaseCleanup(lease, 5);

    await cleanup();

    expect(lease.detach).toHaveBeenCalledOnce();
    expect(lease.close).toHaveBeenCalledOnce();
  });
});
