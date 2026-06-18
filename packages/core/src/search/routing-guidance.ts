import type { RoutingGuidance, RoutingGuidanceReason, RoutingWorkItem, SkillSearchCandidate } from "../types.js";

export interface RoutingGuidanceOptions {
  inspectionFallbackPaths?: string[];
}

// Initial thresholds, calibrated against rank.ts weight composition. They are
// deliberately conservative so guidance only appears when routing is genuinely
// weak, not on every terse query.
export const ROUTING_GUIDANCE_THRESHOLDS = {
  // discriminative token count (after removing stop/generic words) above which a
  // query is treated as a raw user sentence rather than a routing query.
  maxQueryTokens: 12,
  // a top-1 score below this means no candidate matched with substantive name /
  // method-trigger / description overlap.
  minTop1Score: 0.3,
  // when the two best candidates are this close, the choice is ambiguous.
  minTop1Gap: 0.05,
} as const;

// Generic intent / object / filler tokens that carry no routing signal on their
// own. Used to decide whether a query still has a discriminative subject. CJK
// bigrams are intentionally not used here; they only serve FTS recall.
export const ROUTING_GENERIC_TOKENS = new Set<string>([
  // english generic intent / action
  "implement", "build", "create", "add", "write", "make", "update", "change",
  "refactor", "fix", "debug", "resolve", "solve", "troubleshoot", "investigate",
  "review", "check", "verify", "trace", "analyze", "analyse", "test", "document",
  "handle", "process",
  // english generic objects / fillers
  "feature", "function", "code", "skill", "task", "issue", "problem", "bug",
  "logic", "flow", "thing", "stuff", "please", "help", "need", "want",
  // chinese generic intent / object / filler
  "实现", "构建", "创建", "新增", "添加", "编写", "修改", "更新", "重构", "修复",
  "排查", "调试", "解决", "审查", "检查", "核查", "追踪", "分析", "测试", "处理",
  "功能", "代码", "问题", "逻辑", "链路", "帮我", "事情", "一下",
]);

const ROUTING_STOP_WORDS = new Set<string>([
  "a", "an", "the", "and", "or", "for", "to", "of", "in", "on", "with", "from",
  "into", "this", "that", "my", "your", "it", "is", "are", "be", "do", "does",
  "then", "after", "before", "finally",
  "的", "了", "和", "与", "在", "把", "我", "你", "它", "并", "最后", "然后", "再",
]);

const EXPECTED_DIMENSIONS = ["workItem.subject", "intent", "constraints"];

const GUIDANCE_EXAMPLE = {
  intent: "debug",
  subject: "websocket reconnect hang",
  constraints: ["typescript", "daemon"],
} as const;

const CHECKLIST_BY_REASON: Record<RoutingGuidanceReason, string[]> = {
  missing_work_item: [
    "Before calling skill_select, provide workItem.subject from your task analysis.",
    "Set workItem.subject to the concrete object under work, not filler like 'feature' or 'issue'.",
    "Keep query as intent plus discriminative subject terms, not the raw user sentence.",
  ],
  no_candidate: [
    "No skill matched. Re-express the task as an intent verb plus a concrete subject.",
    "Drop filler like 'help me' / 'please' / 'the feature'.",
    "If two refined attempts still return no candidates, inspect the scan root directly or call skill_graph to find nearby skill paths.",
  ],
  query_too_long: [
    "Query reads like a raw user sentence. Reduce it to an intent verb plus a discriminative subject.",
    "Split a multi-phase task (implement, then review, then trace logic) into separate skill_select calls.",
    "Keep only terms that distinguish this skill from others.",
  ],
  missing_subject: [
    "Query has only generic intent/filler words and no discriminative subject.",
    "Add the concrete object the task acts on (module, error, domain).",
    "Avoid standalone verbs like 'implement' / 'fix' without a target.",
  ],
  top1_confidence_low: [
    "Best match scored low. Re-query with selected.name plus the strongest matchReasons terms.",
    "Use selected.scoreBreakdown to keep signals that contributed and remove unrelated query words.",
    "After two refined attempts, inspect the inspectionTargets paths or call skill_context for those skills before using one.",
  ],
  top1_gap_small: [
    "Top candidates are nearly tied. Add the concrete subject term that distinguishes the intended skill.",
    "Compare each candidate's scoreBreakdown and matchReasons before re-querying.",
    "After two refined attempts, inspect the inspectionTargets paths or call skill_context for those skills before using one.",
  ],
};

/**
 * Evaluate whether skill_select should return routing guidance for the caller.
 * Returns null when routing already produced a confident, well-separated match,
 * so confident results are never nagged regardless of query shape.
 */
export function evaluateRoutingGuidance(
  query: string,
  candidates: SkillSearchCandidate[],
  workItem?: RoutingWorkItem,
  options: RoutingGuidanceOptions = {},
): RoutingGuidance | null {
  const reason = detectGuidanceReason(query, candidates, workItem);
  if (!reason) {
    return null;
  }
  return {
    reason,
    expects: [...EXPECTED_DIMENSIONS],
    checklist: CHECKLIST_BY_REASON[reason],
    inspectionTargets: inspectionTargets(candidates, options),
    example: { ...GUIDANCE_EXAMPLE, constraints: [...GUIDANCE_EXAMPLE.constraints] },
  };
}

function inspectionTargets(candidates: SkillSearchCandidate[], options: RoutingGuidanceOptions) {
  const candidateTargets = candidates.slice(0, 5).map((candidate) => ({
    path: candidate.path,
    name: candidate.name,
    score: candidate.score,
    matchReasons: candidate.matchReasons,
    kind: "skill" as const,
  }));
  if (candidateTargets.length > 0) {
    return candidateTargets;
  }
  return (options.inspectionFallbackPaths ?? []).map((path) => ({
    path,
    name: "scan root",
    score: 0,
    matchReasons: [],
    kind: "scan_root" as const,
    reason: "No indexed skill matched; inspect this scan root or call skill_graph to locate nearby skills.",
  }));
}

function detectGuidanceReason(
  query: string,
  candidates: SkillSearchCandidate[],
  workItem?: RoutingWorkItem,
): RoutingGuidanceReason | null {
  if (!workItem || typeof workItem.subject !== "string" || !workItem.subject.trim()) {
    return "missing_work_item";
  }

  if (candidates.length === 0) {
    return "no_candidate";
  }

  const top1 = candidates[0].score;
  const gapSmall =
    candidates.length >= 2 && top1 - candidates[1].score < ROUTING_GUIDANCE_THRESHOLDS.minTop1Gap;
  const confident = top1 >= ROUTING_GUIDANCE_THRESHOLDS.minTop1Score && !gapSmall;
  if (confident) {
    return null;
  }

  // Not confident: prefer the most actionable reason. Query-shape problems come
  // first because fixing the query is more effective than re-ranking.
  const subjectTokens = discriminativeTokens(workItem.subject);
  if (subjectTokens.length === 0) {
    return "missing_subject";
  }
  if (discriminativeTokens(query).length > ROUTING_GUIDANCE_THRESHOLDS.maxQueryTokens) {
    return "query_too_long";
  }
  if (top1 < ROUTING_GUIDANCE_THRESHOLDS.minTop1Score) {
    return "top1_confidence_low";
  }
  return "top1_gap_small";
}

export function discriminativeTokens(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .map((token) => token.trim())
    .flatMap(stripGenericCjkTokens)
    .filter(
      (token) =>
        token.length >= 2 && !ROUTING_STOP_WORDS.has(token) && !ROUTING_GENERIC_TOKENS.has(token),
    );
  return Array.from(new Set(tokens));
}

function stripGenericCjkTokens(token: string): string[] {
  if (!/[\u4e00-\u9fff]/u.test(token)) {
    return [token];
  }

  let remaining = token;
  for (const generic of ROUTING_GENERIC_TOKENS) {
    if (/^[\u4e00-\u9fff]+$/u.test(generic)) {
      remaining = remaining.replaceAll(generic, " ");
    }
  }
  for (const stopWord of ROUTING_STOP_WORDS) {
    if (/^[\u4e00-\u9fff]+$/u.test(stopWord)) {
      remaining = remaining.replaceAll(stopWord, " ");
    }
  }
  return remaining.split(/\s+/u).filter(Boolean);
}
