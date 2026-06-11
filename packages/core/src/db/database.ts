import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { auditParsedSkill } from "../audit/audit.js";
import { readCobwebLockfile } from "../canonical/lockfile.js";
import { sha256 } from "../hash.js";
import { parseSkillDirectory } from "../parser/skill-parser.js";
import type { AuditResult, ParsedSkill, ProjectionResult } from "../types.js";
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
}

export interface BulkImportOptions {
  chunkSize?: number;
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
    return this.bulkUpsertSkills(records, options);
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
}

function booleanToSql(value: boolean | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  return value ? 1 : 0;
}
