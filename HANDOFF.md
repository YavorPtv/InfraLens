# InfraLens handoff

Updated: October 24, 2026. Read [AGENTS.md](AGENTS.md), inspect Git, then read the relevant code.

## Current state

- Milestone 2 is implemented on `main` and deployed to AWS test. Its starting point was
  `217481a`, the handoff/roadmap refresh after source-aware comparison and lazy loading in PR #57.
- Milestone 1 provides saved projects/runs, server-generated reports, idempotent saves, authorized
  artifacts, quotas, retention and deletion. Milestone 1.5 adds independent source-aware comparison
  across API, UI, saved runs, Apply navigation and Markdown export. The CLI remains template-only.
- On October 16 the user confirmed both the updated AWS test API and hosted frontend are deployed
  and the browser GetItem -> PutItem comparison works. Earlier authenticated smoke, direct storage
  tests and frontend publishing also have successful user reports. These are not new live checks
  performed by the assistant.
- Five application pages now load on demand. The verified offline hosted build reduced initial
  JavaScript from about 536 kB to 248 kB and removed the 500 kB warning.
- Milestone 2 adds analyzer/report-schema versions, run summaries, linked Apply/reanalysis children,
  source evidence and historical-versus-recomputed comparison labels. On October 24 the assistant
  deployed the backend through the guarded test workflow, published the frontend (including the
  Apply CSS fix), and verified CloudFront invalidation completion. The stack is UPDATE_COMPLETE.
- Offline verification: 609 Mocha/Chai tests passed, workspace typechecks and builds passed.
  The local Vite build's initial JavaScript is about 247 kB, with no chunk-size warning.
- October 24 live verification: 18 public HTTP smoke checks and four real DynamoDB/S3 tests passed.
  Browser acceptance passed hosted save/source -> fresh-session reopen -> preview two fixes ->
  save child -> compare -> download Markdown; findings fell from 4 to 2 and score rose 45 -> 85.
  Retained-source, missing-source/template-only and reuploaded-source reanalysis passed, as did
  localhost test Cognito callback/CORS, saving/reopening/logout and two-user UI isolation both ways.
  An existing October 10 legacy report remained readable with unknown versions; expired inputs
  disabled reanalysis and were absent from the reupload form. That existing project was not changed.
  See [testing](docs/TESTING.md#october-24-2026-milestone-2-acceptance) for evidence and limits.

## Next task: milestone 3, when requested

[Milestone 2](docs/ROADMAP.md#milestone-2-make-history-useful) is implemented, deployed to test and
accepted in the browser. Milestone 3 remains planned; no queue implementation has started.

New reports use analyzer `0.2.0` and report schema `2`. Legacy metadata/report fields stay readable
and explicitly unknown; historical objects are not rewritten. Bump the analyzer constant in
`packages/analyzer/src/analyzeTemplate.ts` when behavior changes and the schema constant in shared
history contracts when the report format changes.

`POST /projects/:projectId/runs/:runId/apply` accepts selected fix IDs; the server regenerates current
fixes, rejects stale selections, validates the generated template and saves a child. `/reanalyze`
explicitly saves a current-analyzer child from retained or reuploaded inputs. Missing/unknown source
requires reupload or `templateOnly: true`. Reuploaded Apply inputs must match stored digests; expired
legacy inputs without digests must first be reanalyzed. Parent checks participate in reservation and
publication transactions. The original report/artifacts stay immutable; only the conditional-write
version of a parent is advanced to serialize against deletion.

Start with these files:

- `packages/shared/src/history.ts`: current saved-run/API contracts.
- `apps/api/src/historyService.ts`, `historyStore.ts`, `historyRoutes.ts`: saves, artifacts, ownership,
  retention, comparison and storage records. `StoredRecord.version` is for conditional writes;
  it is not a report schema or analyzer version.
- `apps/web/src/pages/ProjectsPage.tsx`, `SavedReportPage.tsx`, `ReportPage.tsx`,
  `components/report/ApplySuggestionsPanel.tsx`, `api/historyClient.ts`: history and Apply flows.
- `apps/api/test/history.integration.test.ts`, `sourceComparison.integration.test.ts`: existing
  adapter/retention/ownership coverage. Use the established Mocha/Chai conventions.

Keep these guarantees:

- Saves analyze inputs on the server; browser report JSON is not authoritative. Preserve retry-safe
  saves, quotas, ownership checks, immutable original runs and deletion enforcement.
- Raw inputs expire after seven days; source retention is opt-in. `OpenSavedRun.input` exposes only
  authorized, unexpired retained input. Expired inputs require reupload; never reconstruct raw source
  from reports. Missing source needs reupload or an explicitly labeled template-only choice.
- Comparisons recompute with the current analyzer. Preserve independent old/new source files,
  mappings and exclusions; identify analyzer/schema differences rather than implying historical replay.
- Source actions are static inferences, not effective IAM permissions. Missing or incomplete source
  does not prove unused permissions. See [source comparison semantics](docs/SOURCE_COMPARISON.md).

The guarded hosted HTTP suite is extended for child Apply, retries, comparison/export and reanalysis.
It and authenticated scripted smoke were not run on October 24: credentials were not injected, and
the user instead signed in manually for the real browser checks. Public smoke's one authenticated
case was explicitly pending, not passed. No credentials/tokens were extracted or stored. This is
separate from the successful browser and direct-storage evidence. The user subsequently authorized
committing milestone 2 directly to `main`, pushing it and synchronizing the local checkout.
The broad UI refactor and production remain deferred.

The browser acceptance project `Milestone 2 acceptance 2026-10-24` was left for review under user A
with seven small fixture runs. Direct storage tests cleaned their own random test-owner records
and artifacts. The temporary localhost AWS-test Vite process was stopped after verification.

## Environment and operating boundaries

| Environment | Account / region / stack | State |
| --- | --- | --- |
| Fully local | No AWS | React + Express, memory history, explicit local identity |
| AWS test | `230944684535` / `eu-central-1` / `InfraLensTestStack` | Milestone 2 deployed and browser-verified October 24 |
| Production | `609124256824` / region unconfirmed / proposed `InfraLensProdStack` | Application deployment deferred |

- Keep the existing workspaces: analyzer in `packages/analyzer` independent of AWS/React, contracts
  in `packages/shared`, API/UI in `apps/api` and `apps/web`, CLI in `apps/cli`, infrastructure in
  `infra/cdk`. Ask before restructuring. Update this handoff and the roadmap when scope/status changes.
- Commits/pushes, deployments, IAM changes and browser/hosted/live-storage tests require explicit
  authorization. Production remains deferred. Read-only AWS inspection is allowed when needed after
  verifying caller account. Never request secrets in chat or commit generated outputs/environment files.
- Use scoped profiles: `infralens-test-deploy`, `infralens-test-frontend`, `infralens-test-storage`.
  Administrator profiles are not routine deployment identities. Keep the persistent stack deployed.
- Test `CDKToolkit` is customized (`InfraLensTestScopedV1`, qualifier `hnb659fds`, version 32,
  application permissions boundary). Do not overwrite it with default bootstrap. Leave production
  bootstrap unchanged. Old repair procedures are historical, not setup steps to repeat.
- Use the existing guarded deployment/publishing and live-test workflows. Frontend-only changes need
  frontend publishing; API/analyzer changes need a backend deployment. Local React in `aws-test-local`
  mode calls test Cognito/API directly; fully local mode is a separate AWS-free workflow.

## Reference documents

- [Roadmap](docs/ROADMAP.md): scope, order and acceptance criteria.
- [Saved projects](docs/SAVED_PROJECTS.md): storage, ownership, idempotency, retention and cleanup.
- [Source comparison](docs/SOURCE_COMPARISON.md), [uploads](docs/SOURCE_UPLOADS.md) and
  [analyzer coverage](docs/ANALYZER_COVERAGE.md): contracts, inference limits and evidence semantics.
- [Testing](docs/TESTING.md): offline/live commands and persistent Cognito fixtures.
- [Deployment](docs/PRODUCTION_DEPLOYMENT.md): environment configuration and guarded commands.
- [Test permissions](docs/TEST_DEPLOYMENT_PERMISSIONS.md): custom bootstrap/policy details, if needed.
- [Tiny comparison fixture](examples/compare/README.md): template and before/after source folders.
