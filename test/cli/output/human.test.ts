import { describe, expect, it } from "vitest";
import { formatDaemonStatus, formatDoctorResult } from "../../../packages/cli/src/output/human.js";

describe("formatDaemonStatus", () => {
  it("formats a readable daemon status summary", () => {
    const output = formatDaemonStatus({
      running: true,
      pid: 123,
      socketPath: "/tmp/cobwebd.sock",
      dbPath: "/tmp/cobweb.db",
      db: { total: 2 },
      freshness: "fresh",
      writer: { pending: 0, running: null, recent: [] },
      lastError: null,
      index: {
        roots: [
          {
            root: "/tmp/skills",
            state: "fresh",
            reason: "content_hash_reconciled",
            lastIndexedAt: "2026-06-12T00:00:00.000Z",
            lastIndexError: null,
            lastCheckedAt: "2026-06-12T00:00:01.000Z",
            lastVerifiedAt: "2026-06-12T00:00:00.000Z",
            lastFullReconcileAt: "2026-06-12T00:00:00.000Z",
            lastEventAt: null,
            lastCheckKind: "fast_path",
            pending: false,
            watching: true,
            watcherState: "ready",
            dirty: false,
            fastPathEligible: true,
            inFlight: false,
            stalenessBudgetMs: 2000,
          },
        ],
        watchRoots: ["/tmp/skills"],
        indexedRoots: ["/tmp/skills"],
        pendingRoots: [],
        recent: [],
      },
    });

    expect(output).toContain("Cobweb daemon: running");
    expect(output).toContain("Skills: 2 total");
    expect(output).toContain("Root: /tmp/skills [fresh]");
    expect(output).toContain("watcher=ready");
    expect(output).toContain("Last checked: 2026-06-12T00:00:01.000Z (fast_path)");
    expect(output).toContain("Last verified: 2026-06-12T00:00:00.000Z");
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
