import type { DedupMatch, DedupResult, ParsedSkill } from "../types.js";
import { jaccardSimilarity, tokenizeText } from "./similarity.js";

export interface DedupOptions {
  threshold?: number;
}

export function dedupSkills(skills: ParsedSkill[], options: DedupOptions = {}): DedupResult {
  const threshold = options.threshold ?? 0.85;
  const matches: DedupMatch[] = [];

  for (let i = 0; i < skills.length; i += 1) {
    for (let j = i + 1; j < skills.length; j += 1) {
      const left = skills[i]!;
      const right = skills[j]!;

      if (left.contentHash === right.contentHash) {
        matches.push(match(left, right, "content_hash", 1));
        continue;
      }

      if (left.name.toLowerCase() === right.name.toLowerCase()) {
        matches.push(match(left, right, "name", 1));
        continue;
      }

      const score = jaccardSimilarity(
        tokenizeText(`${left.name} ${left.description}`),
        tokenizeText(`${right.name} ${right.description}`),
      );

      if (score >= threshold) {
        matches.push(match(left, right, "name_description", score));
        continue;
      }

      const leftMethodText = methodSummaryText(left);
      const rightMethodText = methodSummaryText(right);
      const methodScore =
        leftMethodText && rightMethodText ? jaccardSimilarity(tokenizeText(leftMethodText), tokenizeText(rightMethodText)) : 0;
      if (methodScore >= threshold) {
        matches.push(match(left, right, "method_summary", methodScore));
      }
    }
  }

  return { matches };
}

function match(
  left: ParsedSkill,
  right: ParsedSkill,
  signal: DedupMatch["signal"],
  score: number,
): DedupMatch {
  return {
    leftPath: left.rootPath,
    rightPath: right.rootPath,
    signal,
    score,
  };
}

function methodSummaryText(skill: ParsedSkill): string {
  return skill.methodSummaries.map((summary) => `${summary.methodName} ${summary.summary}`).join(" ");
}
