import { afterEach, describe, expect, it, vi } from "vitest";

const callDaemon = vi.fn();

vi.mock("@cobweb/daemon/client", () => ({
  callDaemon: (...args: unknown[]) => callDaemon(...args),
}));

const { dispatchMcpTool, mcpTools } = await import("./mcp-server.js");

afterEach(() => {
  callDaemon.mockReset();
});

describe("MCP server tool dispatch", () => {
  it("lists phase-one and validation tools", () => {
    expect(mcpTools.map((tool) => tool.name)).toContain("skill_validate");
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
});
