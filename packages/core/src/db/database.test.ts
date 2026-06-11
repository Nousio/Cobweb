import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importCanonicalSkill } from "../canonical/store.js";
import type { AuditResult, ParsedSkill } from "../types.js";
import { CobwebDatabase } from "./database.js";

const open: CobwebDatabase[] = [];

async function tempDb(): Promise<CobwebDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "cobweb-db-"));
  const db = new CobwebDatabase(join(dir, "nested", "cobweb.db"));
  open.push(db);
  return db;
}

function makeSkill(rootPath: string, overrides: Partial<ParsedSkill> = {}): ParsedSkill {
  return {
    name: "review",
    description: "Review code",
    rootPath,
    frontmatter: { provenance: { source: "test" } },
    rawFrontmatter: "",
    body: "",
    sections: [],
    methodSummaries: [],
    resources: [
      { path: "./helper.sh", isExternal: false, isAbsolute: false, escapesRoot: false, mentionedBy: "script-reference" },
    ],
    policy: { implicitInvocation: true, selfContained: false },
    contentHash: "hash-1",
    warnings: [],
    ...overrides,
  };
}

const audit: AuditResult = { riskLevel: "low", findings: [] };

afterEach(() => {
  while (open.length > 0) {
    open.pop()?.close();
  }
});

describe("CobwebDatabase", () => {
  it("initializes schema and passes integrity check", async () => {
    const db = await tempDb();
    expect(db.integrityCheck()).toBe("ok");
  });

  it("starts with empty skill status", async () => {
    const db = await tempDb();
    expect(db.skillStatus()).toEqual({ total: 0, highRisk: 0, blocked: 0 });
  });

  it("upserts a skill and reports it in status", async () => {
    const db = await tempDb();
    const record = db.upsertSkill(makeSkill("/skills/review"), audit);

    expect(record.name).toBe("review");
    expect(record.riskLevel).toBe("low");
    expect(record.id).toHaveLength(64);
    expect(db.skillStatus().total).toBe(1);
  });

  it("is idempotent for the same root path", async () => {
    const db = await tempDb();
    db.upsertSkill(makeSkill("/skills/review"), audit);
    db.upsertSkill(makeSkill("/skills/review", { description: "Updated" }), audit);

    expect(db.skillStatus().total).toBe(1);
  });

  it("counts high-risk and blocked skills", async () => {
    const db = await tempDb();
    db.upsertSkill(makeSkill("/skills/a"), { riskLevel: "high", findings: [] });
    db.upsertSkill(makeSkill("/skills/b"), { riskLevel: "blocked", findings: [] });
    db.upsertSkill(makeSkill("/skills/c"), { riskLevel: "low", findings: [] });

    const status = db.skillStatus();
    expect(status.total).toBe(3);
    expect(status.highRisk).toBe(1);
    expect(status.blocked).toBe(1);
  });

  it("replaces resources on re-import", async () => {
    const db = await tempDb();
    db.upsertSkill(
      makeSkill("/skills/review", {
        resources: [
          { path: "./a.sh", isExternal: false, isAbsolute: false, escapesRoot: false, mentionedBy: "script-reference" },
          { path: "./b.sh", isExternal: false, isAbsolute: false, escapesRoot: false, mentionedBy: "script-reference" },
        ],
      }),
      audit,
    );
    db.upsertSkill(
      makeSkill("/skills/review", {
        resources: [
          { path: "./c.sh", isExternal: false, isAbsolute: false, escapesRoot: false, mentionedBy: "script-reference" },
        ],
      }),
      audit,
    );

    expect(db.skillStatus().total).toBe(1);
    expect(db.integrityCheck()).toBe("ok");
  });

  it("bulk imports skills in chunks and checkpoints WAL", async () => {
    const db = await tempDb();
    const records = db.bulkUpsertSkills(
      [
        { skill: makeSkill("/skills/bulk-a", { name: "a", contentHash: "a" }), audit },
        { skill: makeSkill("/skills/bulk-b", { name: "b", contentHash: "b" }), audit },
      ],
      { chunkSize: 1 },
    );

    expect(records).toHaveLength(2);
    expect(db.skillStatus().total).toBe(2);
    expect(db.checkpointWal()).toContain("checkpointed");
  });

  it("rebuilds from canonical skills listed in the lockfile", async () => {
    const root = await mkdtemp(join(tmpdir(), "cobweb-rebuild-"));
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: rebuild\ndescription: Rebuild skill\n---\n\n# Body\n");

    const lockfilePath = join(root, "cobweb.lock.yaml");
    await importCanonicalSkill(source, { canonicalDir: join(root, "canonical"), lockfilePath });

    const db = await tempDb();
    const records = await db.rebuildFromLockfile(lockfilePath);
    expect(records[0]?.name).toBe("rebuild");
    expect(db.skillStatus().total).toBe(1);
  });
});
