import { describe, expect, it } from "vitest";
import { rankSkillCandidate } from "../../../packages/core/src/search/rank.js";
import { evaluateRoutingGuidance } from "../../../packages/core/src/search/routing-guidance.js";
import { segmentText, tokenizeSearchText } from "../../../packages/core/src/search/segment.js";
import type { RoutingWorkItem, SearchMatchReason, SkillSearchCandidate } from "../../../packages/core/src/types.js";

function candidate(name: string, score: number, matchReasons: SearchMatchReason[] = []): SkillSearchCandidate {
  return {
    path: `/skills/${name}`,
    kind: "skill_dir",
    name,
    description: "",
    duplicateOf: null,
    warnings: [],
    score,
    scoreBreakdown: [],
    matchReasons,
    methods: [],
  };
}

const workItem: RoutingWorkItem = {
  subject: "websocket reconnect hang",
};

describe("search segmentation", () => {
  it("adds CJK bigrams while preserving the original text", () => {
    expect(segmentText("代码审查")).toContain("代码审查");
    expect(tokenizeSearchText("代码审查")).toEqual(["代码审查", "代码", "码审", "审查"]);
  });
});

describe("rankSkillCandidate", () => {
  it("returns an explainable score in the 0-1 range", () => {
    const result = rankSkillCandidate({
      query: "review pull request",
      name: "review",
      description: "Review pull requests before merge",
      methods: [
        {
          methodName: "workflow",
          summary: "Inspect pull request diffs before merge.",
          triggerTerms: ["review", "pull", "request"],
          inputs: [],
          outputs: [],
          requiredTools: [],
          sourceSectionRange: { startSection: 0, endSection: 0 },
          extractionConfidence: 0.85,
        },
      ],
      matchReasons: [{ field: "method", signal: "fts_match" }],
      bm25Rank: -1,
    });

    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.scoreBreakdown.some((item) => item.signal === "method_trigger" && item.contribution > 0)).toBe(true);
  });

  it("does not dilute strong matches with generic query words", () => {
    const result = rankSkillCandidate({
      query: "please help debug ember socket reconnect issue",
      name: "ember-socket-reconnect",
      description: "Debug ember socket reconnect hangs.",
      methods: [],
      matchReasons: [{ field: "name", signal: "fts_match" }],
      bm25Rank: -1,
    });

    expect(result.scoreBreakdown.find((item) => item.signal === "name")?.score).toBe(1);
  });

  it("adds a lightweight signal for heading and body matches", () => {
    const result = rankSkillCandidate({
      query: "fallback guard invariant evidence",
      name: "defensive-programming-decision",
      description: "",
      methods: [],
      matchReasons: [
        { field: "heading", signal: "fts_match", snippet: "[Trigger] Scenarios" },
        { field: "body", signal: "fts_match", snippet: "[fallback] guard" },
      ],
      bm25Rank: -1,
    });

    expect(result.scoreBreakdown.find((item) => item.signal === "content_match")?.contribution).toBeGreaterThan(0);
  });
});

describe("evaluateRoutingGuidance", () => {
  it("requires an analyzed work item even for a strong match", () => {
    const guidance = evaluateRoutingGuidance("review", [candidate("review", 0.6)]);
    expect(guidance?.reason).toBe("missing_work_item");
  });

  it("rejects work items without a concrete subject", () => {
    const guidance = evaluateRoutingGuidance("review", [candidate("review", 0.6)], {
      subject: "",
    });
    expect(guidance?.reason).toBe("missing_work_item");
  });

  it("flags no_candidate when nothing matched", () => {
    const guidance = evaluateRoutingGuidance("debug websocket reconnect", [], workItem);
    expect(guidance?.reason).toBe("no_candidate");
    expect(guidance?.checklist.length).toBeGreaterThan(0);
  });

  it("flags query_too_long for a raw sentence that did not match confidently", () => {
    const longQuery = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi";
    const guidance = evaluateRoutingGuidance(longQuery, [candidate("weak", 0.1)], workItem);
    expect(guidance?.reason).toBe("query_too_long");
  });

  it("deduplicates tokens before checking whether a query is too long", () => {
    const repeatedQuery = "alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha";
    const guidance = evaluateRoutingGuidance(repeatedQuery, [candidate("weak", 0.1)], workItem);
    expect(guidance?.reason).toBe("top1_confidence_low");
  });

  it("flags missing_subject when only generic words remain", () => {
    const guidance = evaluateRoutingGuidance("implement feature", [candidate("weak", 0.1)], {
      subject: "the feature",
    });
    expect(guidance?.reason).toBe("missing_subject");
  });

  it("strips Chinese generic words before checking subject presence", () => {
    expect(evaluateRoutingGuidance("解决问题", [candidate("weak", 0.1)], {
      subject: "帮我解决问题",
    })?.reason).toBe("missing_subject");
    expect(evaluateRoutingGuidance("实现认证功能", [candidate("weak", 0.1)], {
      subject: "实现认证功能",
    })?.reason).toBe("top1_confidence_low");
  });

  it("flags top1_confidence_low for a discriminative but weak match", () => {
    const guidance = evaluateRoutingGuidance("websocket reconnect hang", [
      candidate("weak", 0.2, [{ field: "body", signal: "fts_match", snippet: "[websocket] reconnect" }]),
    ], workItem);
    expect(guidance?.reason).toBe("top1_confidence_low");
    expect(guidance?.inspectionTargets).toEqual([
      {
        path: "/skills/weak",
        name: "weak",
        score: 0.2,
        matchReasons: [{ field: "body", signal: "fts_match", snippet: "[websocket] reconnect" }],
      },
    ]);
  });

  it("flags top1_gap_small only when candidates are nearly tied", () => {
    const guidance = evaluateRoutingGuidance("websocket reconnect hang", [
      candidate("first", 0.5),
      candidate("second", 0.48),
    ], workItem);
    expect(guidance?.reason).toBe("top1_gap_small");
  });

  it("does not flag a single strong candidate as gap_small", () => {
    expect(evaluateRoutingGuidance("websocket reconnect hang", [candidate("strong", 0.6)], workItem)).toBeNull();
  });

  it("does not nag a confident match even when the query is terse", () => {
    expect(evaluateRoutingGuidance("review", [candidate("review", 0.6)], {
      subject: "pull request",
    })).toBeNull();
  });
});
