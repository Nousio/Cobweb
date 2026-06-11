import type { AuditFinding, AuditResult, ParsedSkill, RiskLevel } from "../types.js";
import { scanTextWithStaticRules } from "./static-rules.js";

export function auditParsedSkill(skill: ParsedSkill): AuditResult {
  const findings: AuditFinding[] = [];
  const searchable = [
    skill.description,
    ...skill.sections.map((section) => `${section.title}\n${section.content}`),
  ].join("\n");

  for (const resource of skill.resources) {
    if (resource.escapesRoot) {
      findings.push({
        code: "RESOURCE_ESCAPES_ROOT",
        message: "Resource reference escapes the skill root.",
        severity: "high",
        path: resource.path,
      });
    } else if (resource.isAbsolute) {
      findings.push({
        code: "ABSOLUTE_RESOURCE_PATH",
        message: "Resource reference uses an absolute path.",
        severity: "medium",
        path: resource.path,
      });
    } else if (resource.isExternal) {
      findings.push({
        code: "EXTERNAL_RESOURCE",
        message: "Skill references an external resource.",
        severity: "medium",
        path: resource.path,
      });
    }
  }

  findings.push(...scanTextWithStaticRules(searchable));

  if (!skill.description) {
    findings.push({
      code: "MISSING_DESCRIPTION",
      message: "Skill frontmatter is missing description.",
      severity: "medium",
    });
  }

  return {
    riskLevel: maxRisk(findings.map((finding) => finding.severity)),
    findings,
  };
}

function maxRisk(levels: RiskLevel[]): RiskLevel {
  if (levels.includes("blocked")) {
    return "blocked";
  }
  if (levels.includes("high")) {
    return "high";
  }
  if (levels.includes("medium")) {
    return "medium";
  }
  return "low";
}
