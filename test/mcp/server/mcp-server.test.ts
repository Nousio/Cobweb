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

const { attachMcpRuntimeLease, dispatchMcpTool, mcpTools, registerMcpLeaseCleanup } = await import(
  "../../../packages/mcp/src/server/mcp-server.js"
);

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

  it("describes the skill_select query contract and guidance", () => {
    const tool = mcpTools.find((candidate) => candidate.name === "skill_select");
    expect(tool?.description).toMatch(/intent verb/);
    expect(tool?.description).toMatch(/workItem\.subject/);
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
