export type RiskLevel = "low" | "medium" | "high" | "blocked";

export type IndexFreshness = "fresh" | "rebuilding" | "degraded";

export type SourceType = "project" | "global" | "imported" | "unknown";

export interface ParsedSection {
  title: string;
  depth: number;
  content: string;
}

export interface ParsedMethodSummary {
  methodName: string;
  summary: string;
  triggerTerms: string[];
  inputs: string[];
  outputs: string[];
  requiredTools: string[];
  sourceSectionRange: {
    startSection: number;
    endSection: number;
  };
  extractionConfidence: number;
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
  body: string;
  sections: ParsedSection[];
  methodSummaries: ParsedMethodSummary[];
  resources: ParsedResource[];
  policy: ParsedPolicy;
  contentHash: string;
  warnings: string[];
}

export type LintSeverity = "warning" | "error";

export interface LintFinding {
  code: string;
  message: string;
  severity: LintSeverity;
  path?: string;
}

export interface LintResult {
  valid: boolean;
  findings: LintFinding[];
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

export type SearchMatchField = "name" | "description" | "body" | "heading" | "method";

export interface SearchMatchReason {
  field: SearchMatchField;
  signal: string;
  snippet?: string;
}

export interface SkillSearchCandidate extends SkillCandidate {
  score: number;
  matchReasons: SearchMatchReason[];
  methods: ParsedMethodSummary[];
}

export interface SkillSearchResult {
  query: string;
  freshness: IndexFreshness;
  candidates: SkillSearchCandidate[];
  warnings: string[];
}

export interface SkillSelectResult {
  query: string;
  freshness: IndexFreshness;
  selected: SkillSearchCandidate | null;
  recommendation: {
    reason: string;
    confidence: number;
  };
  rejected: Array<{
    path: string;
    name: string;
    reason: string;
  }>;
  risks: AuditFinding[];
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

export interface SkillContextResult {
  path: string;
  name: string;
  description: string;
  summary: string;
  methods: ParsedMethodSummary[];
  resources: ParsedResource[];
  policy: ParsedPolicy & {
    check: PolicyCheckResult;
  };
  audit: AuditResult;
  lint: LintResult;
}

export interface DuplicateCandidate {
  path: string;
  name: string;
  description: string;
  score: number;
  matchReasons: SearchMatchReason[];
  canonicalPath?: string;
}

export interface SkillValidateResult {
  valid: boolean;
  audit: AuditResult;
  lint: LintResult;
  policy: PolicyCheckResult;
  duplicates: DuplicateCandidate[];
}

export interface DedupMatch {
  leftPath: string;
  rightPath: string;
  signal: "content_hash" | "name" | "name_description" | "method_summary";
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

export interface ProjectionResult extends ProjectionPlan {
  written: boolean;
  drift: boolean;
  lastSyncAt: string;
}

export interface CanonicalSkillRecord {
  id: string;
  name: string;
  description: string;
  canonicalPath: string;
  sourcePath: string;
  contentHash: string;
  provenance?: Record<string, unknown>;
}

export interface CobwebLockfile {
  version: 1;
  generatedAt: string;
  skills: CanonicalSkillRecord[];
}

export interface PolicyFinding {
  code: string;
  message: string;
  path?: string;
}

export interface PolicyCheckResult {
  ok: boolean;
  findings: PolicyFinding[];
}

export interface VendorAction {
  sourcePath: string;
  targetPath: string;
  rewriteFrom: string;
  rewriteTo: string;
  exists: boolean;
}

export interface VendorPlan {
  skillPath: string;
  dryRun: boolean;
  actions: VendorAction[];
  warnings: string[];
}

export interface MergePlan {
  sourcePath: string;
  targetPath: string;
  dryRun: true;
  actions: string[];
  matches: DedupMatch[];
}
