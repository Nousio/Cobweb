import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "../hash.js";
import type { AuditResult, ParsedSkill } from "../types.js";
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
    const skillId = sha256(skill.rootPath);
    const updatedAt = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
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

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

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
