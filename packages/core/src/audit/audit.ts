import type { AuditFinding, AuditResult, ParsedSkill, RiskLevel } from "../types.js";

const dangerousPatterns: Array<{ code: string; pattern: RegExp; message: string; severity: RiskLevel }> = [
  {
    code: "DANGEROUS_RM_RF",
    pattern: /\brm\s+-rf\s+(?:\/|\$HOME|~)/,
    message: "Dangerous recursive delete command targets a broad path.",
    severity: "blocked",
  },
  {
    code: "CURL_PIPE_SHELL",
    pattern: /\b(?:curl|wget)\b[\s\S]{0,120}\|\s*(?:sh|bash|zsh)\b/,
    message: "External download is piped directly into a shell.",
    severity: "high",
  },
  {
    code: "SECRET_READ",
    pattern: /\b(?:cat|open|pbcopy)\b[\s\S]{0,120}(?:id_rsa|\.ssh|\.env|secret|token|private[_-]?key)/i,
    message: "Script appears to read credentials or secret material.",
    severity: "high",
  },
  {
    code: "SUDO_USAGE",
    pattern: /\bsudo\b/,
    message: "Script uses privilege escalation.",
    severity: "medium",
  },
];

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

  for (const rule of dangerousPatterns) {
    if (rule.pattern.test(searchable)) {
      findings.push({
        code: rule.code,
        message: rule.message,
        severity: rule.severity,
      });
    }
  }

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
