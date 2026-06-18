import type { ParsedMethodSummary, SearchMatchReason, SearchScoreBreakdown } from "../types.js";
import { discriminativeTokens } from "./routing-guidance.js";
import { tokenizeSearchText } from "./segment.js";

export interface RankSkillInput {
  query: string;
  name: string;
  description: string;
  methods: ParsedMethodSummary[];
  matchReasons: SearchMatchReason[];
  bm25Rank: number | null;
}

export interface RankSkillResult {
  score: number;
  scoreBreakdown: SearchScoreBreakdown[];
}

const SCORE_WEIGHTS = {
  name: 0.25,
  methodTrigger: 0.25,
  description: 0.15,
  methodSummary: 0.15,
  fieldCoverage: 0.08,
  contentMatch: 0.05,
  bm25: 0.07,
} as const;

export function rankSkillCandidate(input: RankSkillInput): RankSkillResult {
  const queryTokens = discriminativeTokens(input.query);
  const nameTokens = tokenizeSearchText(input.name);
  const descriptionTokens = tokenizeSearchText(input.description);
  const methodTriggerTokens = tokenizeSearchText(input.methods.flatMap((method) => method.triggerTerms).join(" "));
  const methodSummaryTokens = tokenizeSearchText(
    input.methods.map((method) => `${method.methodName} ${method.summary}`).join(" "),
  );

  const normalizedQuery = normalizeText(input.query);
  const normalizedName = normalizeText(input.name);
  const nameCoverage = normalizedQuery && normalizedName === normalizedQuery
    ? 1
    : coverage(queryTokens, nameTokens);
  const methodTriggerOverlap = coverage(queryTokens, methodTriggerTokens);
  const descriptionSimilarity = jaccard(queryTokens, descriptionTokens);
  const methodSummarySimilarity = jaccard(queryTokens, methodSummaryTokens);
  const fieldCoverage = Math.min(1, new Set(input.matchReasons.map((reason) => reason.field)).size / 5);
  const contentMatch = contentMatchScore(input.matchReasons);
  const bm25Score = Math.min(1, Math.abs(input.bm25Rank ?? 0) / 10);

  const scoreBreakdown = [
    breakdown("name", nameCoverage, SCORE_WEIGHTS.name, nameCoverage === 1 ? "exact or full token match" : undefined),
    breakdown("method_trigger", methodTriggerOverlap, SCORE_WEIGHTS.methodTrigger),
    breakdown("description", descriptionSimilarity, SCORE_WEIGHTS.description),
    breakdown("method_summary", methodSummarySimilarity, SCORE_WEIGHTS.methodSummary),
    breakdown("field_coverage", fieldCoverage, SCORE_WEIGHTS.fieldCoverage),
    breakdown("content_match", contentMatch, SCORE_WEIGHTS.contentMatch),
    breakdown("bm25", bm25Score, SCORE_WEIGHTS.bm25),
  ];

  const score = Number(scoreBreakdown.reduce((sum, item) => sum + item.contribution, 0).toFixed(3));
  return { score: Math.min(1, Math.max(0, score)), scoreBreakdown };
}

function breakdown(signal: string, score: number, weight: number, detail?: string): SearchScoreBreakdown {
  const normalizedScore = Math.min(1, Math.max(0, score));
  return {
    signal,
    score: Number(normalizedScore.toFixed(3)),
    weight,
    contribution: Number((normalizedScore * weight).toFixed(3)),
    detail,
  };
}

function coverage(queryTokens: string[], candidateTokens: string[]): number {
  if (queryTokens.length === 0 || candidateTokens.length === 0) {
    return 0;
  }
  const candidate = new Set(candidateTokens);
  const hits = queryTokens.filter((token) => candidate.has(token)).length;
  return hits / Math.min(queryTokens.length, candidate.size);
}

function contentMatchScore(matchReasons: SearchMatchReason[]): number {
  const contentFields = new Set(
    matchReasons
      .map((reason) => reason.field)
      .filter((field) => field === "body" || field === "heading"),
  );
  return Math.min(1, contentFields.size / 2);
}

function jaccard(leftTokens: string[], rightTokens: string[]): number {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (left.size + right.size - intersection);
}

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}
