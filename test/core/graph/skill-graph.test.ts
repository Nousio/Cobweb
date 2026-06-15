import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSkillGraph } from "../../../packages/core/src/graph/skill-graph.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("buildSkillGraph", () => {
  it("builds contains and reference edges without audit fields", async () => {
    const root = await createGraphFixture();
    const graph = await buildSkillGraph(root);

    expect(graph.root).toBe(root);
    expect(graph.scanRootIsSkill).toBe(false);
    expect(graph.nodes.some((node) => node.kind === "scan_root" && node.relativePath === ".")).toBe(true);
    expect(graph.nodes.filter((node) => node.kind === "skill").map((node) => node.relativePath)).toEqual([
      "parent",
      "parent/child",
      "sibling",
    ]);
    expect(graph.edges.some((edge) => edge.kind === "contains")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "references" && edge.rawPath === "../rules/rules.mdc")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "references_skill" && edge.rawPath === "./child/SKILL.md")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "references" && edge.rawPath === "https://example.com/guide")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "references" && edge.rawPath === "../missing.md" && edge.unresolved)).toBe(true);
    expect(JSON.stringify(graph)).not.toMatch(/audit|risk|blocked/i);
  });

  it("omits external nodes when includeExternal is false", async () => {
    const root = await createGraphFixture();
    const graph = await buildSkillGraph(root, { includeExternal: false });

    expect(graph.nodes.some((node) => node.kind === "external")).toBe(false);
    expect(graph.edges.some((edge) => edge.external)).toBe(false);
  });

  it("detects cycles while enumerating root-to-leaf paths", async () => {
    const root = await createGraphFixture();
    const graph = await buildSkillGraph(root);

    expect(graph.warnings.some((warning) => warning.includes("cycle detected"))).toBe(true);
    expect(graph.paths.length).toBeGreaterThan(0);
  });

  it("marks scanRoot as the root skill when SKILL.md is at the scan root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cobweb-skill-graph-root-"));
    roots.push(root);
    await writeFile(join(root, "SKILL.md"), "---\nname: root-skill\ndescription: Root skill\n---\n\n# Root\n\nBody.\n");

    const graph = await buildSkillGraph(root);

    expect(graph.scanRootIsSkill).toBe(true);
    expect(graph.nodes[0]?.kind).toBe("skill");
    expect(graph.nodes[0]?.name).toBe("root-skill");
  });
});

async function createGraphFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cobweb-skill-graph-"));
  roots.push(root);
  await mkdir(join(root, "parent", "child"), { recursive: true });
  await mkdir(join(root, "sibling"), { recursive: true });
  await mkdir(join(root, "rules"), { recursive: true });
  await writeFile(join(root, "rules", "rules.mdc"), "shared rules\n");
  await writeFile(
    join(root, "parent", "SKILL.md"),
    [
      "---",
      "name: parent",
      "description: Parent skill",
      "---",
      "",
      "# Parent",
      "",
      "Use [rules](../rules/rules.mdc).",
      "Use [child](./child/SKILL.md).",
      "Use [external](https://example.com/guide).",
      "Use [missing](../missing.md).",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "parent", "child", "SKILL.md"),
    "---\nname: child\ndescription: Child skill\n---\n\n# Child\n\nUse [parent](../SKILL.md).\n",
  );
  await writeFile(join(root, "sibling", "SKILL.md"), "---\nname: sibling\ndescription: Sibling skill\n---\n\n# Sibling\n\nBody.\n");
  return root;
}
