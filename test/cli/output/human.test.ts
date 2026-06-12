import { describe, expect, it } from "vitest";
import { formatDaemonStatus, formatDoctorResult } from "../../../packages/cli/src/output/human.js";

describe("formatDaemonStatus", () => {
  it("formats a readable daemon status summary", () => {
    const output = formatDaemonStatus({
      running: true,
      pid: 123,
      socketPath: "/tmp/cobwebd.sock",
      dbPath: "/tmp/cobweb.db",
      db: { total: 2, highRisk: 1, blocked: 0 },
      freshness: "fresh",
      writer: { pending: 0, running: null, recent: [] },
      lastError: null,
    });

    expect(output).toContain("Cobweb daemon: running");
    expect(output).toContain("Skills: 2 total, 1 high risk, 0 blocked");
  });
});

describe("formatDoctorResult", () => {
  it("formats doctor checks with status labels", () => {
    const output = formatDoctorResult({
      ok: false,
      checks: [
        { name: "sqlite_integrity", ok: true },
        { name: "fts_consistency", ok: false, message: "rebuild required" },
      ],
    });

    expect(output).toContain("Cobweb doctor: issues found");
    expect(output).toContain("OK sqlite_integrity");
    expect(output).toContain("FAIL fts_consistency - rebuild required");
  });
});
