import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSkills } from "../../../packages/core/src/scan/scan.js";

let root: string;

async function writeSkill(dir: string, name: string, body = "# Body\n\nSafe content.\n"): Promise<void> {
  const skillDir = join(root, dir);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}`);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cobweb-scan-"));
  await writeSkill("alpha", "alpha");
  await writeSkill("beta", "beta");
  await writeSkill("nested/gamma", "alpha"); // duplicate name of alpha
});

afterAll(() => {
  // Temp dir is left for the OS to reclaim; deterministic per-run via mkdtemp.
});

describe("scanSkills", () => {
  it("finds every SKILL.md under the root", async () => {
    const result = await scanSkills(root);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((c) => c.kind === "skill_dir")).toBe(true);
  });

  it("marks the second occurrence of a duplicate name", async () => {
    const result = await scanSkills(root);
    const duplicates = result.candidates.filter((c) => c.duplicateOf !== null);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.name).toBe("alpha");
  });

  it("returns an empty result for a directory without skills", async () => {
    const empty = await mkdtemp(join(tmpdir(), "cobweb-empty-"));
    const result = await scanSkills(empty);
    expect(result.candidates).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("resolves relative paths against an explicit cwd", async () => {
    const result = await scanSkills(".", { cwd: root });
    expect(result.candidates.length).toBeGreaterThanOrEqual(3);
  });
});
