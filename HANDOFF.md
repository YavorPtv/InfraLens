# InfraLens handoff

Updated: October 11, 2026. Read AGENTS.md first, then inspect Git and the relevant code.

## Repository and boundaries

- Current checkout: main at cf2363e, Feature/separate aws environments (#55). It includes hosted-test
  workflows and scoped storage/frontend publishing. This documentation refresh is committed on main;
  inspect Git for the latest revision and any subsequent changes.
- Keep npm workspaces, TypeScript, Mocha/Chai and the existing layout. Analyzer logic stays independent
  of AWS/React in packages/analyzer; shared contracts in packages/shared; API/UI in apps/api and apps/web;
  infrastructure/workflows in infra/cdk. Ask before restructuring; preserve unrelated changes.
- Update docs/ROADMAP.md whenever a task completes or changes milestone status, scope, priorities or
  remaining work. Before handing off or committing, check that the roadmap and HANDOFF.md agree with
  the implemented behavior and verified results; do not mark unverified work complete.
- This task updated documentation only. Recommended next task is below; its implementation has not
  started. Create a focused feature branch from current main when the user authorizes implementation.
  Do not commit/push, deploy/bootstrap/destroy, modify IAM/Organizations or run browser/hosted/live-storage
  tests without explicit authorization. Read-only AWS inspection with the supplied profiles is allowed
  when needed, after verifying caller account. Never request secrets/tokens in chat.

## Recommended next task: source-aware comparison

Read milestone 1.5 in docs/ROADMAP.md. The user considers this extremely important and prefers to
defer production deployment. Recommendation: source-aware comparison -> milestone 2 history
improvements -> later queue/operations work. Remaining manual browser checks can happen alongside it.

Verified current behavior:

- packages/analyzer/src/templateDiff.ts already accepts independent oldTemplate/newTemplate analysis
  options, including source files/mappings/exclusions, and returns both analysis reports.
- apps/api/src/analyzeRequest.ts parses POST /diff into two template strings and calls the analyzer
  without those source options. apps/web/src/api/compareTemplates.ts and pages/ComparePage.tsx send
  only templates. The CLI diff is also template-only.
- apps/api/src/historyService.ts compare reads retained input.template and drops retained source.
  Source retention is opt-in; raw inputs expire after seven days. Expiry/ownership/deletion enforcement
  must remain intact. Saved reports remain readable after input expiry; they are not raw-input backups.
- DiffReport in packages/shared/src/index.ts and the Compare UI summarize resources/findings only.
  A code-only AWS operation change can affect least-privilege suggestions without changing either list.
- apps/web/src/components/report/ApplySuggestionsPanel.tsx navigates to Compare with only the
  original/generated templates. Do not lose source context when wiring Analyze -> Apply -> Compare.

Next feature should preserve template-only compatibility, support independent old/new source context
through API/UI/saved comparison, and explain material source-inferred AWS action/IAM suggestion changes
with evidence, confidence and warnings. Missing/unretained source must be explicit; expired inputs
require reupload. Reuse existing source normalization/upload helpers. Do not add unrelated analyzer
rules or infrastructure services. Start with an unchanged-template fixture whose source changes an AWS
read into a write; cover it with analyzer/shared/API adapter tests before UI integration. Agree on report
semantics and request limits; details/acceptance criteria are in the roadmap.

Milestone 2 still needs run summaries, analyzer/schema version metadata, compatibility for existing
records, apply-to-child provenance and explicit reanalysis. Basic two-run template comparison already
exists. Queues, Streams, Scheduler and asynchronous jobs are future work, not current infrastructure.

## AWS and frontend status

| Environment | Account / region / stack | Status |
| --- | --- | --- |
| Fully local | No AWS | React + Express, memory history and explicit fake local identity |
| AWS test | 230944684535 / eu-central-1 / InfraLensTestStack | Persistent deployment and frontend working per user report |
| Production | 609124256824 / proposed eu-central-1 / InfraLensProdStack | No application stack; region unconfirmed; deployment deferred |

- Test resources are described in ignored infra/cdk/cdk-outputs.test.json. Never invent resource names
  or commit outputs, generated .env files, passwords or tokens. Hosted authentication uses test Cognito;
  health/OPTIONS are public, all analysis/history routes require authentication.
- CloudFront and http://localhost:5173 both use test Cognito/API/data. Local React mode aws-test-local
  needs no Express API or CLI credentials. Fully local mode remains a separate AWS-free option.
- User reports authenticated GitHub smoke passed, all three direct storage tests passed, and guarded
  frontend publishing worked. Localhost callback/CORS and granular fresh-session/two-user UI checks
  have not been individually reported complete; do not claim they were independently verified.
- infralens-test-admin and infralens-prod-admin are administrators, not restricted deployment identities.
  Dedicated test profiles/permission sets: infralens-test-deploy / InfraLensTestDeploy,
  infralens-test-storage / InfraLensTestStorage, infralens-test-frontend / InfraLensTestFrontend.
  Storage access covers only reserved test-* owner namespaces; frontend access covers its bucket/cache.
- Test CDKToolkit is customized: version 32, qualifier hnb659fds, variant InfraLensTestScopedV1, with an
  administrator-owned application boundary. Do not run default bootstrap over it. Leave production
  CDKToolkit unchanged. Policy details and old repair history belong in docs/TEST_DEPLOYMENT_PERMISSIONS.md.
- Test CloudTrail infralens-test-audit was verified read-only October 4: active multi-region management
  logging. It stays separate from the app. Management-account $1 budget scope/alerts are unverified.
  Production permissions, audit, cost monitoring and recovery need a later readiness review.

## Verification and workflow entry points

- Normal npm tests/typechecks/builds and synthesis are credential-free; live files are outside *.test.ts
  discovery. Use guarded commands, not direct Mocha invocation of live suites. Keep the stack deployed
  between runs; no automatic teardown or bucket emptying. Retained resources need intentional cleanup.
- Recent October 10 checks passed: 39 related offline guard/policy tests, workspace typechecks, hosted
  Vite build, policy validation and read-only IAM simulations. Existing Vite >500 kB warning remains.
  These do not prove every browser/live case. This documentation refresh ran no AWS or live tests.
- infra/cdk/src/deployment-workflow.ts: explicit target synthesis/preflight/diff/deploy/frontend config.
  Online commands verify actual caller account and intended region/stack; profile names are not proof.
- infra/cdk/src/hosted-test-workflow.ts: test-only test:smoke, test:hosted, test:aws, test:users:setup.
  Hosted/storage writes require matching live outputs/profile and --allow-test-data true; setup requires
  --allow-user-setup true. Storage checks do not need Cognito credentials.
- apps/api/test/testUserAuthentication.ts obtains fresh OAuth/PKCE tokens and refreshes in memory for
  two persistent confirmed Cognito fixtures. Credentials live in protected process/GitHub secrets;
  manual access-token variables are retired. Routine runs do not provision users/reset passwords.
- .github/workflows/deployed-smoke.yml is manual, environment aws-test, authenticated by default.
  Authenticated mode includes public checks; skipping the public-only step is expected. After merging,
  allow main in environment branch rules and run from main; completion of that change/run is unverified.
- infra/cdk/src/test-storage-permissions.ts and test-frontend-workflow.ts generate offline policy files.
  Frontend publisher rebuilds with pinned test settings, uploads assets before index, preserves old
  files and waits for CloudFront invalidation. No backend/storage deployment is needed for publishing.

## Documentation to consult

- docs/ROADMAP.md: priority/order and source-comparison acceptance criteria.
- docs/TESTING.md: offline/live commands, fixture setup and scoped storage permission set instructions.
- docs/PRODUCTION_DEPLOYMENT.md: environment setup, localhost modes and guarded frontend publishing.
- docs/SAVED_PROJECTS.md: ownership, idempotency, retention, deletion and cleanup behavior.
- docs/SOURCE_UPLOADS.md and docs/ANALYZER_COVERAGE.md: source normalization/mapping and inference limits.
- docs/TEST_DEPLOYMENT_PERMISSIONS.md: custom bootstrap/policy design; read only if relevant to AWS work.
