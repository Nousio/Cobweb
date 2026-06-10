import fg from "fast-glob";
import { dirname, resolve } from "node:path";
import { auditParsedSkill } from "../audit/audit.js";
import { parseSkillDirectory } from "../parser/skill-parser.js";
import type { ScanResult, SkillCandidate } from "../types.js";

export interface ScanOptions {
  cwd?: string;
  includeHidden?: boolean;
}

export async function scanSkills(path: string, options: ScanOptions = {}): Promise<ScanResult> {
  const root = resolve(options.cwd ?? process.cwd(), path);
  const warnings: string[] = [];
  const skillFiles = await fg("**/SKILL.md", {
    cwd: root,
    absolute: true,
    dot: options.includeHidden ?? true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
  });

  const candidates: SkillCandidate[] = [];

  for (const skillFile of skillFiles.sort()) {
    const skillRoot = dirname(skillFile);
    try {
      const parsed = await parseSkillDirectory(skillRoot);
      const audit = auditParsedSkill(parsed);

      candidates.push({
        path: skillRoot,
        kind: "skill_dir",
        name: parsed.name,
        description: parsed.description,
        riskLevel: audit.riskLevel,
        duplicateOf: null,
        warnings: parsed.warnings,
      });
    } catch (error) {
      warnings.push(`${skillRoot}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  markDuplicateNames(candidates);

  return { candidates, warnings };
}

function markDuplicateNames(candidates: SkillCandidate[]): void {
  const firstByName = new Map<string, SkillCandidate>();

  for (const candidate of candidates) {
    const key = candidate.name.toLowerCase();
    const first = firstByName.get(key);
    if (first) {
      candidate.duplicateOf = first.path;
      continue;
    }
    firstByName.set(key, candidate);
  }
}
