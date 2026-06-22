import type { ParsedMethodSummary, SearchMatchReason, SearchScoreBreakdown } from "../types.js";
import { discriminativeTokens } from "./routing-guidance.js";
import { tokenizeSearchText } from "./segment.js";

export type TokenSignalWeights = Record<string, number>;

export interface RankSkillInput {
  query: string;
  name: string;
  description: string;
  methods: ParsedMethodSummary[];
  matchReasons: SearchMatchReason[];
  bm25Rank: number | null;
  tokenWeights?: TokenSignalWeights;
}

export interface RankSkillResult {
  score: number;
  scoreBreakdown: SearchScoreBreakdown[];
}

const SCORE_WEIGHTS = {
  name: 0.25,
  methodTrigger: 0.23,
  description: 0.17,
  methodSummary: 0.13,
  descriptionQuality: 0.03,
  fieldCoverage: 0.05,
  contentMatch: 0.04,
  bm25: 0.10,
} as const;

export function rankSkillCandidate(input: RankSkillInput): RankSkillResult {
  const queryTokens = discriminativeTokens(input.query);
  const tokenWeights = input.tokenWeights ?? {};
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
    : coverage(queryTokens, nameTokens, tokenWeights);
  const methodTriggerOverlap = coverage(queryTokens, methodTriggerTokens, tokenWeights);
  const descriptionSimilarity = coverage(queryTokens, descriptionTokens, tokenWeights);
  const methodSummarySimilarity = jaccard(queryTokens, methodSummaryTokens, tokenWeights);
  const descriptionQuality = input.description.trim() ? 1 : 0;
  const fieldCoverage = Math.min(1, new Set(input.matchReasons.map((reason) => reason.field)).size / 5);
  const contentMatch = contentMatchScore(input.matchReasons);
  const bm25Score = Math.min(1, Math.abs(input.bm25Rank ?? 0) / 10);

  const scoreBreakdown = [
    breakdown("name", nameCoverage, SCORE_WEIGHTS.name, nameCoverage === 1 ? "exact or full token match" : undefined),
    breakdown("method_trigger", methodTriggerOverlap, SCORE_WEIGHTS.methodTrigger),
    breakdown("description", descriptionSimilarity, SCORE_WEIGHTS.description),
    breakdown("method_summary", methodSummarySimilarity, SCORE_WEIGHTS.methodSummary),
    breakdown("description_quality", descriptionQuality, SCORE_WEIGHTS.descriptionQuality),
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

function coverage(queryTokens: string[], candidateTokens: string[], tokenWeights: TokenSignalWeights): number {
  if (queryTokens.length === 0 || candidateTokens.length === 0) {
    return 0;
  }
  const candidate = new Set(candidateTokens);
  const hits = queryTokens.filter((token) => candidate.has(token));
  return sumWeights(hits, tokenWeights) / Math.min(sumWeights(queryTokens, tokenWeights), sumWeights(candidateTokens, tokenWeights));
}

function contentMatchScore(matchReasons: SearchMatchReason[]): number {
  const contentFields = new Set(
    matchReasons
      .map((reason) => reason.field)
      .filter((field) => field === "body" || field === "heading"),
  );
  return Math.min(1, contentFields.size / 2);
}

function jaccard(leftTokens: string[], rightTokens: string[], tokenWeights: TokenSignalWeights): number {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  let union = 0;
  const unionTokens = new Set([...left, ...right]);
  for (const token of unionTokens) {
    union += tokenWeight(token, tokenWeights);
  }
  for (const token of left) {
    if (right.has(token)) {
      intersection += tokenWeight(token, tokenWeights);
    }
  }
  return union === 0 ? 0 : intersection / union;
}

function sumWeights(tokens: string[], tokenWeights: TokenSignalWeights): number {
  return tokens.reduce((sum, token) => sum + tokenWeight(token, tokenWeights), 0);
}

function tokenWeight(token: string, tokenWeights: TokenSignalWeights): number {
  return tokenWeights[token] ?? 1;
}

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}
