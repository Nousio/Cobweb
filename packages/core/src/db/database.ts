import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readSkillRouteLockfile } from "../canonical/lockfile.js";
import { jaccardSimilarity, tokenizeText } from "../dedup/similarity.js";
import { sha256 } from "../hash.js";
import { parseSkillDirectory } from "../parser/skill-parser.js";
import { rankSkillCandidate, type TokenSignalWeights } from "../search/rank.js";
import { discriminativeTokens } from "../search/routing-guidance.js";
import { segmentText, tokenizeSearchText } from "../search/segment.js";
import type {
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
}

export interface ImportedSkillRecord {
  id: string;
  name: string;
  contentHash: string;
  duplicates?: DuplicateCandidate[];
}

export interface BulkImportOptions {
  chunkSize?: number;
}

export interface SkillSearchOptions {
  limit?: number;
  root?: string;
  // Agent-declared concrete object of the task (workItem.subject). Feeds the
  // subject_match ranking signal so the core task object guides selection.
  subject?: string;
}

export interface SkillContentHashRecord {
  id: string;
  path: string;
  contentHash: string;
}

export interface SkillRootReconcileResult {
  imported: ImportedSkillRecord[];
  pruned: string[];
}

export interface DbHealthCheck {
  name: string;
  ok: boolean;
  message?: string;
}

interface SearchRow {
  id: string;
  name: string;
  description: string | null;
  root_path: string;
  rank: number | null;
  name_snippet: string | null;
  description_snippet: string | null;
  body_snippet: string | null;
  headings_snippet: string | null;
  method_snippet: string | null;
  indexed_name: string;
  indexed_description: string;
  indexed_body: string;
  indexed_headings: string;
  indexed_method_summary: string;
}

export class SkillRouteDatabase {
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

  quickCheck(): string {
    const row = this.db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    return row?.quick_check ?? "unknown";
  }

  foreignKeyViolations(): number {
    return this.db.prepare("PRAGMA foreign_key_check").all().length;
  }

  schemaHealthChecks(): DbHealthCheck[] {
    const quickCheck = this.quickCheck();
    const foreignKeyViolations = this.foreignKeyViolations();
    const hasMethods = this.objectExists("methods");
    const hasFts = this.objectExists("skill_search_fts");
    const currentSchemaVersion = this.currentSchemaVersion();
    const checks: DbHealthCheck[] = [
      {
        name: "schema_version",
        ok: currentSchemaVersion === schemaVersion,
        message: `current ${currentSchemaVersion}, expected ${schemaVersion}`,
      },
      { name: "sqlite_quick_check", ok: quickCheck === "ok", message: quickCheck },
      {
        name: "sqlite_foreign_keys",
        ok: foreignKeyViolations === 0,
        message: foreignKeyViolations === 0 ? "ok" : `${foreignKeyViolations} violation(s)`,
      },
      { name: "methods_table", ok: hasMethods, message: hasMethods ? "present" : "missing" },
      { name: "skill_search_fts", ok: hasFts, message: hasFts ? "present" : "missing" },
    ];

    if (hasFts) {
      checks.push(this.ftsConsistencyCheck());
    }

    return checks;
  }

  checkpointWal(): string {
    const row = this.db.prepare("PRAGMA wal_checkpoint(RESTART)").get() as
      | { busy?: number; log?: number; checkpointed?: number }
      | undefined;
    return JSON.stringify(row ?? {});
  }

  skillStatus(): DbSkillStatus {
    const row = this.db
      .prepare("SELECT COUNT(*) AS total FROM skills")
      .get() as { total?: number } | undefined;

    return {
      total: row?.total ?? 0,
    };
  }

  listSkillContentHashesUnderRoot(root: string): SkillContentHashRecord[] {
    const prefix = normalizePath(root).replace(/\/+$/, "");
    const rows = this.db
      .prepare("SELECT id, root_path, content_hash FROM skills")
      .all() as Array<{ id: string; root_path: string; content_hash: string }>;

    return rows
      .filter((row) => isUnderRoot(normalizePath(row.root_path), prefix))
      .map((row) => ({
        id: row.id,
        path: row.root_path,
        contentHash: row.content_hash,
      }));
  }

  getRuntimeState<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value_json FROM runtime_state WHERE key = ?").get(key) as
      | { value_json?: string }
      | undefined;
    if (!row?.value_json) {
      return null;
    }
    return JSON.parse(row.value_json) as T;
  }

  setRuntimeState(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO runtime_state (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  deleteRuntimeState(key: string): void {
    this.db.prepare("DELETE FROM runtime_state WHERE key = ?").run(key);
  }

  upsertSkill(skill: ParsedSkill): ImportedSkillRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const record = this.upsertSkillInTransaction(skill);
      this.db.exec("COMMIT");
      return record;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  bulkUpsertSkills(records: ParsedSkill[], options: BulkImportOptions = {}): ImportedSkillRecord[] {
    const chunkSize = options.chunkSize ?? 50;
    const imported: ImportedSkillRecord[] = [];

    for (let index = 0; index < records.length; index += chunkSize) {
      const chunk = records.slice(index, index + chunkSize);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const record of chunk) {
          imported.push(this.upsertSkillInTransaction(record));
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    return imported;
  }

  reconcileSkillRoot(
    root: string,
    records: ParsedSkill[],
    currentSkillPaths: string[],
  ): SkillRootReconcileResult {
    const prefix = normalizePath(root).replace(/\/+$/, "");
    const keep = new Set(currentSkillPaths.map((path) => sha256(path)));
    const imported: ImportedSkillRecord[] = [];

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        imported.push(this.upsertSkillInTransaction(record));
        keep.add(sha256(record.rootPath));
      }

      const rows = this.db.prepare("SELECT id, root_path FROM skills").all() as Array<{ id: string; root_path: string }>;
      const staleIds = rows
        .filter((row) => isUnderRoot(normalizePath(row.root_path), prefix) && !keep.has(row.id))
        .map((row) => row.id);
      this.deleteSkillsInTransaction(staleIds);

      this.db.exec("COMMIT");
      return { imported, pruned: staleIds };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async rebuildFromLockfile(lockfilePath: string, options: BulkImportOptions = {}): Promise<ImportedSkillRecord[]> {
    const lockfile = await readSkillRouteLockfile(lockfilePath);
    const records = await Promise.all(lockfile.skills.map((record) => parseSkillDirectory(record.canonicalPath)));
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
    const recallLimit = Math.max(limit, Math.min(50, Math.max(30, limit * 3)));
    const root = options.root ? normalizePath(options.root).replace(/\/+$/, "") : null;
    const rootClause = root
      ? "AND (REPLACE(s.root_path, char(92), '/') = ? OR REPLACE(s.root_path, char(92), '/') LIKE ? ESCAPE '\\')"
      : "";
    const queryParams = root ? [ftsQuery, root, `${escapeLikePattern(root)}/%`, recallLimit] : [ftsQuery, recallLimit];
    const rows = this.db
      .prepare(
        `SELECT
          s.id,
          s.name,
          s.description,
          s.root_path,
          bm25(skill_search_fts, 0.0, 5.0, 3.0, 1.0, 2.0, 4.0) AS rank,
          snippet(skill_search_fts, 1, '[', ']', '...', 12) AS name_snippet,
          snippet(skill_search_fts, 2, '[', ']', '...', 12) AS description_snippet,
          snippet(skill_search_fts, 3, '[', ']', '...', 12) AS body_snippet,
          snippet(skill_search_fts, 4, '[', ']', '...', 12) AS headings_snippet,
          snippet(skill_search_fts, 5, '[', ']', '...', 12) AS method_snippet,
          skill_search_fts.name AS indexed_name,
          skill_search_fts.description AS indexed_description,
          skill_search_fts.body AS indexed_body,
          skill_search_fts.headings AS indexed_headings,
          skill_search_fts.method_summary AS indexed_method_summary
        FROM skill_search_fts
        JOIN skills s ON s.id = skill_search_fts.skill_id
        WHERE skill_search_fts MATCH ?
        ${rootClause}
        ORDER BY rank
        LIMIT ?`,
      )
      .all(...queryParams) as unknown as SearchRow[];
    const tokenWeights = tokenWeightsForRows(query, rows);

    return rows.map((row) => {
      const matchReasons = matchReasonsForRow(row);
      const methods = this.methodsForSkill(row.id);
      const rank = rankSkillCandidate({
        query,
        name: row.name,
        description: row.description ?? "",
        methods,
        matchReasons,
        bm25Rank: row.rank,
        tokenWeights,
        subject: options.subject,
      });
      return {
        path: row.root_path,
        kind: "skill_dir" as const,
        name: row.name,
        description: row.description ?? "",
        duplicateOf: null,
        warnings: [],
        score: rank.score,
        scoreBreakdown: rank.scoreBreakdown,
        matchReasons,
        methods,
      };
    }).sort((left, right) => right.score - left.score).slice(0, limit);
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

  private upsertSkillInTransaction(skill: ParsedSkill): ImportedSkillRecord {
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
            content_hash,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            canonical_path = excluded.canonical_path,
            provenance_json = excluded.provenance_json,
            paths_json = excluded.paths_json,
            implicit_invocation = excluded.implicit_invocation,
            self_contained = excluded.self_contained,
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
          content_hash
        ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const resource of skill.resources) {
      insertResource.run(
        randomUUID(),
        skillId,
        resource.mentionedBy,
        resource.path,
        resource.isExternal ? 1 : 0,
        null,
      );
    }

    this.upsertMethodsInTransaction(skillId, skill.methodSummaries);
    this.upsertSearchIndexInTransaction(skillId, skill);

    return {
      id: skillId,
      name: skill.name,
      contentHash: skill.contentHash,
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
      this.deleteSkillsInTransaction(skillIds);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private deleteSkillsInTransaction(skillIds: string[]): void {
    if (skillIds.length === 0) {
      return;
    }

    const deleteFts = this.db.prepare("DELETE FROM skill_search_fts WHERE skill_id = ?");
    const deleteSkill = this.db.prepare("DELETE FROM skills WHERE id = ?");
    for (const id of skillIds) {
      deleteFts.run(id);
      deleteSkill.run(id);
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
        segmentText(skill.name),
        segmentText(skill.description),
        segmentText(skill.body),
        segmentText(skill.sections.map((section) => section.title).join("\n")),
        segmentText(skill.methodSummaries.map((summary) => `${summary.methodName}\n${summary.summary}\n${summary.triggerTerms.join(" ")}`).join("\n\n")),
      );
  }

  private objectExists(name: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE name = ? LIMIT 1")
      .get(name) as { present?: number } | undefined;
    return row?.present === 1;
  }

  private currentSchemaVersion(): number {
    const row = this.db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version?: number | null } | undefined;
    return row?.version ?? 0;
  }

  private ftsConsistencyCheck(): DbHealthCheck {
    const row = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM skills) AS skillCount,
          (SELECT COUNT(DISTINCT skill_id) FROM skill_search_fts) AS ftsSkillCount,
          (SELECT COUNT(*)
            FROM skills s
            LEFT JOIN skill_search_fts f ON f.skill_id = s.id
            WHERE f.skill_id IS NULL) AS missingFts,
          (SELECT COUNT(*)
            FROM skill_search_fts f
            LEFT JOIN skills s ON s.id = f.skill_id
            WHERE s.id IS NULL) AS staleFts`,
      )
      .get() as
      | {
        skillCount?: number;
        ftsSkillCount?: number;
        missingFts?: number;
        staleFts?: number;
      }
      | undefined;
    const skillCount = row?.skillCount ?? 0;
    const ftsSkillCount = row?.ftsSkillCount ?? 0;
    const missingFts = row?.missingFts ?? 0;
    const staleFts = row?.staleFts ?? 0;
    const ok = skillCount === ftsSkillCount && missingFts === 0 && staleFts === 0;

    return {
      name: "fts_consistency",
      ok,
      message: ok
        ? `${skillCount} indexed skill(s)`
        : `${missingFts} skill(s) missing FTS rows, ${staleFts} stale FTS row(s); run \`skillroute daemon repair\` or search the affected root to reconcile`,
    };
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
  const terms = tokenizeSearchText(input, 32);

  return Array.from(new Set(terms))
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" OR ");
}

function tokenWeightsForRows(query: string, rows: SearchRow[]): TokenSignalWeights {
  const queryTokens = discriminativeTokens(query);
  if (queryTokens.length === 0 || rows.length <= 1) {
    return {};
  }

  const queryCounts = queryTokenCounts(query);
  const documentFrequency = new Map(queryTokens.map((token) => [token, 0]));
  for (const row of rows) {
    const tokens = new Set(tokenizeSearchText(indexedRowText(row)));
    for (const token of queryTokens) {
      if (tokens.has(token)) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }
  }

  const maxRarity = Math.log(rows.length + 1);
  return Object.fromEntries(queryTokens.map((token) => {
    const frequency = documentFrequency.get(token) ?? 0;
    const rarity = maxRarity > 0 ? Math.log((rows.length + 1) / (frequency + 1)) / maxRarity : 1;
    const queryPenalty = 1 / Math.sqrt(queryCounts.get(token) ?? 1);
    return [token, Number(clamp((0.35 + 0.65 * rarity) * queryPenalty, 0.2, 1).toFixed(3))];
  }));
}

function queryTokenCounts(input: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of segmentText(input).toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/u)) {
    const normalized = token.trim();
    if (normalized.length < 2) {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

function indexedRowText(row: SearchRow): string {
  return [
    row.indexed_name,
    row.indexed_description,
    row.indexed_body,
    row.indexed_headings,
    row.indexed_method_summary,
  ].join("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
