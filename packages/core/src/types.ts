export type RiskLevel = "low" | "medium" | "high" | "blocked";

export type SourceType = "project" | "global" | "imported" | "unknown";

export interface ParsedSection {
  title: string;
  depth: number;
  content: string;
}

export interface ParsedResource {
  path: string;
  isExternal: boolean;
  isAbsolute: boolean;
  escapesRoot: boolean;
  mentionedBy: "markdown-link" | "image" | "script-reference" | "frontmatter";
}

export interface ParsedPolicy {
  implicitInvocation?: boolean;
  selfContained?: boolean;
}

export interface ParsedSkill {
  name: string;
  description: string;
  rootPath: string;
  frontmatter: Record<string, unknown>;
  rawFrontmatter: string;
  sections: ParsedSection[];
  resources: ParsedResource[];
  policy: ParsedPolicy;
  contentHash: string;
  warnings: string[];
}

export interface SkillCandidate {
  path: string;
  kind: "skill_dir";
  name: string;
  description: string;
  riskLevel: RiskLevel;
  duplicateOf: string | null;
  warnings: string[];
}

export interface ScanResult {
  candidates: SkillCandidate[];
  warnings: string[];
}

export interface AuditFinding {
  code: string;
  message: string;
  severity: RiskLevel;
  path?: string;
}

export interface AuditResult {
  riskLevel: RiskLevel;
  findings: AuditFinding[];
}

export interface DedupMatch {
  leftPath: string;
  rightPath: string;
  signal: "content_hash" | "name" | "name_description";
  score: number;
}

export interface DedupResult {
  matches: DedupMatch[];
}

export interface CanonicalSkill {
  id: string;
  name: string;
  description: string;
  rootPath: string;
  canonicalPath?: string;
  sourceType: SourceType;
  contentHash: string;
  riskLevel: RiskLevel;
  provenance?: Record<string, unknown>;
}

export interface ProjectionTarget {
  providerName: string;
  projectRoot: string;
  strategy: "link" | "copy";
}

export interface ProjectionPlan {
  providerName: string;
  sourcePath: string;
  installPath: string;
  strategy: "link" | "copy";
  contentHash: string;
}
