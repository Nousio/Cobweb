import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import YAML from "yaml";
import type { CanonicalSkillRecord, CobwebLockfile } from "../types.js";

export function emptyLockfile(): CobwebLockfile {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    skills: [],
  };
}

export async function readCobwebLockfile(path: string): Promise<CobwebLockfile> {
  try {
    const parsed = YAML.parse(await readFile(path, "utf8")) as Partial<CobwebLockfile> | null;
    return normalizeLockfile(parsed);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return emptyLockfile();
    }
    throw error;
  }
}

export async function writeCobwebLockfile(path: string, lockfile: CobwebLockfile): Promise<void> {
  const normalized = normalizeLockfile(lockfile);
  const tempPath = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, YAML.stringify(normalized), "utf8");
  await rename(tempPath, path);
}

export async function upsertLockfileRecord(path: string, record: CanonicalSkillRecord): Promise<CobwebLockfile> {
  const lockfile = await readCobwebLockfile(path);
  const next: CobwebLockfile = {
    ...lockfile,
    generatedAt: new Date().toISOString(),
    skills: [
      ...lockfile.skills.filter((skill) => skill.id !== record.id && skill.canonicalPath !== record.canonicalPath),
      record,
    ].sort((left, right) => left.name.localeCompare(right.name)),
  };
  await writeCobwebLockfile(path, next);
  return next;
}

function normalizeLockfile(value: Partial<CobwebLockfile> | null | undefined): CobwebLockfile {
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
