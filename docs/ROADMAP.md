# InfraLens roadmap

Updated: October 16, 2026. Repository baseline: `main` at `6b75915` (PR #57).

## Goal and scope

Build a useful AWS architecture analyzer and demonstrate persistence, asynchronous processing,
reliable delivery and cloud operations. Preserve npm workspaces, TypeScript and Mocha/Chai;
keep analyzer logic independent of AWS/React. Expand analyzer coverage only for a concrete workflow.
The full UI refactor and production deployment remain deferred.

## Status and next step

| Work | Status |
| --- | --- |
| Milestone 1: saved projects/history | Implemented; deployed to test; remaining browser cases below |
| Milestone 1.5: source-aware comparison | Merged; API/frontend deployed and code-only browser comparison confirmed by user |
| Frontend lazy loading | Merged and deployed per user; offline hosted initial JavaScript about 248 kB, down from 536 kB |
| Milestone 2: useful history | Next development task |
| Milestones 3-5: queues, dispatch, operations | Planned; implement in sequence |
| Production application | Deferred; region/readiness decision still required |

The user confirmed the current test API/frontend updates and working GetItem -> PutItem browser
comparison on October 16. Earlier authenticated smoke and direct storage tests also have successful
user reports. Previous offline verification passed 603 tests, workspace typechecks/builds and
frontend builds without the old chunk-size warning. This documentation update runs no live checks.

Proceed with milestone 2. Carry these unrecorded browser checks into its acceptance: localhost
test Cognito/API callback/CORS, reopening a saved report in a fresh session, two-user UI isolation,
and the complete saved Apply/compare/export flow. Passing API/storage tests alone does not prove them.

## Architecture and invariants

Current system: React via CloudFront, Cognito, REST API Gateway/Lambda, two DynamoDB metadata tables
and a private S3 artifact bucket. Local Express/in-memory adapters support AWS-free development.
Run summaries, analyzer/schema versions and parent-child provenance are milestone 2 additions.
SQS, Streams and Scheduler are future work.

- Derive owners from trusted Cognito claims and authorize every project, run, artifact and comparison.
  Local fake identity must never become a hosted bypass. Use bounded queries, quotas and opaque cursors.
- Save server-generated reports with owner-scoped idempotency and explicit partial-write recovery.
  Keep reports and original artifacts immutable; deletion revokes access immediately and retries cleanup.
- Reports remain until deletion, subject to quotas. Raw inputs expire after seven days; source retention
  is opt-in. Expiry/ownership checks are application controls, not eventual S3 lifecycle/DynamoDB TTL.
  Never reconstruct expired/unretained inputs from reports.
- Preserve stateless analysis and template-only callers. Source inference is incomplete and cannot
  establish effective IAM permissions or prove a disappearing action is unused.
- Keep the persistent test stack and scoped operating profiles. Use guarded workflows for authorized
  AWS operations; preserve the custom bootstrap. See [handoff](../HANDOFF.md) and
  [deployment guide](PRODUCTION_DEPLOYMENT.md).

## Milestone 1: saved projects and history - implemented

Projects/runs support owner-scoped CRUD, pagination, server-side analysis, private artifacts,
retry-safe saves, quotas, retention and deletion/cleanup. The test deployment, authenticated smoke
and storage checks have successful user reports; broader browser acceptance carries into milestone 2.
Storage contracts and failure behavior are documented in [saved projects](SAVED_PROJECTS.md).

## Milestone 1.5: source-aware comparison - implemented

API/UI compare independent old/new templates, source trees, mappings and exclusions. Action/evidence
and before/after IAM suggestion deltas appear in results and Markdown. Apply navigation preserves
source; saved comparison uses only authorized, opted-in, unexpired inputs. Missing source differs
from an empty analyzed tree. The CLI remains template-only.

The unchanged-template GetCommand -> PutCommand fixture produces an explained IAM suggestion change
with no resource/finding delta. This works offline and in the test browser per the user's report.
See [comparison contracts, limits and semantics](SOURCE_COMPARISON.md) and
[browser fixtures](../examples/compare/README.md).

## Milestone 2: Make History Useful

**Next development task. Outcome:** a project explains how its architecture and analysis changed
across saved runs.

1. Add analyzer/schema version metadata with a compatibility path for existing records/reports.
   Legacy versions must be explicitly unknown, not assumed current. Storage's conditional-write
   `version` field is separate from these versions. Recomputed comparisons use the current analyzer;
   distinguish those results from historical saved output.
2. Show run summaries, findings, timestamps and changes using existing chronological history and
   source-aware two-run comparison. Explain when analyzer-version differences limit interpretation
   of finding changes.
3. Apply selected fixes and save a new child run linked to its original. Preserve the original run;
   validate parent ownership, fix staleness and generated templates. Reuse server-side analysis,
   idempotency, retention choices and quotas rather than trusting a browser-supplied report.
4. Add explicit reanalysis of retained inputs with the current analyzer. Expired inputs require
   reupload; unretained source requires reupload or a clearly labeled template-only choice. Keep
   source context and distinguish reanalysis from reopening the stored report.
5. Display additional source evidence only where it explains a saved result or manual review.
   This is supporting UI work, not a general redesign or analyzer expansion.

Start with shared contracts/legacy behavior, then API/storage, UI and acceptance. Reuse the current
workspaces, storage services and comparison code; document consequential choices briefly.

**Done when:** save -> fresh-session reopen -> apply -> save child -> compare -> export works with
persistent artifacts. Explicit reanalysis records the analyzer used. Legacy records stay readable;
missing/expired source, cross-owner references, deletion, duplicate saves and stale fixes are tested.
Run offline checks first, then verify the authorized test deployment and browser workflows, including
the remaining milestone 1 checklist. See [testing](TESTING.md) for existing adapters and live guards.

## Milestone 3: asynchronous analysis with SQS

**Outcome:** submit analysis, leave/refresh, then return to its persistent status and result.
This is a learning/burst-handling extension, not a claim the current analyzer is too slow.

- Return `202` and a run ID; provide owner-authorized status polling with backoff. Preserve synchronous
  offline/stateless analysis. Queue IDs and immutable artifact references, not raw templates/source.
- Model `PENDING_DISPATCH -> QUEUED -> RUNNING -> SUCCEEDED/FAILED` with conditional transitions.
  Initially send from the API; persist dispatch intent and add bounded recovery queries plus scheduled
  reconciliation. A failed send after a metadata write must not strand an accepted job.
- Handle at-least-once delivery with conditional claims, expiring leases and attempt/fencing tokens.
  Publish immutable attempt output only if the worker still owns the claim. A stale worker or dispatch
  acknowledgement must not overwrite a newer state/result.
- Separate retryable infrastructure errors from terminal invalid input. Configure visibility timeout,
  bounded retries, a DLQ and partial batch failures. Reconcile stale/DLQ jobs into visible failure;
  document redrive and explicit user retries as linked new attempts/runs.
- Use separate API/worker roles, bounded concurrency, per-user pending quotas and queue alarms.
  Workers recheck project/run deletion before publishing; an in-flight job must not resurrect data.

**Done when:** duplicate delivery publishes one result; worker crashes recover; poison jobs become
visible failures; missed sends recover; deleting an active project keeps it inaccessible. Demonstrate
these boundaries with a small controlled workload and retain the recovery path for milestone 4.

## Milestone 4: reliable dispatch and artifact transfer

**Outcome:** durable job intent drives processing even if the API stops after writing metadata.

- Replace API-side SendMessage with DynamoDB Streams and a dispatch Lambda. Store job/dispatch intent
  atomically. Filter irrelevant updates; send to SQS and conditionally acknowledge dispatch. Retain
  worker idempotency because a send/acknowledgement crash can duplicate delivery.
- Keep pending intent beyond stream retention. Use a bounded, time-bucketed recovery index, monitor
  stream lag/failures and reconcile missed events. Compare this design with direct-send/reconcile in
  a short decision record; neither pattern promises exactly-once execution.
- Add constrained, short-lived S3 uploads. Finalization checks owner, manifest, size and checksums,
  then pins an immutable object version/snapshot so reusable upload URLs cannot replace accepted input.
  Preserve analyzer input limits.
- Use EventBridge Scheduler for bounded recovery/cleanup with checkpointing and retryable deletion.
  Cover abandoned staging uploads and noncurrent versions without deleting active-job inputs.

**Done when:** failures at API/dispatcher write/send boundaries recover every accepted job; duplicates
remain harmless; upload replacement/expiry cases pass; interrupted cleanup resumes without data loss.

## Milestone 5: operate, measure and explain

**Outcome:** reproducible releases with evidence about reliability, capacity, recovery and cost.

- Add CloudWatch dashboards/alarms for queue age/depth, end-to-end latency, failures/retries, DLQ,
  dispatch lag and storage errors. Correlate API/run/attempt IDs without logging raw inputs or secrets.
- Establish budgets, bounded load tests and teardown procedures. Measure throughput/p95 latency and
  bottlenecks before adding services. Estimate costs from workload assumptions and current pricing;
  budget alerts are not spending limits.
- Add appropriate metadata/artifact recovery. Exercise DynamoDB restoration to a separate table and
  explain S3 references, expired data and deliberately deleted access. Recovery must not resurrect
  deleted user access.
- Automate scoped GitHub Actions OIDC releases, test checks and rollback; keep production approval
  explicit. Add browser coverage for persistence/job recovery and hosted two-user checks. Mocks do
  not establish live Cognito, storage or queue behavior.

**Done when:** documentation supports deploying, verifying, failure-testing, restoring and tearing
down an environment, with measured results and honest limitations.

## Production readiness - deferred

Develop and verify in the existing test environment. Revisit production when the chosen workflow
has local/test acceptance, repeatable releases/rollback, reviewed scoped permissions, audit/budget
monitoring and appropriate recovery. Confirm the production region and frontend/Cognito origins,
then review a concrete deployment diff and make a separate first-deployment decision. Leave its
existing bootstrap unchanged. Production need not wait for every optional experiment.

## Optional scale lab - choose at most one

Use a measured trigger or labeled simulated workload and an explicit stopping point:

| Trigger | Experiment | Required evidence |
| --- | --- | --- |
| Lambda limits or compute economics | ECS Fargate worker on the existing queue | Cost/latency, queue draining and lease recovery |
| Independently retryable workflow stages | Step Functions Standard | Stage failure/recovery and clear retry ownership |
| Independent consumers of completed runs | EventBridge | Real consumer with failure/replay behavior |

Defer Redis, OpenSearch, EKS, multi-region, team permissions and billing until a concrete need.

## Final milestone: complete showcase

After the core milestones and any chosen scale lab, demonstrate sign-in -> project -> template/source
submission -> queued result -> evidence/graph -> save/reopen -> apply child -> compare/export, plus
an intentional failure and recovery. Keep small development fixtures throughout earlier work.

Provide application and analyzed-architecture diagrams, screenshots/walkthrough, reproducible setup,
test/load evidence, approximate cost and four or five explained design decisions. Clearly distinguish
implemented, measured and future behavior; protect authenticated data. Another developer should be
able to follow the workflow and reproduce its failure story. Resume analyzer expansion for a specific
purpose after this release.
