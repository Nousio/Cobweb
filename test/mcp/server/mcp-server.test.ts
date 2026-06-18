import { afterEach, describe, expect, it, vi } from "vitest";
import { CobwebError } from "../../../packages/core/src/errors.js";

const callDaemon = vi.fn();

vi.mock("@cobweb/daemon/client", () => ({
  callDaemon: (...args: unknown[]) => callDaemon(...args),
}));

const { dispatchMcpTool, mcpTools } = await import("../../../packages/mcp/src/server/mcp-server.js");

afterEach(() => {
  callDaemon.mockReset();
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

  it("returns actionable guidance when the daemon is unavailable", async () => {
    callDaemon.mockRejectedValue(new CobwebError("DAEMON_UNAVAILABLE", "Cannot connect to cobwebd"));
    await expect(dispatchMcpTool("status", {})).rejects.toThrow(/cobweb daemon start/);
  });
});
