import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("cobweb graph", () => {
  it("prints a local read-only SkillGraph as JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "cobweb-cli-graph-"));
    roots.push(root);
    await mkdir(join(root, "workflow"), { recursive: true });
    await writeFile(join(root, "workflow", "SKILL.md"), "---\nname: workflow\ndescription: Workflow\n---\n\n# Workflow\n\nBody.\n");

    const { stdout } = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      "packages/cli/src/index.ts",
      "graph",
      root,
    ], { cwd: process.cwd() });
    const result = JSON.parse(stdout) as { nodes: Array<{ kind: string; name?: string }>; edges: Array<{ kind: string }> };

    expect(result.nodes.some((node) => node.kind === "scan_root")).toBe(true);
    expect(result.nodes.some((node) => node.kind === "skill" && node.name === "workflow")).toBe(true);
    expect(result.edges.some((edge) => edge.kind === "contains")).toBe(true);
  });
});
