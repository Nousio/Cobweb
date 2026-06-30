import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import YAML from "yaml";
import type { CanonicalSkillRecord, SkillRouteLockfile } from "../types.js";

export function emptyLockfile(): SkillRouteLockfile {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    skills: [],
  };
}

export async function readSkillRouteLockfile(path: string): Promise<SkillRouteLockfile> {
  try {
    const parsed = YAML.parse(await readFile(path, "utf8")) as Partial<SkillRouteLockfile> | null;
    return normalizeLockfile(parsed);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return emptyLockfile();
    }
    throw error;
  }
}

export async function writeSkillRouteLockfile(path: string, lockfile: SkillRouteLockfile): Promise<void> {
  const normalized = normalizeLockfile(lockfile);
  const tempPath = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, YAML.stringify(normalized), "utf8");
  await rename(tempPath, path);
}

export async function upsertLockfileRecord(path: string, record: CanonicalSkillRecord): Promise<SkillRouteLockfile> {
  const lockfile = await readSkillRouteLockfile(path);
  const next: SkillRouteLockfile = {
    ...lockfile,
    generatedAt: new Date().toISOString(),
    skills: [
      ...lockfile.skills.filter((skill) => skill.id !== record.id && skill.canonicalPath !== record.canonicalPath),
      record,
    ].sort((left, right) => left.name.localeCompare(right.name)),
  };
  await writeSkillRouteLockfile(path, next);
  return next;
}

function normalizeLockfile(value: Partial<SkillRouteLockfile> | null | undefined): SkillRouteLockfile {
  return {
    version: 1,
    generatedAt: typeof value?.generatedAt === "string" ? value.generatedAt : new Date().toISOString(),
    skills: Array.isArray(value?.skills) ? value.skills.filter(isRecord) : [],
  };
}

function isRecord(value: unknown): value is CanonicalSkillRecord {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as CanonicalSkillRecord).id === "string" &&
    typeof (value as CanonicalSkillRecord).name === "string" &&
    typeof (value as CanonicalSkillRecord).canonicalPath === "string" &&
    typeof (value as CanonicalSkillRecord).sourcePath === "string" &&
    typeof (value as CanonicalSkillRecord).contentHash === "string",
  );
}
