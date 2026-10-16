# InfraLens handoff

Updated: October 16, 2026. Read [AGENTS.md](AGENTS.md), inspect Git, then read the relevant code.

## Current state

- Current checkout: `main` at `6b75915`, source-aware comparison and frontend lazy loading merged
  in PR #57. The working tree was clean before this documentation update.
- Milestone 1 provides saved projects/runs, server-generated reports, idempotent saves, authorized
  artifacts, quotas, retention and deletion. Milestone 1.5 adds independent source-aware comparison
  across API, UI, saved runs, Apply navigation and Markdown export. The CLI remains template-only.
- On October 16 the user confirmed both the updated AWS test API and hosted frontend are deployed
  and the browser GetItem -> PutItem comparison works. Earlier authenticated smoke, direct storage
  tests and frontend publishing also have successful user reports. These are not new live checks
  performed by the assistant.
- Five application pages now load on demand. The verified offline hosted build reduced initial
  JavaScript from about 536 kB to 248 kB and removed the 500 kB warning.
- Previous implementation checks passed: 603 offline tests, workspace typechecks/builds, and local/
  hosted frontend builds. This documentation update does not rerun them or perform AWS operations.

## Next task: milestone 2 - make history useful

Proceed with [milestone 2 in the roadmap](docs/ROADMAP.md#milestone-2-make-history-useful).
There is no known prerequisite code change before starting it. The user plans a separate chat.

Implement run summaries, analyzer/schema version metadata with legacy compatibility, Apply-to-child
provenance, and explicit reanalysis. Reuse the existing source-aware saved comparison.

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

Carry into milestone 2 acceptance: record fresh-session saved-report reopening, localhost test
Cognito/API callback/CORS, two-user UI isolation, and the full save -> reopen -> apply -> save child
-> compare -> export workflow. The confirmed code-only comparison does not establish all those cases.
The broad UI refactor is deferred; limit UI work to the history feature and useful evidence.

## Environment and operating boundaries

| Environment | Account / region / stack | State |
| --- | --- | --- |
| Fully local | No AWS | React + Express, memory history, explicit local identity |
| AWS test | `230944684535` / `eu-central-1` / `InfraLensTestStack` | Persistent API/frontend; current updates confirmed by user |
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
