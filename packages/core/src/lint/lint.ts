import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSkillDirectory } from "../parser/skill-parser.js";
import type { LintFinding, LintResult, ParsedResource, ParsedSkill } from "../types.js";

export interface LintOptions {
  maxDescriptionLength?: number;
  maxBodyLength?: number;
  checkResourceExistence?: boolean;
}

export const defaultLintLimits = {
  maxDescriptionLength: 1024,
  maxBodyLength: 100_000,
} as const;

export async function lintSkillDirectory(rootPath: string, options: LintOptions = {}): Promise<LintResult> {
  return lintParsedSkill(await parseSkillDirectory(rootPath), options);
}

export async function lintParsedSkill(skill: ParsedSkill, options: LintOptions = {}): Promise<LintResult> {
  const findings: LintFinding[] = [];
  const maxDescriptionLength = options.maxDescriptionLength ?? defaultLintLimits.maxDescriptionLength;
  const maxBodyLength = options.maxBodyLength ?? defaultLintLimits.maxBodyLength;

  if (skill.description.length > maxDescriptionLength) {
    findings.push({
      code: "DESCRIPTION_TOO_LONG",
      message: `Skill description is ${skill.description.length} characters; limit is ${maxDescriptionLength}.`,
      severity: "warning",
    });
  }

  if (skill.body.length > maxBodyLength) {
    findings.push({
      code: "BODY_TOO_LONG",
      message: `Skill body is ${skill.body.length} characters; limit is ${maxBodyLength}.`,
      severity: "warning",
    });
  }

  if (options.checkResourceExistence ?? true) {
    findings.push(...(await missingResourceFindings(skill)));
  }

  return {
    valid: findings.every((finding) => finding.severity !== "error"),
    findings,
  };
}

async function missingResourceFindings(skill: ParsedSkill): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];

  for (const resource of skill.resources) {
    if (!shouldCheckResource(resource)) {
      continue;
    }

    const localPath = localResourcePath(resource.path);
    if (!localPath) {
      continue;
    }

    try {
      await access(resolve(skill.rootPath, localPath));
    } catch {
      findings.push({
        code: "MISSING_RESOURCE",
        message: "Local resource reference does not exist under the skill root.",
        severity: "error",
        path: resource.path,
      });
    }
  }

  return findings;
}

function shouldCheckResource(resource: ParsedResource): boolean {
  return !resource.isExternal && !resource.isAbsolute && !resource.escapesRoot;
}

function localResourcePath(path: string): string | null {
  const withoutFragment = path.split("#", 1)[0] ?? "";
  const withoutQuery = withoutFragment.split("?", 1)[0] ?? "";
  const trimmed = withoutQuery.trim();

  if (!trimmed || path.startsWith("#")) {
    return null;
  }

  return trimmed;
}
