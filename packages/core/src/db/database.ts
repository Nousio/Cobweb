import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { auditParsedSkill } from "../audit/audit.js";
import { readCobwebLockfile } from "../canonical/lockfile.js";
import { jaccardSimilarity, tokenizeText } from "../dedup/similarity.js";
import { sha256 } from "../hash.js";
import { parseSkillDirectory } from "../parser/skill-parser.js";
import type {
  AuditResult,
  DuplicateCandidate,
  ParsedMethodSummary,
  ParsedSkill,
  ProjectionResult,
  SearchMatchField,
  SearchMatchReason,
  SkillSearchCandidate,
} from "../types.js";
import { schemaSql, schemaVersion, sqlitePragmas } from "./schema.js";

export interface DbSkillStatus {
  total: number;
  highRisk: number;
  blocked: number;
}

export interface ImportedSkillRecord {
  id: string;
  name: string;
  contentHash: string;
  riskLevel: string;
  duplicates?: DuplicateCandidate[];
}

export interface BulkImportOptions {
  chunkSize?: number;
}

export interface SkillSearchOptions {
  limit?: number;
  root?: string;
}

interface SearchRow {
  id: string;
  name: string;
  description: string | null;
  root_path: string;
  risk_level: string | null;
  rank: number | null;
  name_snippet: string | null;
  description_snippet: string | null;
  body_snippet: string | null;
  headings_snippet: string | null;
  method_snippet: string | null;
}

export class CobwebDatabase {
  private readonly db: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  integrityCheck(): string {
    const row = this.db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    return row?.integrity_check ?? "unknown";
  }

  checkpointWal(): string {
    const row = this.db.prepare("PRAGMA wal_checkpoint(RESTART)").get() as
      | { busy?: number; log?: number; checkpointed?: number }
      | undefined;
    return JSON.stringify(row ?? {});
  }

  skillStatus(): DbSkillStatus {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN risk_level = 'high' THEN 1 ELSE 0 END) AS highRisk,
          SUM(CASE WHEN risk_level = 'blocked' THEN 1 ELSE 0 END) AS blocked
        FROM skills`,
      )
      .get() as { total?: number; highRisk?: number | null; blocked?: number | null } | undefined;

    return {
      total: row?.total ?? 0,
      highRisk: row?.highRisk ?? 0,
      blocked: row?.blocked ?? 0,
    };
  }

  upsertSkill(skill: ParsedSkill, audit: AuditResult): ImportedSkillRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const record = this.upsertSkillInTransaction(skill, audit);
      this.db.exec("COMMIT");
      return record;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  bulkUpsertSkills(records: Array<{ skill: ParsedSkill; audit: AuditResult }>, options: BulkImportOptions = {}): ImportedSkillRecord[] {
    const chunkSize = options.chunkSize ?? 50;
    const imported: ImportedSkillRecord[] = [];

    for (let index = 0; index < records.length; index += chunkSize) {
      const chunk = records.slice(index, index + chunkSize);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const record of chunk) {
          imported.push(this.upsertSkillInTransaction(record.skill, record.audit));
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    return imported;
  }

  async rebuildFromLockfile(lockfilePath: string, options: BulkImportOptions = {}): Promise<ImportedSkillRecord[]> {
    const lockfile = await readCobwebLockfile(lockfilePath);
    const records = await Promise.all(
      lockfile.skills.map(async (record) => {
        const skill = await parseSkillDirectory(record.canonicalPath);
        return { skill, audit: auditParsedSkill(skill) };
      }),
    );
    const imported = this.bulkUpsertSkills(records, options);
    this.pruneSkillsOutside(imported.map((record) => record.id));
    return imported;
  }

  searchSkills(query: string, options: SkillSearchOptions = {}): SkillSearchCandidate[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) {
      return [];
    }

    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
    const root = options.root ? normalizePath(options.root).replace(/\/+$/, "") : null;
    const rootClause = root
      ? "AND (REPLACE(s.root_path, char(92), '/') = ? OR REPLACE(s.root_path, char(92), '/') LIKE ? ESCAPE '\\')"
      : "";
    const queryParams = root ? [ftsQuery, root, `${escapeLikePattern(root)}/%`, limit] : [ftsQuery, limit];
    const rows = this.db
      .prepare(
        `SELECT
          s.id,
          s.name,
          s.description,
          s.root_path,
          s.risk_level,
          bm25(skill_search_fts, 0.0, 5.0, 3.0, 1.0, 2.0, 4.0) AS rank,
          snippet(skill_search_fts, 1, '[', ']', '...', 12) AS name_snippet,
          snippet(skill_search_fts, 2, '[', ']', '...', 12) AS description_snippet,
          snippet(skill_search_fts, 3, '[', ']', '...', 12) AS body_snippet,
          snippet(skill_search_fts, 4, '[', ']', '...', 12) AS headings_snippet,
          snippet(skill_search_fts, 5, '[', ']', '...', 12) AS method_snippet
        FROM skill_search_fts
        JOIN skills s ON s.id = skill_search_fts.skill_id
        WHERE skill_search_fts MATCH ?
        ${rootClause}
        ORDER BY rank
        LIMIT ?`,
      )
      .all(...queryParams) as unknown as SearchRow[];

    return rows.map((row) => {
      const matchReasons = matchReasonsForRow(row);
      return {
        path: row.root_path,
        kind: "skill_dir",
        name: row.name,
        description: row.description ?? "",
        riskLevel: riskLevel(row.risk_level),
        duplicateOf: null,
        warnings: [],
        score: scoreSearchRow(row, matchReasons),
        matchReasons,
        methods: this.methodsForSkill(row.id),
      };
    });
  }

  findDuplicateCandidates(skill: ParsedSkill, options: SkillSearchOptions = {}): DuplicateCandidate[] {
    const query = [
      skill.name,
      skill.description,
      skill.body,
      skill.methodSummaries.map((summary) => `${summary.methodName} ${summary.summary}`).join(" "),
    ].join(" ");

    const skillPath = normalizePath(skill.rootPath).replace(/\/+$/, "");

    return this.searchSkills(query, { limit: options.limit ?? 5, root: options.root })
      .filter((candidate) => normalizePath(candidate.path).replace(/\/+$/, "") !== skillPath)
      .map((candidate) => ({
        path: candidate.path,
        name: candidate.name,
        description: candidate.description,
        score: duplicateScore(skill, candidate),
        matchReasons: candidate.matchReasons,
      }))
      .filter((candidate) => candidate.score >= 0.35)
      .sort((left, right) => right.score - left.score)
      .slice(0, options.limit ?? 5);
  }

  pruneSkillsUnderRoot(root: string, keepSkillIds: Iterable<string>): string[] {
    const prefix = normalizePath(root).replace(/\/+$/, "");
    const keep = new Set(keepSkillIds);
    const rows = this.db.prepare("SELECT id, root_path FROM skills").all() as Array<{ id: string; root_path: string }>;
    const staleIds = rows
      .filter((row) => isUnderRoot(normalizePath(row.root_path), prefix) && !keep.has(row.id))
      .map((row) => row.id);

    this.deleteSkills(staleIds);

    return staleIds;
  }

  pruneSkillsOutside(keepSkillIds: Iterable<string>): string[] {
    const keep = new Set(keepSkillIds);
    const rows = this.db.prepare("SELECT id FROM skills").all() as Array<{ id: string }>;
    const staleIds = rows.map((row) => row.id).filter((id) => !keep.has(id));
    this.deleteSkills(staleIds);

    return staleIds;
  }

  recordProjectionInstall(skillRootPath: string, result: ProjectionResult): void {
    const skillId = sha256(skillRootPath);
    this.db
      .prepare(
        `INSERT INTO provider_installs (
          id,
          skill_id,
          provider_name,
          install_path,
          projection_strategy,
          content_hash,
          drift,
          last_sync_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          install_path = excluded.install_path,
          projection_strategy = excluded.projection_strategy,
          content_hash = excluded.content_hash,
          drift = excluded.drift,
          last_sync_at = excluded.last_sync_at`,
      )
      .run(
        sha256(`${skillId}:${result.providerName}:${result.installPath}`),
        skillId,
        result.providerName,
        result.installPath,
        result.strategy,
        result.contentHash,
        result.drift ? 1 : 0,
        result.lastSyncAt,
      );
  }

  private upsertSkillInTransaction(skill: ParsedSkill, audit: AuditResult): ImportedSkillRecord {
    const skillId = sha256(skill.rootPath);
    const updatedAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO skills (
            id,
            name,
            description,
            root_path,
            canonical_path,
            source_type,
            provenance_json,
            paths_json,
            implicit_invocation,
            self_contained,
            trust_level,
            risk_level,
            content_hash,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            canonical_path = excluded.canonical_path,
            provenance_json = excluded.provenance_json,
            paths_json = excluded.paths_json,
            implicit_invocation = excluded.implicit_invocation,
            self_contained = excluded.self_contained,
            risk_level = excluded.risk_level,
            content_hash = excluded.content_hash,
            updated_at = excluded.updated_at`,
      )
      .run(
        skillId,
        skill.name,
        skill.description,
        skill.rootPath,
        skill.rootPath,
        "imported",
        JSON.stringify(skill.frontmatter.provenance ?? null),
        JSON.stringify(skill.resources.map((resource) => resource.path)),
        booleanToSql(skill.policy.implicitInvocation),
        booleanToSql(skill.policy.selfContained),
        null,
        audit.riskLevel,
        skill.contentHash,
        updatedAt,
      );

    this.db.prepare("DELETE FROM resources WHERE skill_id = ?").run(skillId);
    const insertResource = this.db.prepare(
      `INSERT INTO resources (
          id,
          skill_id,
          resource_type,
          path,
          is_external,
          risk_flags_json,
          content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const resource of skill.resources) {
      insertResource.run(
        randomUUID(),
        skillId,
        resource.mentionedBy,
        resource.path,
        resource.isExternal ? 1 : 0,
        JSON.stringify({
          escapesRoot: resource.escapesRoot,
          isAbsolute: resource.isAbsolute,
        }),
        null,
      );
    }

    this.db.prepare("DELETE FROM audit_results WHERE skill_id = ?").run(skillId);
    this.db
      .prepare(
        `INSERT INTO audit_results (
            id,
            skill_id,
            risk_level,
            findings_json,
            audited_at
          ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), skillId, audit.riskLevel, JSON.stringify(audit.findings), updatedAt);

    this.upsertMethodsInTransaction(skillId, skill.methodSummaries);
    this.upsertSearchIndexInTransaction(skillId, skill);

    return {
      id: skillId,
      name: skill.name,
      contentHash: skill.contentHash,
      riskLevel: audit.riskLevel,
    };
  }

  private initialize(): void {
    for (const pragma of sqlitePragmas) {
      this.db.exec(pragma);
    }
    for (const statement of schemaSql) {
      this.db.exec(statement);
    }
    this.db
      .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(schemaVersion, new Date().toISOString());
  }

  private upsertMethodsInTransaction(skillId: string, methods: ParsedMethodSummary[]): void {
    this.db.prepare("DELETE FROM methods WHERE skill_id = ?").run(skillId);
    const insertMethod = this.db.prepare(
      `INSERT INTO methods (
        id,
        skill_id,
        method_name,
        summary,
        trigger_terms_json,
        inputs_json,
        outputs_json,
        required_tools_json,
        start_section,
        end_section,
        extraction_confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const method of methods) {
      insertMethod.run(
        randomUUID(),
        skillId,
        method.methodName,
        method.summary,
        JSON.stringify(method.triggerTerms),
        JSON.stringify(method.inputs),
        JSON.stringify(method.outputs),
        JSON.stringify(method.requiredTools),
        method.sourceSectionRange.startSection,
        method.sourceSectionRange.endSection,
        method.extractionConfidence,
      );
    }
  }

  private deleteSkills(skillIds: string[]): void {
    if (skillIds.length === 0) {
      return;
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const deleteFts = this.db.prepare("DELETE FROM skill_search_fts WHERE skill_id = ?");
      const deleteSkill = this.db.prepare("DELETE FROM skills WHERE id = ?");
      for (const id of skillIds) {
        deleteFts.run(id);
        deleteSkill.run(id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private upsertSearchIndexInTransaction(skillId: string, skill: ParsedSkill): void {
    this.db.prepare("DELETE FROM skill_search_fts WHERE skill_id = ?").run(skillId);
    this.db
      .prepare(
        `INSERT INTO skill_search_fts (
          skill_id,
          name,
          description,
          body,
          headings,
          method_summary
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        skillId,
        skill.name,
        skill.description,
        skill.body,
        skill.sections.map((section) => section.title).join("\n"),
        skill.methodSummaries.map((summary) => `${summary.methodName}\n${summary.summary}\n${summary.triggerTerms.join(" ")}`).join("\n\n"),
      );
  }

  private methodsForSkill(skillId: string): ParsedMethodSummary[] {
    const rows = this.db
      .prepare(
        `SELECT
          method_name,
          summary,
          trigger_terms_json,
          inputs_json,
          outputs_json,
          required_tools_json,
          start_section,
          end_section,
          extraction_confidence
        FROM methods
        WHERE skill_id = ?
        ORDER BY start_section, method_name`,
      )
      .all(skillId) as Array<{
        method_name: string;
        summary: string;
        trigger_terms_json: string;
        inputs_json: string;
        outputs_json: string;
        required_tools_json: string;
        start_section: number;
        end_section: number;
        extraction_confidence: number;
      }>;

    return rows.map((row) => ({
      methodName: row.method_name,
      summary: row.summary,
      triggerTerms: readJsonArray(row.trigger_terms_json),
      inputs: readJsonArray(row.inputs_json),
      outputs: readJsonArray(row.outputs_json),
      requiredTools: readJsonArray(row.required_tools_json),
      sourceSectionRange: {
        startSection: row.start_section,
        endSection: row.end_section,
      },
      extractionConfidence: row.extraction_confidence,
    }));
  }
}

function booleanToSql(value: boolean | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  return value ? 1 : 0;
}

function toFtsQuery(input: string): string {
  const terms = input
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 16);

  return Array.from(new Set(terms))
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" OR ");
}

function matchReasonsForRow(row: SearchRow): SearchMatchReason[] {
  return [
    snippetReason("name", row.name_snippet),
    snippetReason("description", row.description_snippet),
    snippetReason("body", row.body_snippet),
    snippetReason("heading", row.headings_snippet),
    snippetReason("method", row.method_snippet),
  ].filter((reason): reason is SearchMatchReason => Boolean(reason));
}

function snippetReason(field: SearchMatchField, snippet: string | null): SearchMatchReason | null {
  if (!snippet || !snippet.includes("[")) {
    return null;
  }
  return { field, signal: "fts_match", snippet };
}

function scoreSearchRow(row: SearchRow, reasons: SearchMatchReason[]): number {
  const fieldSignal = Math.min(0.5, reasons.length * 0.12);
  // bm25 returns negative scores where a larger magnitude is more relevant.
  const relevanceBoost = Math.min(0.15, Math.abs(row.rank ?? 0) / 100);
  const riskPenalty = row.risk_level === "blocked" ? 0.35 : row.risk_level === "high" ? 0.2 : 0;
  return Number(Math.min(1, Math.max(0, 0.4 + fieldSignal + relevanceBoost - riskPenalty)).toFixed(3));
}

function duplicateScore(skill: ParsedSkill, candidate: SkillSearchCandidate): number {
  if (skill.name.toLowerCase() === candidate.name.toLowerCase()) {
    return 1;
  }

  const nameDescriptionScore = jaccardSimilarity(
    tokenizeText(`${skill.name} ${skill.description}`),
    tokenizeText(`${candidate.name} ${candidate.description}`),
  );

  const skillMethodText = skill.methodSummaries.map((summary) => `${summary.methodName} ${summary.summary}`).join(" ").trim();
  const candidateMethodText = candidate.methods.map((summary) => `${summary.methodName} ${summary.summary}`).join(" ").trim();
  const methodScore =
    skillMethodText && candidateMethodText
      ? jaccardSimilarity(tokenizeText(skillMethodText), tokenizeText(candidateMethodText))
      : 0;

  return Number(Math.max(nameDescriptionScore, methodScore).toFixed(3));
}

function riskLevel(value: string | null): SkillSearchCandidate["riskLevel"] {
  if (value === "medium" || value === "high" || value === "blocked") {
    return value;
  }
  return "low";
}

function readJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function isUnderRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}
