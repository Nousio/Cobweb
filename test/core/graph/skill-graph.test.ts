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
    expect(
      graph.edges.some(
        (edge) => edge.kind === "contains" && edge.fromRelativePath === "parent" && edge.toRelativePath === "parent/child",
      ),
    ).toBe(true);
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

  it("marks direct skill reference cycles as invalid and skips them in paths", async () => {
    const root = await createGraphFixture();
    const graph = await buildSkillGraph(root);

    expect(graph.warnings.some((warning) => warning.includes("invalid references_skill cycle"))).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "references_skill" && edge.invalidCycle)).toBe(true);
    expect(graph.paths.length).toBeGreaterThan(0);
  });

  it("marks indirect skill reference cycles as invalid", async () => {
    const root = await createIndirectCycleFixture();
    const graph = await buildSkillGraph(root);

    expect(graph.edges.filter((edge) => edge.kind === "references_skill" && edge.invalidCycle)).toHaveLength(3);
    expect(graph.warnings.filter((warning) => warning.includes("invalid references_skill cycle"))).toHaveLength(3);
  });

  it("truncates path enumeration at the max path count", async () => {
    const root = await createWideFixture();
    const graph = await buildSkillGraph(root, { maxPaths: 2 });

    expect(graph.paths).toHaveLength(2);
    expect(graph.truncated).toBe(true);
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

async function createIndirectCycleFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cobweb-skill-graph-indirect-cycle-"));
  roots.push(root);
  for (const name of ["a", "b", "c"]) {
    await mkdir(join(root, name), { recursive: true });
  }
  await writeFile(join(root, "a", "SKILL.md"), "---\nname: a\ndescription: A\n---\n\n# A\n\nUse [b](../b/SKILL.md).\n");
  await writeFile(join(root, "b", "SKILL.md"), "---\nname: b\ndescription: B\n---\n\n# B\n\nUse [c](../c/SKILL.md).\n");
  await writeFile(join(root, "c", "SKILL.md"), "---\nname: c\ndescription: C\n---\n\n# C\n\nUse [a](../a/SKILL.md).\n");
  return root;
}

async function createWideFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cobweb-skill-graph-wide-"));
  roots.push(root);
  for (const name of ["a", "b", "c"]) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n\n# ${name}\n\nBody.\n`);
  }
  return root;
}
