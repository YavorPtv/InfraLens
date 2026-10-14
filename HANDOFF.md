# InfraLens handoff

Updated: October 14, 2026. Read AGENTS.md first, then inspect Git and the relevant code.

October 12 fixture addition: examples/compare/before/project and after/project each contain one
tiny handler (two source lines plus `// @ts-nocheck`) for manual browser upload. Use source-action-template.json on both sides and
explicit AppFunction mappings for high confidence. Auto detect also shows the delta, with manual-review
suggestions. The analyzer verified the GetItem -> PutItem action/suggestion delta
with no resource/finding changes. Instructions are in examples/compare/README.md; browser acceptance
remains pending.

## Repository and boundaries

- Feature checkout: feature/source-aware-comparison, based on main. The baseline includes Feature/separate aws environments (#55), hosted-test
  workflows and scoped storage/frontend publishing. Milestone 1.5 changes are on this feature branch;
  inspect Git for the latest revision and any subsequent changes.
- Keep npm workspaces, TypeScript, Mocha/Chai and the existing layout. Analyzer logic stays independent
  of AWS/React in packages/analyzer; shared contracts in packages/shared; API/UI in apps/api and apps/web;
  infrastructure/workflows in infra/cdk. Ask before restructuring; preserve unrelated changes.
- Update docs/ROADMAP.md whenever a task completes or changes milestone status, scope, priorities or
  remaining work. Before handing off or committing, check that the roadmap and HANDOFF.md agree with
  the implemented behavior and verified results; do not mark unverified work complete.
- This task implemented milestone 1.5 on the focused feature branch. Offline verification passed.
  Do not commit/push, deploy/bootstrap/destroy, modify IAM/Organizations or run browser/hosted/live-storage
  tests without explicit authorization. Read-only AWS inspection with the supplied profiles is allowed
  when needed, after verifying caller account. Never request secrets/tokens in chat.

## Milestone 1.5 implemented; next: authorized acceptance checks, then milestone 2

Read milestone 1.5 in docs/ROADMAP.md and docs/SOURCE_COMPARISON.md. Production remains deferred.
Recommendation: browser/hosted acceptance for source-aware comparison -> milestone 2 history
improvements -> later queue/operations work. Milestone 1's remaining browser checks are still pending.

Verified current behavior:

- POST /diff keeps oldTemplate/newTemplate strings and accepts optional independent oldSource/newSource
  objects with sourceFiles/mappings/exclusions. Each side uses existing normalization and source analysis.
  Defaults: 100 files/side, 256 KiB/file, 2 MiB combined source, 1 MiB/template, 4 MiB serialized request.
- Analysis reports include optional sourceAnalysis metadata; DiffReport adds source and suggestions
  deltas. Code-only GetCommand -> PutCommand changes produce before/after suggestions and evidence
  without resource/finding changes. Missing source differs from a provided empty tree. Inference is
  explicitly not effective IAM permissions; disappearing observations do not prove unused permission.
- Compare has independent source folder/files uploads, mappings and exclusions. Markdown export and
  saved comparison use the same evidence semantics. Analyze -> Apply -> Compare carries source to both
  sides, including reopened opted-in saved inputs. CLI remains template-only and passes existing tests.
- History compares only authorized retained inputs, preserving source when opted in and unexpired.
  OpenSavedRun adds optional input while keeping template compatibility. Unretained source is missing;
  history offers template-only available-input comparison or reupload. Empty opted-in trees are retained.
  Expiry/deletion/ownership are rechecked after artifact reads; expired reports remain readable.

October 11 verification: 603 offline tests passed (187 API, 17 CLI, 289 analyzer, 21 shared, 89 CDK),
plus npm run typecheck, npm run build and git diff --check. Sandbox loopback restrictions required
an approved offline API rerun. Existing Vite >500 kB warning remains. No AWS deployment, hosted tests,
live-storage tests or manual browser checks ran. Test deployment/publishing and browser acceptance
still need explicit authorization before milestone 1.5 can be declared hosted-verified.

The latest user-reported browser attempt used local React against the AWS test API and returned
"Source comparison metadata unavailable". The local upload/serialization/API pipeline was rechecked
with the actual browser fixtures and produced the expected delta, including with @ts-nocheck.
The AWS test backend update and successful browser acceptance have not been reported complete.

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
