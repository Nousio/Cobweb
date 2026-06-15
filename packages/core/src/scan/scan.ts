import fg from "fast-glob";
import { dirname, resolve } from "node:path";
import { parseSkillDirectory } from "../parser/skill-parser.js";
import type { ScanResult, SkillCandidate } from "../types.js";

export interface ScanOptions {
  cwd?: string;
  includeHidden?: boolean;
}

export async function findSkillDirectories(path: string, options: ScanOptions = {}): Promise<string[]> {
  const root = resolve(options.cwd ?? process.cwd(), path);
  const skillFiles = await fg("**/SKILL.md", {
    cwd: root,
    absolute: true,
    dot: options.includeHidden ?? true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
  });

  return skillFiles.sort().map((skillFile) => dirname(skillFile));
}

export async function scanSkills(path: string, options: ScanOptions = {}): Promise<ScanResult> {
  const warnings: string[] = [];
  const skillRoots = await findSkillDirectories(path, options);

  const candidates: SkillCandidate[] = [];

  for (const skillRoot of skillRoots) {
    try {
      const parsed = await parseSkillDirectory(skillRoot);

      candidates.push({
        path: skillRoot,
        kind: "skill_dir",
        name: parsed.name,
        description: parsed.description,
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
