import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ParsedResource, ParsedSkill } from "../../../packages/core/src/types.js";
import { lintParsedSkill, lintSkillDirectory } from "../../../packages/core/src/lint/lint.js";

function makeSkill(rootPath: string, overrides: Partial<ParsedSkill> = {}): ParsedSkill {
  return {
    name: "skill",
    description: "Short description",
    rootPath,
    frontmatter: {},
    rawFrontmatter: "",
    body: "Short body",
    sections: [],
    methodSummaries: [],
    resources: [],
    policy: {},
    contentHash: "hash",
    warnings: [],
    ...overrides,
  };
}

function resource(overrides: Partial<ParsedResource> & { path: string }): ParsedResource {
  return {
    isExternal: false,
    isAbsolute: false,
    escapesRoot: false,
    mentionedBy: "markdown-link",
    ...overrides,
  };
}

describe("lintParsedSkill", () => {
  it("flags long descriptions and bodies", async () => {
    const result = await lintParsedSkill(
      makeSkill("/tmp/skill", {
        description: "x".repeat(11),
        body: "y".repeat(21),
      }),
      { maxDescriptionLength: 10, maxBodyLength: 20 },
    );

    expect(result.findings.map((finding) => finding.code)).toEqual(["DESCRIPTION_TOO_LONG", "BODY_TOO_LONG"]);
    expect(result.valid).toBe(true);
  });

  it("flags missing local resources under the skill root", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillroute-lint-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "present.md"), "ok");

    const result = await lintParsedSkill(
      makeSkill(root, {
        resources: [
          resource({ path: "./assets/present.md" }),
          resource({ path: "./assets/missing.md" }),
          resource({ path: "https://example.com/doc.md", isExternal: true }),
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ code: "MISSING_RESOURCE", path: "./assets/missing.md" });
  });

  it("lints a parsed skill directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillroute-lint-dir-"));
    await writeFile(
      join(root, "SKILL.md"),
      `---
name: linked
description: Linked skill
---

Read [missing](./missing.md).
`,
    );

    const result = await lintSkillDirectory(root);
    expect(result.findings.some((finding) => finding.code === "MISSING_RESOURCE")).toBe(true);
  });
});
