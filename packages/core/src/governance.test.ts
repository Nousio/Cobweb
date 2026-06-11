import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCobwebLockfile } from "./canonical/lockfile.js";
import { importCanonicalSkill } from "./canonical/store.js";
import { createMergePlan } from "./merge/merge.js";
import { checkPolicyAlignment, updateSkillPolicy } from "./policy/policy.js";
import { applyProjectionPlan, detectProjectionDrift } from "./projection/projection.js";
import { builtinProviders } from "./providers/provider.js";
import { applyVendorPlan, createVendorPlan } from "./vendor/vendor.js";

async function writeSkill(root: string, name: string, body = "# Usage\n\nRun safely.\n"): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}`, "utf8");
  return dir;
}

describe("core governance helpers", () => {
  it("imports a canonical skill and updates the lockfile", async () => {
    const root = await mkdtemp(join(tmpdir(), "cobweb-governance-"));
    const skill = await writeSkill(root, "review");
    const canonicalDir = join(root, "canonical");
    const lockfilePath = join(root, "cobweb.lock.yaml");

    const record = await importCanonicalSkill(skill, { canonicalDir, lockfilePath });
    const lockfile = await readCobwebLockfile(lockfilePath);
    const canonicalSkill = await readFile(join(record.canonicalPath, "SKILL.md"), "utf8");

    expect(lockfile.skills).toHaveLength(1);
    expect(canonicalSkill).toContain("provenance");
  });

  it("applies copy projections and detects drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "cobweb-projection-"));
    const source = await writeSkill(root, "deploy");
    const provider = builtinProviders().find((candidate) => candidate.name === "agents")!;
    const plan = provider.project(
      {
        id: "1",
        name: "deploy",
        description: "deploy skill",
        rootPath: source,
        canonicalPath: source,
        sourceType: "imported",
        contentHash: (await import("./parser/skill-parser.js")).parseSkillMarkdown(source, await readFile(join(source, "SKILL.md"), "utf8")).contentHash,
        riskLevel: "low",
      },
      { providerName: "agents", projectRoot: root, strategy: "copy" },
    );

    const result = await applyProjectionPlan(plan);
    expect(result.drift).toBe(false);
    await writeFile(join(result.installPath, "SKILL.md"), "changed", "utf8");
    expect(await detectProjectionDrift(plan)).toBe(true);
  });

  it("applies symlink projections", async () => {
    const root = await mkdtemp(join(tmpdir(), "cobweb-link-projection-"));
    const source = await writeSkill(root, "link-skill");
    const provider = builtinProviders().find((candidate) => candidate.name === "agents")!;
    const parsed = (await import("./parser/skill-parser.js")).parseSkillMarkdown(source, await readFile(join(source, "SKILL.md"), "utf8"));
    const plan = provider.project(
      {
        id: "1",
        name: "link-skill",
        description: "link skill",
        rootPath: source,
        canonicalPath: source,
        sourceType: "imported",
        contentHash: parsed.contentHash,
        riskLevel: "low",
      },
      { providerName: "agents", projectRoot: root, strategy: "link" },
    );

    const result = await applyProjectionPlan(plan);
    expect(result.drift).toBe(false);
  });

  it("updates policy and reports aligned sidecars", async () => {
    const root = await mkdtemp(join(tmpdir(), "cobweb-policy-"));
    const skill = await writeSkill(root, "policy");

    await updateSkillPolicy(skill, { implicitInvocation: false, selfContained: true });
    const result = await checkPolicyAlignment(skill);
    expect(result.ok).toBe(true);
  });

  it("creates vendor and merge plans", async () => {
    const root = await mkdtemp(join(tmpdir(), "cobweb-vendor-"));
    await writeFile(join(root, "shared.md"), "shared", "utf8");
    const source = await writeSkill(root, "source", "Read [shared](../shared.md).\n");
    const target = await writeSkill(root, "target");

    const vendor = await createVendorPlan(source);
    expect(vendor.actions[0]?.rewriteTo).toBe("./resources/vendor/shared.md");

    const merge = await createMergePlan(source, target);
    expect(merge.dryRun).toBe(true);
  });

  it("vendors colliding basenames without broad string replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "cobweb-vendor-collide-"));
    await mkdir(join(root, "one"), { recursive: true });
    await mkdir(join(root, "two"), { recursive: true });
    await writeFile(join(root, "one", "config.json"), "one", "utf8");
    await writeFile(join(root, "two", "config.json"), "two", "utf8");
    const source = await writeSkill(
      root,
      "source",
      "Read [one](../one/config.json) and [two](../two/config.json).\nDo not rewrite ../one/config.json.bak.\n",
    );

    const plan = await createVendorPlan(source, false);
    expect(new Set(plan.actions.map((action) => action.rewriteTo)).size).toBe(2);

    await applyVendorPlan(plan);
    const rewritten = await readFile(join(source, "SKILL.md"), "utf8");
    expect(rewritten).toContain("./resources/vendor/config.json");
    expect(rewritten).toContain("./resources/vendor/config-");
    expect(rewritten).toContain("../one/config.json.bak");
  });
});
