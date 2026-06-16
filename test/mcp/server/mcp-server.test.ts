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

  it("returns actionable guidance when the daemon is unavailable", async () => {
    callDaemon.mockRejectedValue(new CobwebError("DAEMON_UNAVAILABLE", "Cannot connect to cobwebd"));
    await expect(dispatchMcpTool("status", {})).rejects.toThrow(/cobweb daemon start/);
  });
});
