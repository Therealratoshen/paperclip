import { describe, expect, it } from "vitest";
import {
  applyMergeReadinessOverride,
  evaluateMergeReadiness,
  mergeReadinessShaMatches,
  parseMergeReadinessVerdict,
  type MergeReadinessVerdict,
} from "@paperclipai/shared";

/**
 * The incident this gate exists for: on the JustNewMe repo, PR #356 was
 * merged at head `594bc0f` while the covering ticket's only QA verdict was a
 * FAIL naming `4c86cc7`. Nothing compared the two SHAs, so a rejected tree
 * shipped. Every rule below exists to close that hole.
 */
const HEAD = "594bc0f11111111111111111111111111111111";
const FAIL_SHA = "4c86cc7222222222222222222222222222222222";
const PASS_SHA = "abc1234333333333333333333333333333333333";

function verdict(overrides: Partial<MergeReadinessVerdict> & { kind: "pass" | "fail"; sha: string }): MergeReadinessVerdict {
  return {
    commentId: overrides.commentId ?? "comment-1",
    ...overrides,
  };
}

describe("merge readiness — SHA anchoring", () => {
  it("blocks when a QA FAIL names the head SHA", () => {
    const result = evaluateMergeReadiness({
      headSha: FAIL_SHA,
      verdicts: [verdict({ kind: "fail", sha: FAIL_SHA })],
    });

    expect(result.ready).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]!.code).toBe("review_failed");
    expect(result.blockers[0]!.sha).toBe(FAIL_SHA);
  });

  it("blocks when a QA FAIL names a DIFFERENT SHA — a FAIL is a FAIL until re-issued", () => {
    const result = evaluateMergeReadiness({
      headSha: HEAD,
      verdicts: [verdict({ kind: "fail", sha: FAIL_SHA })],
    });

    expect(result.ready).toBe(false);
    expect(result.blockers.map(blocker => blocker.code)).toEqual(["review_failed"]);
    expect(result.blockers[0]!.sha).toBe(FAIL_SHA);
  });

  it("blocks when a FAIL at another SHA sits alongside a PASS at the head SHA", () => {
    const result = evaluateMergeReadiness({
      headSha: PASS_SHA,
      verdicts: [
        verdict({ kind: "fail", sha: FAIL_SHA, commentId: "fail-1" }),
        verdict({ kind: "pass", sha: PASS_SHA, commentId: "pass-1" }),
      ],
    });

    expect(result.ready).toBe(false);
    expect(result.blockers[0]!.code).toBe("review_failed");
  });

  it("allows when a QA PASS names the head SHA", () => {
    const result = evaluateMergeReadiness({
      headSha: PASS_SHA,
      verdicts: [verdict({ kind: "pass", sha: PASS_SHA })],
    });

    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.verdict?.sha).toBe(PASS_SHA);
  });

  it("does not allow when a QA PASS names a DIFFERENT SHA — the reviewed tree is not the merged tree", () => {
    const result = evaluateMergeReadiness({
      headSha: HEAD,
      verdicts: [verdict({ kind: "pass", sha: PASS_SHA })],
    });

    expect(result.ready).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]!.code).toBe("review_stale");
    expect(result.blockers[0]!.sha).toBe(PASS_SHA);
  });

  it("blocks when no verdict exists at all", () => {
    const result = evaluateMergeReadiness({
      headSha: HEAD,
      verdicts: [],
    });

    expect(result.ready).toBe(false);
    expect(result.blockers[0]!.code).toBe("review_missing");
  });

  it("blocks when the head SHA cannot be determined", () => {
    const result = evaluateMergeReadiness({
      headSha: null,
      verdicts: [verdict({ kind: "pass", sha: PASS_SHA })],
    });

    expect(result.ready).toBe(false);
    expect(result.blockers[0]!.code).toBe("head_unknown");
  });
});

describe("merge readiness — override", () => {
  it("allows a blocked merge when an override names an author and a reason, and records it", () => {
    const blocked = evaluateMergeReadiness({
      headSha: HEAD,
      verdicts: [verdict({ kind: "fail", sha: FAIL_SHA })],
    });
    expect(blocked.ready).toBe(false);

    const overridden = applyMergeReadinessOverride(blocked, {
      by: "board-operator",
      reason: "The FAIL was raised against the parent commit; re-verified against this head.",
      at: "2026-11-10T12:00:00.000Z",
    });

    expect(overridden.ready).toBe(true);
    expect(overridden.blockers).toEqual([]);
    expect(overridden.override).toEqual({
      by: "board-operator",
      reason: "The FAIL was raised against the parent commit; re-verified against this head.",
      at: "2026-11-10T12:00:00.000Z",
    });
  });

  it("refuses an override that names no author", () => {
    const blocked = evaluateMergeReadiness({
      headSha: HEAD,
      verdicts: [verdict({ kind: "fail", sha: FAIL_SHA })],
    });

    const overridden = applyMergeReadinessOverride(blocked, {
      by: "   ",
      reason: "because",
      at: "2026-11-10T12:00:00.000Z",
    });

    expect(overridden.ready).toBe(false);
    expect(overridden.blockers[0]!.code).toBe("review_failed");
  });

  it("refuses an override that names no reason", () => {
    const blocked = evaluateMergeReadiness({
      headSha: HEAD,
      verdicts: [verdict({ kind: "fail", sha: FAIL_SHA })],
    });

    const overridden = applyMergeReadinessOverride(blocked, {
      by: "board-operator",
      reason: "",
      at: "2026-11-10T12:00:00.000Z",
    });

    expect(overridden.ready).toBe(false);
  });

  it("records the override on the result it produced", () => {
    const result = evaluateMergeReadiness({
      headSha: HEAD,
      verdicts: [verdict({ kind: "fail", sha: FAIL_SHA })],
      override: {
        by: "board-operator",
        reason: "re-verified",
        at: "2026-11-10T12:00:00.000Z",
      },
    });

    expect(result.override?.by).toBe("board-operator");
  });
});

describe("merge readiness — verdict re-issue", () => {
  it("lets a later verdict for the same SHA supersede an earlier one", () => {
    const result = evaluateMergeReadiness({
      headSha: HEAD,
      verdicts: [
        verdict({ kind: "fail", sha: HEAD, commentId: "fail-1" }),
        verdict({ kind: "pass", sha: HEAD, commentId: "pass-1" }),
      ],
    });

    expect(result.ready).toBe(true);
    expect(result.verdict?.commentId).toBe("pass-1");
  });

  it("keeps the FAIL standing when the re-issue names a different SHA", () => {
    const result = evaluateMergeReadiness({
      headSha: HEAD,
      verdicts: [
        verdict({ kind: "fail", sha: HEAD, commentId: "fail-1" }),
        verdict({ kind: "pass", sha: PASS_SHA, commentId: "pass-1" }),
      ],
    });

    expect(result.ready).toBe(false);
    expect(result.blockers[0]!.code).toBe("review_failed");
  });
});

describe("merge readiness — verdict parsing", () => {
  it("parses a QA PASS with a full SHA", () => {
    expect(parseMergeReadinessVerdict(`<!-- qa-signoff -->\n\nQA PASS ${PASS_SHA}\n\nVerified.`))
      .toEqual({ kind: "pass", sha: PASS_SHA });
  });

  it("parses a QA REQUEST CHANGES as a fail verdict", () => {
    expect(parseMergeReadinessVerdict(`<!-- qa-signoff -->\n\nQA REQUEST CHANGES ${FAIL_SHA}\n\nBroken.`))
      .toEqual({ kind: "fail", sha: FAIL_SHA });
  });

  it("parses a QA FAIL as a fail verdict", () => {
    expect(parseMergeReadinessVerdict(`QA FAIL ${FAIL_SHA}`))
      .toEqual({ kind: "fail", sha: FAIL_SHA });
  });

  it("prefers the verdict that follows the sign-off marker", () => {
    const body = [
      "We previously said:",
      `QA PASS ${PASS_SHA}`,
      "",
      "<!-- qa-signoff -->",
      "",
      `QA FAIL ${FAIL_SHA}`,
    ].join("\n");

    expect(parseMergeReadinessVerdict(body)).toEqual({ kind: "fail", sha: FAIL_SHA });
  });

  it("ignores a body with no verdict", () => {
    expect(parseMergeReadinessVerdict("looks good to me")).toBeNull();
    expect(parseMergeReadinessVerdict(null)).toBeNull();
    expect(parseMergeReadinessVerdict("")).toBeNull();
  });

  it("ignores a verdict with no SHA", () => {
    expect(parseMergeReadinessVerdict("QA PASS")).toBeNull();
  });
});

describe("merge readiness — SHA comparison", () => {
  it("matches a short SHA against a full one it prefixes", () => {
    expect(mergeReadinessShaMatches("594bc0f", HEAD)).toBe(true);
    expect(mergeReadinessShaMatches("4c86cc7", FAIL_SHA)).toBe(true);
  });

  it("does not match a short SHA that is not a prefix", () => {
    expect(mergeReadinessShaMatches("deadbee", HEAD)).toBe(false);
  });

  it("does not match a longer candidate against a shorter head", () => {
    expect(mergeReadinessShaMatches(HEAD, "594bc0f")).toBe(false);
  });
});

describe("merge readiness — the PR #356 incident", () => {
  it("refuses the exact merge that shipped a rejected tree", () => {
    const result = evaluateMergeReadiness({
      headSha: HEAD,
      verdicts: [verdict({ kind: "fail", sha: FAIL_SHA, commentId: "JUS-2557-comment" })],
    });

    expect(result.ready).toBe(false);
    expect(result.blockers[0]!.code).toBe("review_failed");
    expect(result.blockers[0]!.sha).toBe(FAIL_SHA);
  });
});
