/**
 * Merge readiness contract (SHA-anchored QA gate).
 *
 * A pull request is mergeable only when the review coverage for its **current
 * head SHA** says so. Two failure modes motivated this contract:
 *
 *  1. A QA verdict that names a *different* SHA than the one being merged.
 *     Merging head `594bc0f` while the covering ticket's only sign-off names
 *     `4c86cc7` means nobody reviewed the code that actually shipped.
 *  2. A QA FAIL that is still open on the covering ticket. A later PASS at the
 *     same SHA supersedes it; a PASS at a *different* SHA does not, because it
 *     reviewed a different tree.
 *
 * The rules are deliberately strict and deliberately pure: this module holds
 * no I/O and no policy of its own beyond the four rules below, so the same
 * evaluation can be run by the server, by a CLI, and by a test.
 *
 *  - A QA FAIL at ANY SHA blocks. A FAIL is a FAIL until it is re-issued.
 *  - A QA PASS clears the merge ONLY when `verdict.sha === headSha`.
 *  - A QA PASS at a different SHA is stale and does not clear.
 *  - No verdict at all blocks.
 *
 * An override is an explicit, audited escape hatch: it requires a named
 * author and a reason, and it is recorded in the result so the decision
 * travels with the evaluation rather than living only in a log line.
 */

/** The marker that identifies a QA sign-off block inside a comment body. */
export const MERGE_READINESS_SIGNOFF_MARKER = "<!-- qa-signoff -->";

/** A QA verdict parsed out of a review comment body. */
export type MergeReadinessVerdictKind = "pass" | "fail";

/**
 * A single QA verdict.
 *
 * `sha` is the SHA the verdict was written against, NOT necessarily the SHA
 * that is being merged. That distinction is the whole point of the gate.
 */
export type MergeReadinessVerdict = {
  kind: MergeReadinessVerdictKind;
  /** The SHA the verdict names. */
  sha: string;
  /** Identifier of the comment the verdict was parsed from. */
  commentId: string;
  /** Who issued the verdict (agent id, user id, or a display name). */
  authorRole?: string | null;
  /** When the verdict was issued. */
  createdAt?: string | null;
};

/** Why a merge is blocked. */
export type MergeReadinessBlockerCode =
  /** A QA FAIL is open against the head SHA. */
  | "review_failed"
  /** A QA PASS exists but names a SHA other than the head being merged. */
  | "review_stale"
  /** No QA verdict covers this head at all. */
  | "review_missing"
  /** The head SHA could not be determined, so nothing can be verified. */
  | "head_unknown";

export type MergeReadinessBlocker = {
  code: MergeReadinessBlockerCode;
  /** The SHA the blocking verdict named, when there is one. */
  sha?: string | null;
  /** The comment the blocking verdict came from, when there is one. */
  commentId?: string | null;
  /** Human-readable explanation. */
  detail: string;
};

/** An audited override of a blocking merge-readiness result. */
export type MergeReadinessOverride = {
  /** Who authorised the override. Required. */
  by: string;
  /** Why the override was granted. Required. */
  reason: string;
  /** When the override was granted. */
  at: string;
};

export type MergeReadinessInput = {
  /** The SHA that would actually be merged. */
  headSha: string | null | undefined;
  /** Every QA verdict found on the covering review ticket(s). */
  verdicts: readonly MergeReadinessVerdict[];
  /** An optional audited override. */
  override?: MergeReadinessOverride | null;
};

export type MergeReadinessResult = {
  /** True when the merge may proceed. */
  ready: boolean;
  /** Every reason the merge is blocked. Empty when `ready` is true. */
  blockers: MergeReadinessBlocker[];
  /** The override that was applied, when one was applied. */
  override?: MergeReadinessOverride;
  /** The head SHA the evaluation was performed against. */
  headSha: string | null;
  /** The verdict the evaluation was based on, when one applied. */
  verdict?: MergeReadinessVerdict | null;
};

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/** True when `value` looks like a git SHA. */
export function isMergeReadinessSha(value: unknown): value is string {
  return typeof value === "string" && SHA_PATTERN.test(value.trim());
}

/**
 * Compare two SHAs.
 *
 * GitHub reports full 40-character SHAs, but a verdict written by a human
 * often names a short SHA. A short SHA matches when it is a prefix of the
 * head SHA, which is the same rule `git rev-parse` uses.
 */
export function mergeReadinessShaMatches(candidate: string, headSha: string): boolean {
  const left = candidate.trim().toLowerCase();
  const right = headSha.trim().toLowerCase();
  if (!left || !right) return false;
  if (left.length === right.length) return left === right;
  if (left.length > right.length) return false;
  return right.startsWith(left);
}

/**
 * Parse a QA verdict out of a comment body.
 *
 * The accepted form mirrors the pipeline QA contract: an optional sign-off
 * marker followed by a literal `QA PASS <sha>` or `QA REQUEST CHANGES <sha>`
 * on its own line. The marker is *not* required, because a verdict that names
 * a SHA in the required shape is unambiguous on its own, but it is recognised
 * so a body carrying several blocks resolves to the one nearest the marker.
 */
export function parseMergeReadinessVerdict(
  body: string | null | undefined,
): { kind: MergeReadinessVerdictKind; sha: string } | null {
  if (typeof body !== "string" || body.length === 0) return null;
  const pattern = /^\s*(QA\s+PASS|QA\s+REQUEST\s+CHANGES|QA\s+FAIL)\s+([0-9a-f]{7,40})\s*$/gim;
  const matches = [...body.matchAll(pattern)];
  if (matches.length === 0) return null;
  const marker = body.indexOf(MERGE_READINESS_SIGNOFF_MARKER);
  let chosen = matches[0]!;
  if (marker >= 0) {
    // Prefer the verdict that follows the marker, so a body that quotes an
    // older verdict above the sign-off block still resolves to the sign-off.
    const afterMarker = matches.find((match) => (match.index ?? 0) > marker);
    if (afterMarker) chosen = afterMarker;
  }
  const literal = chosen[1]!.toUpperCase().replace(/\s+/g, " ");
  const kind: MergeReadinessVerdictKind = literal === "QA PASS" ? "pass" : "fail";
  return { kind, sha: chosen[2]!.toLowerCase() };
}

/**
 * Evaluate whether a pull request head may be merged.
 *
 * Pure: no I/O, no clock, no network. The caller supplies the head SHA, the
 * verdicts, and (optionally) an override.
 */
export function evaluateMergeReadiness(input: MergeReadinessInput): MergeReadinessResult {
  const headSha = typeof input.headSha === "string" && input.headSha.trim().length > 0
    ? input.headSha.trim()
    : null;
  const verdicts = Array.isArray(input.verdicts) ? input.verdicts : [];

  if (!headSha) {
    return {
      ready: false,
      blockers: [{
        code: "head_unknown",
        detail: "The pull request head SHA could not be determined, so no review verdict can be verified against it.",
      }],
      override: input.override ?? undefined,
      headSha: null,
      verdict: null,
    };
  }

  // A FAIL is a FAIL until it is re-issued, and it is a FAIL at ANY SHA.
  // Someone who reviewed one tree and rejected it has said something about
  // the review, not only about one commit; ignoring a FAIL that names a
  // different SHA would let a rebase launder a rejection into a merge.
  //
  // "Re-issued" means a later verdict against the SAME SHA. The caller
  // supplies the verdicts in issue order, so the last verdict for a SHA is
  // the one that stands.
  const latestBySha = new Map<string, MergeReadinessVerdict>();
  for (const verdict of verdicts) {
    const key = verdict.sha.trim().toLowerCase();
    latestBySha.set(key, verdict);
  }
  const standing = [...latestBySha.values()];
  const failures = standing.filter((verdict) => verdict.kind === "fail");

  if (failures.length > 0) {
    const failure = failures[failures.length - 1]!;
    return {
      ready: false,
      blockers: [{
        code: "review_failed",
        sha: failure.sha,
        commentId: failure.commentId,
        detail: `A QA FAIL verdict for ${failure.sha} is open against the head SHA ${headSha}.`,
      }],
      override: input.override ?? undefined,
      headSha,
      verdict: failure,
    };
  }

  // Only a PASS against the head SHA itself clears the merge.
  const headPass = standing.find(
    (verdict) => verdict.kind === "pass" && mergeReadinessShaMatches(verdict.sha, headSha),
  );
  if (headPass) {
    return {
      ready: true,
      blockers: [],
      override: input.override ?? undefined,
      headSha,
      verdict: headPass,
    };
  }

  // No verdict covers this head. Was there a verdict for some OTHER SHA? That
  // is the stale case: the review happened, but it reviewed a different tree.
  const stale = verdicts.filter((verdict) => verdict.kind === "pass");
  if (stale.length > 0) {
    const stalePass = stale[stale.length - 1]!;
    return {
      ready: false,
      blockers: [{
        code: "review_stale",
        sha: stalePass.sha,
        commentId: stalePass.commentId,
        detail: `The only QA PASS verdict names ${stalePass.sha}, which is not the head SHA ${headSha}. The reviewed tree is not the merged tree.`,
      }],
      override: input.override ?? undefined,
      headSha,
      verdict: stalePass,
    };
  }

  return {
    ready: false,
    blockers: [{
      code: "review_missing",
      detail: `No QA verdict covers the head SHA ${headSha}.`,
    }],
    override: input.override ?? undefined,
    headSha,
    verdict: null,
  };
}

/**
 * Apply an override to a blocked result.
 *
 * An override must name an author and a reason. An override with either one
 * missing is rejected rather than silently accepted, because a silent
 * override is exactly the failure this gate exists to prevent.
 */
export function applyMergeReadinessOverride(
  result: MergeReadinessResult,
  override: MergeReadinessOverride | null | undefined,
): MergeReadinessResult {
  if (!override) return result;
  const by = typeof override.by === "string" ? override.by.trim() : "";
  const reason = typeof override.reason === "string" ? override.reason.trim() : "";
  if (!by || !reason) return result;
  return {
    ...result,
    ready: true,
    blockers: [],
    override: { by, reason, at: override.at },
  };
}
