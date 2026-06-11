import { cp, lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname } from "node:path";
import { parseSkillDirectory } from "../parser/skill-parser.js";
import type { ProjectionPlan, ProjectionResult } from "../types.js";

export async function applyProjectionPlan(plan: ProjectionPlan): Promise<ProjectionResult> {
  await mkdir(dirname(plan.installPath), { recursive: true });

  if (plan.strategy === "link") {
    await replaceWithSymlink(plan.sourcePath, plan.installPath);
  } else {
    await replaceWithCopy(plan.sourcePath, plan.installPath);
  }

  const drift = await detectProjectionDrift(plan);
  return {
    ...plan,
    written: true,
    drift,
    lastSyncAt: new Date().toISOString(),
  };
}

export async function detectProjectionDrift(plan: ProjectionPlan): Promise<boolean> {
  try {
    if (plan.strategy === "link") {
      const stat = await lstat(plan.installPath);
      if (!stat.isSymbolicLink()) {
        return true;
      }
      return (await readlink(plan.installPath)) !== plan.sourcePath;
    }

    const parsed = await parseSkillDirectory(plan.installPath);
    return parsed.contentHash !== plan.contentHash;
  } catch {
    return true;
  }
}

async function replaceWithSymlink(sourcePath: string, installPath: string): Promise<void> {
  const tempPath = `${installPath}.tmp-${process.pid}`;
  await rm(tempPath, { recursive: true, force: true });
  await symlink(sourcePath, tempPath, "dir");
  await rm(installPath, { recursive: true, force: true });
  await rename(tempPath, installPath);
}

async function replaceWithCopy(sourcePath: string, installPath: string): Promise<void> {
  const tempPath = `${installPath}.tmp-${process.pid}`;
  await rm(tempPath, { recursive: true, force: true });
  await cp(sourcePath, tempPath, { recursive: true, force: true });
  await rm(installPath, { recursive: true, force: true });
  await rename(tempPath, installPath);
}
