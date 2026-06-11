import { describe, expect, it } from "vitest";
import type { ParsedSkill } from "../types.js";
import { dedupSkills } from "./dedup.js";

function makeSkill(overrides: Partial<ParsedSkill> & { rootPath: string }): ParsedSkill {
  return {
    name: "skill",
    description: "",
    frontmatter: {},
    rawFrontmatter: "",
    body: "",
    sections: [],
    methodSummaries: [],
    resources: [],
    policy: {},
    contentHash: "hash",
    warnings: [],
    ...overrides,
  };
}

describe("dedupSkills", () => {
  it("matches identical content hashes", () => {
    const result = dedupSkills([
      makeSkill({ rootPath: "/a", contentHash: "same" }),
      makeSkill({ rootPath: "/b", contentHash: "same" }),
    ]);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.signal).toBe("content_hash");
    expect(result.matches[0]?.score).toBe(1);
  });

  it("matches identical names case-insensitively", () => {
    const result = dedupSkills([
      makeSkill({ rootPath: "/a", name: "Review", contentHash: "h1" }),
      makeSkill({ rootPath: "/b", name: "review", contentHash: "h2" }),
    ]);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.signal).toBe("name");
  });

  it("matches similar name + description above threshold", () => {
    const result = dedupSkills(
      [
        makeSkill({ rootPath: "/a", name: "alpha review", description: "review pull requests", contentHash: "h1" }),
        makeSkill({ rootPath: "/b", name: "beta review", description: "review pull requests", contentHash: "h2" }),
      ],
      { threshold: 0.5 },
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.signal).toBe("name_description");
    expect(result.matches[0]?.score).toBeGreaterThanOrEqual(0.5);
  });

  it("does not match dissimilar skills below threshold", () => {
    const result = dedupSkills([
      makeSkill({ rootPath: "/a", name: "deploy infra", description: "terraform apply", contentHash: "h1" }),
      makeSkill({ rootPath: "/b", name: "write docs", description: "author markdown guides", contentHash: "h2" }),
    ]);

    expect(result.matches).toHaveLength(0);
  });

  it("treats two empty token sets as full overlap via jaccard", () => {
    const result = dedupSkills([
      makeSkill({ rootPath: "/a", name: "!!!", description: "", contentHash: "h1" }),
      makeSkill({ rootPath: "/b", name: "???", description: "", contentHash: "h2" }),
    ]);

    expect(result.matches[0]?.signal).toBe("name_description");
    expect(result.matches[0]?.score).toBe(1);
  });

  it("matches similar method summaries after name and description differ", () => {
    const result = dedupSkills(
      [
        makeSkill({
          rootPath: "/a",
          name: "alpha",
          description: "first",
          contentHash: "h1",
          methodSummaries: [
            {
              methodName: "review",
              summary: "review pull request changes",
              triggerTerms: [],
              inputs: [],
              outputs: [],
              requiredTools: [],
              sourceSectionRange: { startSection: 0, endSection: 0 },
              extractionConfidence: 0.8,
            },
          ],
        }),
        makeSkill({
          rootPath: "/b",
          name: "beta",
          description: "second",
          contentHash: "h2",
          methodSummaries: [
            {
              methodName: "inspect",
              summary: "review pull request changes",
              triggerTerms: [],
              inputs: [],
              outputs: [],
              requiredTools: [],
              sourceSectionRange: { startSection: 0, endSection: 0 },
              extractionConfidence: 0.8,
            },
          ],
        }),
      ],
      { threshold: 0.5 },
    );

    expect(result.matches[0]?.signal).toBe("method_summary");
  });
});
