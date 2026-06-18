import { describe, expect, it } from "vitest";
import { CobwebError, toErrorMessage } from "../../packages/core/src/errors.js";
import { sha256 } from "../../packages/core/src/hash.js";
import { builtinProviders } from "../../packages/core/src/providers/provider.js";

describe("hash", () => {
  it("computes a stable sha256 hex digest", () => {
    expect(sha256("cobweb")).toBe(sha256("cobweb"));
    expect(sha256("cobweb")).toHaveLength(64);
    expect(sha256("a")).not.toBe(sha256("b"));
  });

  it("hashes buffers", () => {
    expect(sha256(Buffer.from("cobweb"))).toBe(sha256("cobweb"));
  });
});

describe("errors", () => {
  it("preserves code and retryable on CobwebError", () => {
    const error = new CobwebError("BAD", "broken", { retryable: true });
    expect(error.code).toBe("BAD");
    expect(error.retryable).toBe(true);
    expect(error.name).toBe("CobwebError");
  });

  it("defaults retryable to false", () => {
    expect(new CobwebError("X", "y").retryable).toBe(false);
  });

  it("converts unknown errors to messages", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
    expect(toErrorMessage("plain")).toBe("plain");
    expect(toErrorMessage(42)).toBe("42");
  });
});

describe("builtinProviders", () => {
  it("exposes the four phase-one providers", () => {
    const names = builtinProviders().map((p) => p.name);
    expect(names).toEqual(["agents", "cursor", "claude", "codex"]);
  });

  it("detects global paths for cursor and claude only", () => {
    const providers = builtinProviders();
    const cursor = providers.find((p) => p.name === "cursor")!;
    const claude = providers.find((p) => p.name === "claude")!;
    const agents = providers.find((p) => p.name === "agents")!;

    expect(cursor.detectGlobalPaths({ homeDir: "/home/u" })).toEqual(["/home/u/.cursor/skills"]);
    expect(claude.detectGlobalPaths({ homeDir: "/home/u" })).toEqual(["/home/u/.claude/skills"]);
    expect(agents.detectGlobalPaths({ homeDir: "/home/u" })).toEqual([]);
  });

  it("detects project paths", () => {
    const cursor = builtinProviders().find((p) => p.name === "cursor")!;
    expect(cursor.detectProjectPaths("/proj")).toEqual(["/proj/.cursor/skills", "/proj/.agents/skills"]);
  });

  it("projects a canonical skill into an install plan", () => {
    const cursor = builtinProviders().find((p) => p.name === "cursor")!;
    const plan = cursor.project(
      {
        id: "1",
        name: "review",
        description: "d",
        rootPath: "/canon/review",
        canonicalPath: "/canon/review",
        sourceType: "imported",
        contentHash: "hash",
      },
      { providerName: "cursor", projectRoot: "/proj", strategy: "link" },
    );

    expect(plan.providerName).toBe("cursor");
    expect(plan.installPath).toBe("/proj/.cursor/skills/review");
    expect(plan.strategy).toBe("link");
    expect(plan.contentHash).toBe("hash");
  });

  it("falls back to rootPath when canonicalPath is absent", () => {
    const claude = builtinProviders().find((p) => p.name === "claude")!;
    const plan = claude.project(
      {
        id: "2",
        name: "deploy",
        description: "d",
        rootPath: "/src/deploy",
        sourceType: "project",
        contentHash: "h2",
      },
      { providerName: "claude", projectRoot: "/proj", strategy: "copy" },
    );

    expect(plan.sourcePath).toBe("/src/deploy");
    expect(plan.installPath).toBe("/proj/.claude/skills/deploy");
  });
});
