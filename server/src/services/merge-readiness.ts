import type { Db } from "@paperclipai/db";
import { and, asc, eq } from "drizzle-orm";
import {
  agents,
  issueComments,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import {
  applyMergeReadinessOverride,
  evaluateMergeReadiness,
  parseMergeReadinessVerdict,
  type MergeReadinessBlocker,
  type MergeReadinessOverride,
  type MergeReadinessResult,
  type MergeReadinessVerdict,
} from "@paperclipai/shared";
import {
  extractGitHubPullRequestReferences,
  type GitHubPullRequestReference,
  type PullRequestMergeDetailsResolver,
} from "./github-pull-request-merge.js";

/**
 * Merge readiness service (SHA-anchored QA gate).
 *
 * This is the platform-side control that JUS-2601 §6 asked for: a pull
 * request may not be merged while a covering review ticket carries an open
 * QA verdict that does not cover the pull request's *current* head SHA.
 *
 * The control is deliberately conservative in two directions:
 *
 *  - It reads the LIVE head SHA from GitHub, not from a stored snapshot, so a
 *    push that lands after the sign-off does not inherit the sign-off.
 *  - It reads the verdicts from the covering issue's comments, so the audit
 *    trail is the same thread the reviewers already wrote in.
 *
 * The evaluator itself is pure and lives in `@paperclipai/shared`; this module
 * only gathers inputs and resolves them against the database.
 */

/** A pull request plus the issue whose thread carries its review verdicts. */
export type MergeReadinessPullRequest = {
  reference: GitHubPullRequestReference;
  /** The issue that owns the `pull_request` work product. */
  issueId: string;
  /** The issue identifier, for display and audit rows. */
  issueIdentifier: string | null;
  /** The `pull_request` work product row id. */
  workProductId: string;
};

/** A verdict together with where it came from. */
export type ResolvedMergeReadinessVerdict = MergeReadinessVerdict & {
  /** The comment the verdict was parsed from. */
  commentId: string;
  /** The issue whose thread carried the verdict. */
  issueId: string;
  issueIdentifier: string | null;
  /** The author of the verdict, resolved to a role where possible. */
  authorRole: string | null;
  /** When the verdict was issued. */
  createdAt: string | null;
};

export type MergeReadinessResolution = MergeReadinessResult & {
  /** The pull request that was evaluated. */
  pullRequest: GitHubPullRequestReference;
  /** The covering issue. */
  issueId: string;
  issueIdentifier: string | null;
  /** The live head SHA used for the evaluation. */
  headSha: string | null;
  /** Every verdict found on the covering thread, in issue order. */
  verdicts: ResolvedMergeReadinessVerdict[];
};

export type MergeReadinessServiceOptions = {
  resolvePullRequestDetails?: PullRequestMergeDetailsResolver;
};

function readPullRequestReference(product: {
  url: string | null;
  externalId: string | null;
  title: string | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
}): GitHubPullRequestReference | null {
  const metadata = product.metadata ?? {};
  const references = extractGitHubPullRequestReferences([
    product.url,
    product.externalId,
    product.title,
    product.summary,
    typeof metadata.url === "string" ? metadata.url : null,
  ]);
  return references[0] ?? null;
}

/**
 * List the pull requests that a covering issue carries, together with the
 * issue that owns each work product.
 *
 * The covering issue is the one the `pull_request` work product is attached
 * to. That is the link the merge flow already uses, so the gate reads the
 * same relation the reviewer already reasoned about.
 */
export async function listMergeReadinessPullRequests(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<MergeReadinessPullRequest[]> {
  const rows = await db
    .select({
      workProductId: issueWorkProducts.id,
      url: issueWorkProducts.url,
      externalId: issueWorkProducts.externalId,
      title: issueWorkProducts.title,
      summary: issueWorkProducts.summary,
      metadata: issueWorkProducts.metadata,
      issueId: issues.id,
      issueIdentifier: issues.identifier,
    })
    .from(issueWorkProducts)
    .innerJoin(issues, and(
      eq(issues.id, issueWorkProducts.issueId),
      eq(issues.companyId, issueWorkProducts.companyId),
    ))
    .where(and(
      eq(issueWorkProducts.companyId, companyId),
      eq(issueWorkProducts.issueId, issueId),
      eq(issueWorkProducts.type, "pull_request"),
    ));

  const results: MergeReadinessPullRequest[] = [];
  for (const row of rows) {
    const reference = readPullRequestReference(row);
    if (!reference) continue;
    results.push({
      reference,
      issueId: row.issueId,
      issueIdentifier: row.issueIdentifier,
      workProductId: row.workProductId,
    });
  }
  return results;
}

/**
 * Collect the QA verdicts written on an issue's thread.
 *
 * Verdict comments are read in issue order so that, for one SHA, the last
 * verdict is the one that stands — which is how a FAIL gets re-issued as a
 * PASS without the gate needing a separate notion of "current".
 */
export async function listMergeReadinessVerdicts(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<ResolvedMergeReadinessVerdict[]> {
  const rows = await db
    .select({
      id: issueComments.id,
      body: issueComments.body,
      createdAt: issueComments.createdAt,
      authorAgentId: issueComments.authorAgentId,
      authorUserId: issueComments.authorUserId,
      authorType: issueComments.authorType,
      agentRole: agents.role,
      agentName: agents.name,
    })
    .from(issueComments)
    .leftJoin(agents, eq(agents.id, issueComments.authorAgentId))
    .where(and(
      eq(issueComments.companyId, companyId),
      eq(issueComments.issueId, issueId),
    ))
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id));

  const verdicts: ResolvedMergeReadinessVerdict[] = [];
  for (const row of rows) {
    const parsed = parseMergeReadinessVerdict(row.body);
    if (!parsed) continue;
    const authorRole = row.agentRole
      ?? row.agentName
      ?? row.authorUserId
      ?? row.authorType
      ?? null;
    verdicts.push({
      kind: parsed.kind,
      sha: parsed.sha,
      commentId: row.id,
      issueId,
      issueIdentifier: null,
      authorRole,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    });
  }
  return verdicts;
}

/**
 * Resolve the merge readiness of a pull request carried by a covering issue.
 *
 * The live head SHA is read from GitHub through the same resolver the merge
 * flow uses. If it cannot be read, the evaluation blocks with `head_unknown`
 * rather than guessing.
 */
export async function resolveMergeReadiness(
  db: Db,
  companyId: string,
  issueId: string,
  options: MergeReadinessServiceOptions & { override?: MergeReadinessOverride | null } = {},
): Promise<MergeReadinessResolution[]> {
  const pullRequests = await listMergeReadinessPullRequests(db, companyId, issueId);
  if (pullRequests.length === 0) return [];

  const verdicts = await listMergeReadinessVerdicts(db, companyId, issueId);

  const resolutions: MergeReadinessResolution[] = [];
  for (const pullRequest of pullRequests) {
    let headSha: string | null = null;
    if (options.resolvePullRequestDetails) {
      try {
        const details = await options.resolvePullRequestDetails(companyId, pullRequest.reference);
        headSha = details.headSha ?? null;
      } catch {
        headSha = null;
      }
    }

    const evaluation = evaluateMergeReadiness({
      headSha,
      verdicts,
      override: options.override ?? null,
    });

    resolutions.push({
      ...evaluation,
      pullRequest: pullRequest.reference,
      issueId,
      issueIdentifier: pullRequest.issueIdentifier,
      headSha,
      verdicts,
    });
  }
  return resolutions;
}

/**
 * Apply an audited override to every blocked resolution.
 *
 * The override is applied by the caller (a board route) rather than here, so
 * that the override is always recorded with the actor who authorised it.
 */
export function withMergeReadinessOverride(
  resolutions: MergeReadinessResolution[],
  override: MergeReadinessOverride | null | undefined,
): MergeReadinessResolution[] {
  if (!override) return resolutions;
  return resolutions.map((resolution) => ({
    ...resolution,
    ...applyMergeReadinessOverride(resolution, override),
  }));
}

/**
 * Summarise a resolution into the blockers that should be surfaced.
 */
export function mergeReadinessBlockers(resolution: MergeReadinessResolution): MergeReadinessBlocker[] {
  return resolution.blockers;
}

/**
 * Find the covering issues for a pull request across the company.
 *
 * The inverse of `listMergeReadinessPullRequests`: given a repository and PR
 * number, return the issues whose work products point at it.
 */
export async function findCoveringIssuesForPullRequest(
  db: Db,
  companyId: string,
  reference: GitHubPullRequestReference,
): Promise<Array<{ issueId: string; issueIdentifier: string | null; workProductId: string }>> {
  const rows = await db
    .select({
      workProductId: issueWorkProducts.id,
      url: issueWorkProducts.url,
      externalId: issueWorkProducts.externalId,
      title: issueWorkProducts.title,
      summary: issueWorkProducts.summary,
      metadata: issueWorkProducts.metadata,
      issueId: issues.id,
      issueIdentifier: issues.identifier,
    })
    .from(issueWorkProducts)
    .innerJoin(issues, and(
      eq(issues.id, issueWorkProducts.issueId),
      eq(issues.companyId, issueWorkProducts.companyId),
    ))
    .where(and(
      eq(issueWorkProducts.companyId, companyId),
      eq(issueWorkProducts.type, "pull_request"),
    ));

  const matches: Array<{ issueId: string; issueIdentifier: string | null; workProductId: string }> = [];
  for (const row of rows) {
    const candidate = readPullRequestReference(row);
    if (!candidate) continue;
    if (candidate.owner.toLowerCase() !== reference.owner.toLowerCase()) continue;
    if (candidate.repo.toLowerCase() !== reference.repo.toLowerCase()) continue;
    if (candidate.number !== reference.number) continue;
    matches.push({
      issueId: row.issueId,
      issueIdentifier: row.issueIdentifier,
      workProductId: row.workProductId,
    });
  }
  return matches;
}

/**
 * The issue ids that carry review verdicts for a pull request.
 *
 * Used by the merge path to know which threads to read before allowing a
 * merge.
 */
export async function listCoveringReviewIssueIds(
  db: Db,
  companyId: string,
  reference: GitHubPullRequestReference,
): Promise<string[]> {
  const covering = await findCoveringIssuesForPullRequest(db, companyId, reference);
  const withVerdicts: string[] = [];
  for (const entry of covering) {
    const verdicts = await listMergeReadinessVerdicts(db, companyId, entry.issueId);
    if (verdicts.length > 0) withVerdicts.push(entry.issueId);
  }
  return withVerdicts;
}

/**
 * Guard used by the merge path: true when the pull request may merge.
 */
export async function canMergePullRequest(
  db: Db,
  companyId: string,
  reference: GitHubPullRequestReference,
  options: MergeReadinessServiceOptions = {},
): Promise<{ allowed: boolean; blockers: MergeReadinessBlocker[]; headSha: string | null }> {
  const covering = await findCoveringIssuesForPullRequest(db, companyId, reference);
  const blockers: MergeReadinessBlocker[] = [];
  let headSha: string | null = null;

  for (const entry of covering) {
    const verdicts = await listMergeReadinessVerdicts(db, companyId, entry.issueId);
    if (verdicts.length === 0) continue;
    if (options.resolvePullRequestDetails && headSha === null) {
      try {
        const details = await options.resolvePullRequestDetails(companyId, reference);
        headSha = details.headSha ?? null;
      } catch {
        headSha = null;
      }
    }
    const evaluation = evaluateMergeReadiness({ headSha, verdicts });
    blockers.push(...evaluation.blockers);
  }

  return { allowed: blockers.length === 0, blockers, headSha };
}
