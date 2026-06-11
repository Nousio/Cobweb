import type { AuditFinding, RiskLevel } from "../types.js";

export interface StaticScannerRule {
  code: string;
  source: "yara-style-static";
  tags: string[];
  patterns: RegExp[];
  condition: "any" | "all";
  message: string;
  severity: RiskLevel;
}

export const matureStaticScannerRules: StaticScannerRule[] = [
  {
    code: "DANGEROUS_RM_RF",
    source: "yara-style-static",
    tags: ["destructive-command", "filesystem"],
    patterns: [/\brm\s+-rf\s+(?:\/|\$HOME|~)/],
    condition: "any",
    message: "Dangerous recursive delete command targets a broad path.",
    severity: "blocked",
  },
  {
    code: "CURL_PIPE_SHELL",
    source: "yara-style-static",
    tags: ["download-exec", "shell"],
    patterns: [/\b(?:curl|wget)\b[\s\S]{0,120}\|\s*(?:sh|bash|zsh)\b/],
    condition: "any",
    message: "External download is piped directly into a shell.",
    severity: "high",
  },
  {
    code: "SECRET_READ",
    source: "yara-style-static",
    tags: ["credential-access", "secret"],
    patterns: [
      /\b(?:cat|open|pbcopy)\b[\s\S]{0,120}(?:id_rsa|\.ssh|\.env|secret|token|private[_-]?key)/i,
      /(?:AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)/,
    ],
    condition: "any",
    message: "Script appears to read credentials or secret material.",
    severity: "high",
  },
  {
    code: "SUDO_USAGE",
    source: "yara-style-static",
    tags: ["privilege-escalation"],
    patterns: [/\bsudo\b/],
    condition: "any",
    message: "Script uses privilege escalation.",
    severity: "medium",
  },
];

export function scanTextWithStaticRules(
  text: string,
  rules: StaticScannerRule[] = matureStaticScannerRules,
): AuditFinding[] {
  return rules
    .filter((rule) => matchesRule(text, rule))
    .map((rule) => ({
      code: rule.code,
      message: rule.message,
      severity: rule.severity,
    }));
}

function matchesRule(text: string, rule: StaticScannerRule): boolean {
  if (rule.condition === "all") {
    return rule.patterns.every((pattern) => pattern.test(text));
  }

  return rule.patterns.some((pattern) => pattern.test(text));
}
