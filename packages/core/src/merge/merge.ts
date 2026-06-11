import { dedupSkills } from "../dedup/dedup.js";
import { parseSkillDirectory } from "../parser/skill-parser.js";
import type { MergePlan } from "../types.js";

export async function createMergePlan(sourcePath: string, targetPath: string): Promise<MergePlan> {
  const source = await parseSkillDirectory(sourcePath);
  const target = await parseSkillDirectory(targetPath);
  const dedup = dedupSkills([source, target], { threshold: 0.5 });
  const actions = [
    `Keep canonical target: ${target.name}`,
    `Review source sections before manual merge: ${source.sections.map((section) => section.title).join(", ") || "none"}`,
    `Re-run lint and audit after merging content into ${targetPath}`,
  ];

  return {
    sourcePath,
    targetPath,
    dryRun: true,
    actions,
    matches: dedup.matches,
  };
}
