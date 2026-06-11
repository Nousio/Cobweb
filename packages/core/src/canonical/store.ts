import matter from "gray-matter";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { sha256 } from "../hash.js";
import { parseSkillDirectory } from "../parser/skill-parser.js";
import type { CanonicalSkill, CanonicalSkillRecord, ParsedSkill } from "../types.js";
import { upsertLockfileRecord } from "./lockfile.js";

export interface CanonicalImportOptions {
  canonicalDir: string;
  lockfilePath: string;
  sourceType?: CanonicalSkill["sourceType"];
}

export async function importCanonicalSkill(skillRoot: string, options: CanonicalImportOptions): Promise<CanonicalSkillRecord> {
  const parsed = await parseSkillDirectory(skillRoot);
  const canonicalPath = join(options.canonicalDir, safeName(parsed.name || basename(skillRoot)));
  const tempPath = await mkdtemp(join(tmpdir(), "cobweb-canonical-"));

  await mkdir(options.canonicalDir, { recursive: true });
  await cp(skillRoot, tempPath, {
    recursive: true,
    force: true,
    filter: (source) => shouldCopySkillPath(skillRoot, source),
  });
  await writePortableProvenance(tempPath, parsed, options.sourceType ?? "imported");
  await rm(canonicalPath, { recursive: true, force: true });
  await cp(tempPath, canonicalPath, { recursive: true, force: true });
  await rm(tempPath, { recursive: true, force: true });

  const canonical = await parseSkillDirectory(canonicalPath);
  const record: CanonicalSkillRecord = {
    id: sha256(canonicalPath),
    name: canonical.name,
    description: canonical.description,
    canonicalPath,
    sourcePath: skillRoot,
    contentHash: canonical.contentHash,
    provenance: readProvenance(canonical),
  };
  await upsertLockfileRecord(options.lockfilePath, record);
  return record;
}

export function canonicalSkillFromRecord(record: CanonicalSkillRecord): CanonicalSkill {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    rootPath: record.sourcePath,
    canonicalPath: record.canonicalPath,
    sourceType: "imported",
    contentHash: record.contentHash,
    riskLevel: "low",
    provenance: record.provenance,
  };
}

async function writePortableProvenance(rootPath: string, source: ParsedSkill, sourceType: CanonicalSkill["sourceType"]): Promise<void> {
  const skillPath = join(rootPath, "SKILL.md");
  const parsed = matter(await readFile(skillPath, "utf8"));
  parsed.data.provenance = {
    ...(typeof parsed.data.provenance === "object" && parsed.data.provenance ? parsed.data.provenance : {}),
    source_type: sourceType,
    source_path: source.rootPath,
    imported_at: new Date().toISOString(),
    source_content_hash: source.contentHash,
  };
  await writeFile(skillPath, matter.stringify(parsed.content, parsed.data), "utf8");
}

function readProvenance(skill: ParsedSkill): Record<string, unknown> | undefined {
  return typeof skill.frontmatter.provenance === "object" && skill.frontmatter.provenance
    ? (skill.frontmatter.provenance as Record<string, unknown>)
    : undefined;
}

function safeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff._-]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  );
}

function shouldCopySkillPath(rootPath: string, sourcePath: string): boolean {
  const rel = relative(rootPath, sourcePath);
  if (!rel) {
    return true;
  }

  const segments = rel.split(/[\\/]+/u);
  return !segments.some((segment) => segment === ".git" || segment === "node_modules");
}
