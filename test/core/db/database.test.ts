import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importCanonicalSkill } from "../../../packages/core/src/canonical/store.js";
import type { AuditResult, ParsedSkill } from "../../../packages/core/src/types.js";
import { CobwebDatabase } from "../../../packages/core/src/db/database.js";

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

  it("indexes skill body and method summaries for FTS search", async () => {
    const db = await tempDb();
    db.upsertSkill(
      makeSkill("/skills/review", {
        body: "# Workflow\n\nInspect pull request diffs before merge.",
        methodSummaries: [
          {
            methodName: "workflow",
            summary: "Inspect pull request diffs before merge.",
            triggerTerms: ["inspect", "diffs", "merge"],
            inputs: ["repo path"],
            outputs: ["review notes"],
            requiredTools: ["git"],
            sourceSectionRange: { startSection: 0, endSection: 0 },
            extractionConfidence: 0.85,
          },
        ],
      }),
      audit,
    );

    const result = db.searchSkills("diffs");
    expect(result[0]?.name).toBe("review");
    expect(result[0]?.methods[0]?.methodName).toBe("workflow");
    expect(result[0]?.matchReasons.some((reason) => reason.field === "body" || reason.field === "method")).toBe(true);
  });

  it("finds duplicate candidates from the indexed corpus", async () => {
    const db = await tempDb();
    db.upsertSkill(makeSkill("/skills/review", { name: "review", description: "Review pull requests" }), audit);

    const duplicates = db.findDuplicateCandidates(
      makeSkill("/skills/new-review", {
        name: "review",
        description: "Review pull requests before merge",
        contentHash: "new",
      }),
    );

    expect(duplicates[0]?.path).toBe("/skills/review");
    expect(duplicates[0]?.score).toBe(1);
  });

  it("flags high-similarity skills with different names as duplicates", async () => {
    const db = await tempDb();
    db.upsertSkill(
      makeSkill("/skills/pr", { name: "pr reviewer", description: "review pull requests before merge" }),
      audit,
    );

    const duplicates = db.findDuplicateCandidates(
      makeSkill("/skills/code", {
        name: "code reviewer",
        description: "review pull requests before merge",
        contentHash: "code",
      }),
    );

    expect(duplicates[0]?.path).toBe("/skills/pr");
    expect(duplicates[0]?.score).toBeGreaterThanOrEqual(0.35);
  });

  it("does not flag low-similarity matches as duplicates", async () => {
    const db = await tempDb();
    db.upsertSkill(
      makeSkill("/skills/deploy", { name: "deploy infra", description: "terraform pipeline for release" }),
      audit,
    );

    const duplicates = db.findDuplicateCandidates(
      makeSkill("/skills/notes", {
        name: "release notes",
        description: "write release changelog",
        contentHash: "notes",
      }),
    );

    expect(duplicates).toHaveLength(0);
  });

  it("prunes skills removed from a root while keeping other roots", async () => {
    const db = await tempDb();
    const a = db.upsertSkill(makeSkill("/skills/a", { name: "alpha", contentHash: "a" }), audit);
    const b = db.upsertSkill(makeSkill("/skills/b", { name: "beta", contentHash: "b" }), audit);
    db.upsertSkill(makeSkill("/other/c", { name: "gamma", contentHash: "c" }), audit);

    const removed = db.pruneSkillsUnderRoot("/skills", [a.id]);

    expect(removed).toEqual([b.id]);
    expect(db.skillStatus().total).toBe(2);
    expect(db.searchSkills("beta")).toHaveLength(0);
    expect(db.searchSkills("alpha")[0]?.name).toBe("alpha");
    expect(db.searchSkills("gamma")[0]?.name).toBe("gamma");
  });

  it("limits search results to the requested root", async () => {
    const db = await tempDb();
    db.upsertSkill(makeSkill("/skills/a", { name: "shared", description: "review from skills", contentHash: "a" }), audit);
    db.upsertSkill(makeSkill("/other/b", { name: "shared", description: "review from other", contentHash: "b" }), audit);

    const result = db.searchSkills("shared", { root: "/skills" });

    expect(result.map((candidate) => candidate.path)).toEqual(["/skills/a"]);
  });

  it("does not leak sibling roots through LIKE wildcards", async () => {
    const db = await tempDb();
    db.upsertSkill(makeSkill("/repo/my_skills/a", { name: "alpha", description: "review work", contentHash: "a" }), audit);
    db.upsertSkill(makeSkill("/repo/myXskills/b", { name: "beta", description: "review work", contentHash: "b" }), audit);

    const result = db.searchSkills("review", { root: "/repo/my_skills" });

    expect(result.map((candidate) => candidate.path)).toEqual(["/repo/my_skills/a"]);
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
    db.upsertSkill(makeSkill(join(root, "stale"), { name: "stale", contentHash: "stale" }), audit);
    const records = await db.rebuildFromLockfile(lockfilePath);
    expect(records[0]?.name).toBe("rebuild");
    expect(db.skillStatus().total).toBe(1);
    expect(db.searchSkills("stale")).toHaveLength(0);
  });
});
