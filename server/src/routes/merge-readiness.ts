import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { badRequest, notFound } from "../errors.js";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import {
  listMergeReadinessPullRequests,
  resolveMergeReadiness,
  withMergeReadinessOverride,
} from "../services/merge-readiness.js";
import { createPullRequestMergeDetailsResolver } from "../services/github-pull-request-merge.js";

/**
 * Merge-readiness routes.
 *
 * The gate is read-only apart from the override. The read endpoint reports
 * whether a pull request may merge, and it reports the reason when it may
 * not. The override endpoint is the only mutating path, and it is restricted
 * to instance administrators because an override bypasses the review that the
 * gate exists to enforce.
 *
 * Every override writes an activity row. An override that leaves no trace is
 * the failure this gate exists to prevent.
 */

const overrideSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
}).strict();

function actorId(req: { actor: { type: string; agentId?: string | null; userId?: string | null } }): string {
  if (req.actor.type === "agent") return req.actor.agentId ?? "unknown-agent";
  return req.actor.userId ?? "board";
}

export function mergeReadinessRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/issues/:issueId/merge-readiness", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);

    const pullRequests = await listMergeReadinessPullRequests(db, companyId, issueId);
    if (pullRequests.length === 0) {
      res.status(404).json({
        error: "No pull request work product is attached to this issue, so there is no merge readiness to report.",
      });
      return;
    }

    const resolutions = await resolveMergeReadiness(db, companyId, issueId, {
      resolvePullRequestDetails: createPullRequestMergeDetailsResolver(db),
    });

    res.json({
      issueId,
      pullRequests: resolutions.map((resolution) => ({
        owner: resolution.pullRequest.owner,
        repo: resolution.pullRequest.repo,
        number: resolution.pullRequest.number,
        url: `https://github.com/${resolution.pullRequest.owner}/${resolution.pullRequest.repo}/pull/${resolution.pullRequest.number}`,
        ready: resolution.ready,
        headSha: resolution.headSha,
        blockers: resolution.blockers,
        override: resolution.override ?? null,
        verdicts: resolution.verdicts,
      })),
    });
  });

  router.post("/companies/:companyId/issues/:issueId/merge-readiness/override", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);
    // An override bypasses the review. It is an administrator action.
    assertInstanceAdmin(req);

    const parsed = overrideSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("An override requires a reason");
    const reason = parsed.data.reason.trim();
    if (!reason) throw badRequest("An override requires a reason");

    const resolutions = await resolveMergeReadiness(db, companyId, issueId, {
      resolvePullRequestDetails: createPullRequestMergeDetailsResolver(db),
    });
    if (resolutions.length === 0) {
      throw notFound("No pull request work product is attached to this issue, so there is nothing to override.");
    }

    const override = {
      by: actorId(req),
      reason,
      at: new Date().toISOString(),
    };
    const overridden = withMergeReadinessOverride(resolutions, override);

    for (const resolution of overridden) {
      await logActivity(db, {
        companyId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId: actorId(req),
        agentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
        action: "pull_request.merge_readiness_overridden",
        entityType: "issue",
        entityId: issueId,
        issueId,
        details: {
          repository: `${resolution.pullRequest.owner}/${resolution.pullRequest.repo}`,
          pullRequestNumber: resolution.pullRequest.number,
          headSha: resolution.headSha,
          reason,
          overriddenBlockers: resolution.blockers.map((blocker) => blocker.code),
        },
      });
    }

    res.json({
      issueId,
      pullRequests: overridden.map((resolution) => ({
        owner: resolution.pullRequest.owner,
        repo: resolution.pullRequest.repo,
        number: resolution.pullRequest.number,
        url: `https://github.com/${resolution.pullRequest.owner}/${resolution.pullRequest.repo}/pull/${resolution.pullRequest.number}`,
        ready: resolution.ready,
        headSha: resolution.headSha,
        blockers: resolution.blockers,
        override: resolution.override ?? null,
        verdicts: resolution.verdicts,
      })),
    });
  });

  return router;
}
