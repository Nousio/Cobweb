import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const callDaemon = vi.fn();

vi.mock("@cobweb/daemon/client", () => ({
  callDaemon: (...args: unknown[]) => callDaemon(...args),
}));

const { handleShimLine, runStdioShim } = await import("./stdio.js");

afterEach(() => {
  callDaemon.mockReset();
});

describe("handleShimLine", () => {
  it("ignores blank lines", async () => {
    expect(await handleShimLine("   ")).toBeNull();
  });

  it("forwards status to the daemon", async () => {
    callDaemon.mockResolvedValue({ running: true });
    const response = JSON.parse((await handleShimLine('{"id":"1","method":"status"}'))!);

    expect(callDaemon).toHaveBeenCalledWith("status", undefined);
    expect(response).toEqual({ id: "1", ok: true, result: { running: true } });
  });

  it("forwards scan with params", async () => {
    callDaemon.mockResolvedValue({ candidates: [], warnings: [] });
    await handleShimLine('{"id":"2","method":"scan","params":{"path":"."}}');
    expect(callDaemon).toHaveBeenCalledWith("scan", { path: "." });
  });

  it("forwards audit with params", async () => {
    callDaemon.mockResolvedValue({ riskLevel: "low", findings: [] });
    const response = JSON.parse((await handleShimLine('{"id":"3","method":"audit","params":{"path":"x"}}'))!);
    expect(response.ok).toBe(true);
  });

  it("reports an error for unsupported methods", async () => {
    const response = JSON.parse((await handleShimLine('{"id":"4","method":"vendor"}'))!);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("MCP_SHIM_ERROR");
    expect(response.error.message).toMatch(/Unsupported/);
  });

  it("reports an error when params are missing", async () => {
    const response = JSON.parse((await handleShimLine('{"id":"5","method":"scan"}'))!);
    expect(response.ok).toBe(false);
    expect(response.error.message).toMatch(/params/);
  });

  it("reports an error for malformed JSON without crashing", async () => {
    const response = JSON.parse((await handleShimLine("not json"))!);
    expect(response.id).toBe("unknown");
    expect(response.ok).toBe(false);
  });

  it("rejects non-object JSON", async () => {
    const response = JSON.parse((await handleShimLine("123"))!);
    expect(response.ok).toBe(false);
    expect(response.error.message).toMatch(/JSON object/);
  });

  it("surfaces daemon failures", async () => {
    callDaemon.mockRejectedValue(new Error("daemon down"));
    const response = JSON.parse((await handleShimLine('{"id":"6","method":"status"}'))!);
    expect(response.ok).toBe(false);
    expect(response.error.message).toBe("daemon down");
  });
});

describe("runStdioShim", () => {
  it("processes each input line and writes responses", async () => {
    callDaemon.mockResolvedValue({ running: true });

    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });

    const done = runStdioShim({ input, output });
    input.write('{"id":"1","method":"status"}\n');
    input.write("\n");
    input.write('{"id":"2","method":"bogus"}\n');
    input.end();
    await done;

    expect(chunks).toHaveLength(2);
    expect(JSON.parse(chunks[0]!).ok).toBe(true);
    expect(JSON.parse(chunks[1]!).ok).toBe(false);
  });
});
