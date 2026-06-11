import matter from "gray-matter";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { parseSkillDirectory } from "../parser/skill-parser.js";
import type { ParsedPolicy, PolicyCheckResult, PolicyFinding } from "../types.js";

export interface PolicyUpdate {
  implicitInvocation?: boolean;
  selfContained?: boolean;
}

export async function checkPolicyAlignment(skillRoot: string): Promise<PolicyCheckResult> {
  const skill = await parseSkillDirectory(skillRoot);
  const findings: PolicyFinding[] = [];
  const cursorDisabled = readBoolean(skill.frontmatter["disable-model-invocation"]);

  if (cursorDisabled !== undefined && skill.policy.implicitInvocation !== undefined) {
    const expectedDisabled = !skill.policy.implicitInvocation;
    if (cursorDisabled !== expectedDisabled) {
      findings.push({
        code: "CURSOR_POLICY_MISMATCH",
        message: "Cursor disable-model-invocation does not match implicit-invocation.",
        path: join(skillRoot, "SKILL.md"),
      });
    }
  }

  const codexPolicy = await readCodexPolicy(skillRoot);
  if (codexPolicy.implicitInvocation !== undefined && skill.policy.implicitInvocation !== undefined) {
    if (codexPolicy.implicitInvocation !== skill.policy.implicitInvocation) {
      findings.push({
        code: "CODEX_POLICY_MISMATCH",
        message: "Codex sidecar implicit invocation does not match SKILL.md.",
        path: join(skillRoot, "agents", "openai.yaml"),
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

export async function updateSkillPolicy(skillRoot: string, update: PolicyUpdate): Promise<ParsedPolicy> {
  const skillPath = join(skillRoot, "SKILL.md");
  const parsed = matter(await readFile(skillPath, "utf8"));

  if (update.implicitInvocation !== undefined) {
    parsed.data["implicit-invocation"] = update.implicitInvocation;
    parsed.data["disable-model-invocation"] = !update.implicitInvocation;
  }
  if (update.selfContained !== undefined) {
    parsed.data["self-contained"] = update.selfContained;
  }

  await writeFile(skillPath, matter.stringify(parsed.content, parsed.data), "utf8");
  await writeCodexPolicy(skillRoot, {
    implicitInvocation: update.implicitInvocation,
    selfContained: update.selfContained,
  });

  return (await parseSkillDirectory(skillRoot)).policy;
}

async function readCodexPolicy(skillRoot: string): Promise<ParsedPolicy> {
  try {
    const value = YAML.parse(await readFile(join(skillRoot, "agents", "openai.yaml"), "utf8")) as
      | Record<string, unknown>
      | null;
    return {
      implicitInvocation: readBoolean(value?.implicit_invocation ?? value?.implicitInvocation),
      selfContained: readBoolean(value?.self_contained ?? value?.selfContained),
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeCodexPolicy(skillRoot: string, policy: ParsedPolicy): Promise<void> {
  const path = join(skillRoot, "agents", "openai.yaml");
  await mkdir(dirname(path), { recursive: true });
  const content = YAML.stringify({
    implicit_invocation: policy.implicitInvocation,
    self_contained: policy.selfContained,
  });
  await writeFile(path, content, "utf8");
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
