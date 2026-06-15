import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSkillDirectory, parseSkillMarkdown } from "../../../packages/core/src/parser/skill-parser.js";

const fixturesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/skills");

describe("parseSkillMarkdown", () => {
  it("extracts frontmatter and flags escaping resources", () => {
    const parsed = parseSkillMarkdown(
      "/tmp/skill",
      `---
name: review
description: Review code
---

# Review

Read [outside](../secret.md).
`,
    );

    expect(parsed.name).toBe("review");
    expect(parsed.description).toBe("Review code");
    expect(parsed.resources[0]?.escapesRoot).toBe(true);
  });

  it("falls back to body content when frontmatter description is missing", () => {
    const parsed = parseSkillMarkdown(
      "/tmp/skill",
      `---
name: workflow
---

# Workflow

Use this skill when working on focused repository changes.
`,
    );

    expect(parsed.description).toBe("Use this skill when working on focused repository changes.");
    expect(parsed.warnings).not.toContain("missing frontmatter.description");
  });

  it("records sections and policy flags", () => {
    const parsed = parseSkillMarkdown(
      "/tmp/skill",
      `---
name: policy
description: Policy skill
self-contained: true
implicit-invocation: false
---

Intro paragraph before any heading.

# Heading One

Body text.
`,
    );

    expect(parsed.policy.selfContained).toBe(true);
    expect(parsed.policy.implicitInvocation).toBe(false);
    expect(parsed.sections[0]?.title).toBe("root");
    expect(parsed.sections.some((s) => s.title === "Heading One")).toBe(true);
    expect(parsed.body).toContain("Intro paragraph");
  });

  it("extracts method summaries from actionable sections", () => {
    const parsed = parseSkillMarkdown(
      "/tmp/skill",
      `---
name: review
description: Review changed files
---

# Usage

Review changed files before merge.

Inputs: repo path

Outputs: review notes

Tools: git, rg
`,
    );

    expect(parsed.methodSummaries[0]).toMatchObject({
      methodName: "usage",
      summary: "Review changed files before merge.",
      inputs: ["repo path"],
      outputs: ["review notes"],
      requiredTools: ["git", "rg"],
    });
    expect(parsed.methodSummaries[0]?.triggerTerms).toContain("review");
  });

  it("extracts method summaries from heading variants and removes duplicates", () => {
    const parsed = parseSkillMarkdown(
      "/tmp/skill",
      `---
name: workflow
description: Workflow skill
---

# Procedure

Run the same workflow.

# 流程

Run the same workflow.

# Background

This section should not become a method when actionable headings exist.
`,
    );

    expect(parsed.methodSummaries).toHaveLength(1);
    expect(parsed.methodSummaries[0]?.methodName).toBe("procedure");
  });

  it("falls back to one conservative summary without an actionable heading", () => {
    const parsed = parseSkillMarkdown(
      "/tmp/skill",
      `---
name: fallback
description: Fallback skill
---

# Overview

This skill explains when to inspect repository changes before a release. It has a long enough body to be summarized without inventing behavior.

# Notes

Additional notes should not create a second method.
`,
    );

    expect(parsed.methodSummaries).toHaveLength(1);
    expect(parsed.methodSummaries[0]).toMatchObject({
      methodName: "overview",
      extractionConfidence: 0.65,
    });
  });

  it("ignores empty actionable sections", () => {
    const parsed = parseSkillMarkdown(
      "/tmp/skill",
      `---
name: empty
description: Empty section skill
---

# Workflow

# Overview

Use the overview when workflow content is missing.
`,
    );

    expect(parsed.methodSummaries).toHaveLength(1);
    expect(parsed.methodSummaries[0]?.methodName).toBe("overview");
  });

  it("detects local script references but ignores URLs", () => {
    const parsed = parseSkillMarkdown(
      "/tmp/skill",
      `---
name: scripts
description: Scripts skill
---

\`\`\`bash
./scripts/run.sh
curl https://example.com
\`\`\`
`,
    );

    const scriptRefs = parsed.resources.filter((r) => r.mentionedBy === "script-reference");
    expect(scriptRefs.map((r) => r.path)).toContain("./scripts/run.sh");
    expect(scriptRefs.some((r) => r.path.startsWith("http"))).toBe(false);
  });

  it("detects image and frontmatter resources", () => {
    const parsed = parseSkillMarkdown(
      "/tmp/skill",
      `---
name: assets
description: Assets skill
icon: ./icon.png
---

![diagram](./diagram.png)
`,
    );

    expect(parsed.resources.some((r) => r.mentionedBy === "image" && r.path === "./diagram.png")).toBe(true);
    expect(parsed.resources.some((r) => r.mentionedBy === "frontmatter" && r.path === "./icon.png")).toBe(true);
  });

  it("parses an Agent Skills fixture with bundled resource references", async () => {
    const parsed = await parseSkillDirectory(resolve(fixturesRoot, "agentskills-basic"));
    expect(parsed.name).toBe("agentskills-basic");
    expect(parsed.description).toContain("Agent Skills package");
    expect(parsed.frontmatter.metadata).toEqual({ category: "fixture" });
    expect(parsed.methodSummaries[0]?.methodName).toBe("instructions");
    expect(parsed.resources.map((resource) => resource.path)).toEqual(
      expect.arrayContaining(["./references/guide.md", "./assets/icon.svg", "./scripts/validate.sh"]),
    );
  });

  it("records standard resource directories without indexing Codex sidecars", async () => {
    const parsed = await parseSkillDirectory(resolve(fixturesRoot, "agentskills-standard-resources"));

    expect(parsed.methodSummaries[0]?.methodName).toBe("when-to-use");
    expect(parsed.resources.map((resource) => resource.path)).toEqual(
      expect.arrayContaining(["./scripts/run.sh", "./references/guide.md", "./assets/icon.svg"]),
    );
    expect(parsed.resources.some((resource) => resource.path.includes("agents/openai.yaml"))).toBe(false);
    expect(parsed.resources.filter((resource) => resource.mentionedBy === "standard-resource")).toHaveLength(3);
    expect(parsed.warnings).toEqual(
      expect.arrayContaining([
        "frontmatter.allowed-tools should be an array when provided",
        "frontmatter.disable-model-invocation should be boolean when provided",
        "frontmatter.license should be string when provided",
      ]),
    );
  });

  it("falls back to the directory name and warns when frontmatter is missing", () => {
    const parsed = parseSkillMarkdown("/tmp/my-skill", "# No frontmatter\n\nBody.\n");
    expect(parsed.name).toBe("my-skill");
    expect(parsed.description).toBe("Body.");
    expect(parsed.warnings).toContain("missing frontmatter.name");
    expect(parsed.warnings).not.toContain("missing frontmatter.description");
  });

  it("flags external markdown links", () => {
    const parsed = parseSkillMarkdown(
      "/tmp/skill",
      `---
name: links
description: Links skill
---

See [docs](https://example.com/docs).
`,
    );

    const external = parsed.resources.find((r) => r.mentionedBy === "markdown-link");
    expect(external?.isExternal).toBe(true);
    expect(external?.escapesRoot).toBe(false);
  });
});
