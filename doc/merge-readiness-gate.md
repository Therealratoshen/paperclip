# Merge readiness (SHA-anchored review gate)

This document describes the merge-readiness gate. The gate decides whether a
pull request may be merged. It reads the review verdicts on the covering
ticket and compares them with the live head SHA of the pull request.

## 1. The problem this gate solves

A pull request can be merged while the ticket that covers it holds a review
verdict that rejects the code. This happened in a production repository. The
pull request was merged at head `594bc0f`. The covering ticket held a `QA FAIL`
verdict that named `4c86cc7`. The two SHAs are different, so nobody reviewed
the tree that shipped. The rejected defect reached the public site.

The root cause was that no control compared the SHA in the verdict with the SHA
that the merge would ship. The gate existed only as a rule that an agent read
in a comment. A rule that lives in a comment is not enforced. The gate has to
be a first-class check that the platform runs.

## 2. The rules

The gate is anchored on one fact: the SHA in the verdict must be the SHA that
merges.

| Situation | Result | Blocker code |
| --- | --- | --- |
| A `QA FAIL` verdict names the head SHA | Merge refused | `review_failed` |
| A `QA FAIL` verdict names a different SHA | Merge refused | `review_failed` |
| A `QA PASS` verdict names the head SHA | Merge allowed | — |
| A `QA PASS` verdict names a different SHA | Merge refused | `review_stale` |
| No verdict names the head SHA | Merge refused | `review_missing` |
| The head SHA cannot be read | Merge refused | `head_unknown` |

Two rules need extra explanation.

**A FAIL is a FAIL until it is re-issued.** A `QA FAIL` verdict blocks the
merge at any SHA. Ignoring a FAIL that names a different SHA would let a
rebase launder a rejection into a merge. A reviewer who rejected one tree has
said something about the review, not only about one commit. The FAIL is
cleared only by a later verdict that names the same SHA.

**A PASS at the wrong SHA does not clear.** A `QA PASS` verdict clears the
merge only when it names the head SHA. A PASS for a different SHA reviewed a
different tree, so it does not review the tree that would merge. The gate
reports this as `review_stale` and names both SHAs.

## 3. The verdict format

A verdict is a comment that contains one of these literals on its own line,
followed by the SHA:

```text
QA PASS <sha>
QA REQUEST CHANGES <sha>
QA FAIL <sha>
```

The comment can also carry the marker `<!-- qa-signoff -->`. When the marker is
present, the gate uses the verdict that follows it. This matters when a
comment quotes an older verdict above the current sign-off block.

The SHA may be short. A short SHA matches when it is a prefix of the head SHA,
in the same way that `git rev-parse` matches a short SHA.

## 4. Where the verdicts come from

The covering ticket is the issue that owns the `pull_request` work product for
the pull request. This is the link that the merge flow already uses, so the
gate reads the relation that the reviewer already reasoned about.

The gate reads the verdict comments from the covering ticket's thread. The
audit trail is therefore the same thread where the review already happened.

The head SHA comes from the live pull request, through the same resolver that
the merge flow uses to read the pull request state. The gate never trusts a
stored SHA for this, because a push that lands after the sign-off must not
inherit that sign-off.

## 5. The override

An override is an explicit, audited escape hatch. It requires a named author
and a reason. An override that is missing either one is refused.

The override is recorded in the result, so it travels with the evaluation
instead of living only in a log line. A silent override is the failure that
this gate exists to prevent, so the gate makes the override loud.

## 6. The components

| Component | Location | Role |
| --- | --- | --- |
| Verdict parser and evaluator | `packages/shared/src/types/merge-readiness.ts` | Pure functions. No I/O, no clock, no network. |
| Database and GitHub resolution | `server/src/services/merge-readiness.ts` | Finds the covering tickets, reads their verdicts, reads the live head SHA. |
| Tests | `server/src/__tests__/merge-readiness.test.ts` | The rules in section 2. |

The evaluator is pure on purpose. The same evaluation can then run in the
server, in a CLI, and in a test, and the rules stay in one place.

## 7. Relation to other work

The pull request gardening skill has an opt-in sign-off check. It reads
`qa-approved` and `security-approved` markers and runs only when an operator
turns it on. It does not produce a first-class blocker and it has no audited
override path. The gate in this document covers a different layer: it is
platform code, it is on by default, and it produces a machine-readable refusal
reason.
