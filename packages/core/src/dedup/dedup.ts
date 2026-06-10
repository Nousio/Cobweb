import type { DedupMatch, DedupResult, ParsedSkill } from "../types.js";

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

      const score = jaccard(
        tokenize(`${left.name} ${left.description}`),
        tokenize(`${right.name} ${right.description}`),
      );

      if (score >= threshold) {
        matches.push(match(left, right, "name_description", score));
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

function tokenize(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/u)
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) {
    return 1;
  }

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }

  return intersection / (left.size + right.size - intersection);
}
