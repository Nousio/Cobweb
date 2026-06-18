const CJK_RUN_PATTERN = /[\u4e00-\u9fff]+/gu;
const TOKEN_SPLIT_PATTERN = /[^a-z0-9\u4e00-\u9fff]+/u;

export function segmentText(input: string): string {
  const cjkTokens: string[] = [];
  for (const match of input.matchAll(CJK_RUN_PATTERN)) {
    cjkTokens.push(...cjkBigrams(match[0]));
  }
  return [input, ...cjkTokens].filter(Boolean).join(" ");
}

export function tokenizeSearchText(input: string, limit = Number.POSITIVE_INFINITY): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of segmentText(input).toLowerCase().split(TOKEN_SPLIT_PATTERN)) {
    const normalized = token.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    tokens.push(normalized);
    if (tokens.length >= limit) {
      break;
    }
  }
  return tokens;
}

function cjkBigrams(value: string): string[] {
  if (value.length <= 1) {
    return value ? [value] : [];
  }
  const tokens: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    tokens.push(value.slice(index, index + 2));
  }
  return tokens;
}
