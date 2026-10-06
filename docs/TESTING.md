# Workflow testing

All automated tests use Mocha and Chai. Existing unit tests exercise isolated rules, parsing,
inference, fixes, exporters and validation. `apps/api/test/*.integration.test.ts` exercises real
modules together through temporary Express HTTP servers and the API Gateway Lambda adapter.
No browser, frontend server, AWS SDK, additional dependency, or deployment is needed.

## Local commands

```sh
npm ci
npm run test:integration
npm run typecheck
npm run build
npm test
```

On PowerShell, use `npm.cmd` when required by execution policy. `test:integration` builds the shared
and analyzer packages first, since workspace runtime imports resolve their compiled output.
`npm test` retains the existing test globs and includes integration tests. On a fresh checkout,
build before `npm test`, as normal CI already does. No test suite is reorganized.

## Covered workflows and fixtures

| Suite | Boundaries and assertions |
| --- | --- |
| `workflow.integration.test.ts` | Analyze with source -> review actual structured fixes -> select IAM narrowing and DynamoDB PITR -> apply via HTTP -> analyze generated JSON -> compare via HTTP -> export. Checks object immutability at the real apply boundary, exact intended edits, retained intrinsics and unrelated properties, unselected applicable fixes, manual findings, changed resources, resolved/unchanged findings, and absence of introduced findings. JSON and Markdown exports preserve findings, evidence and suggestions without dumping uploaded source bodies. |
| `sourceWorkflow.integration.test.ts` | Source upload, explicit mappings to two separate roles, scoped resource ARNs, exact package/command actions, handler and filename mapping confidence, unresolved source, and unknown/non-Lambda logical IDs. Transitive and shared imports contribute once to each reachable Lambda; unrelated source and a separate queue tree do not leak actions. Cycles and duplicate import paths terminate and deduplicate evidence. Excluded shared files still contribute through handler imports. |
| `apiContract.integration.test.ts` | Real Express/Lambda parity for analysis, base64 API Gateway input, apply and diff. Both adapters reject missing bodies, malformed templates/diffs/fixes, excessive templates/request bodies/source count/source bytes and invalid mapping shapes. One injected analyzer exception verifies the actual route/logging/error conversion boundary returns `500 ANALYZER_INTERNAL_ERROR`. |
| `sourceProject.integration.test.ts` | Real web upload transformation and serialization -> Express/Lambda -> analyzer -> exports. Duplicate basenames, selected folder prefixes, normalized raw API paths, nested/circular imports, shared actions, isolated roles, preserved confidence and full-path evidence. |
| `templateValidation.integration.test.ts` | Express/Lambda parity for parse/structure failures, internal analyzer failures, AWS valid/invalid/unavailable mappings, validated apply/compare and deliberately corrupted generated output. No live AWS calls. |
| `sourcePathContract.integration.test.ts` | Both adapters reject unsafe paths and normalized collisions and retain source/request count and byte limits for nested paths. |

`sourceUpload.test.ts` exercises the actual frontend helper's replacements, mapping preservation,
removal, re-addition, folder filtering and read failures without a browser. These tests live in the
existing API Mocha suite; its test tsconfig includes the imported frontend helpers. Shared path unit
tests and analyzer path-resolution unit tests cover normalization and conservative automatic mapping.

Reusable fixture loading lives in `apps/api/test/workflowFixtures.ts`, resolved relative to the
helper rather than the shell's current directory. The tests reuse these small existing fixtures:

- `examples/order-service-risky-template.json`: realistic API, Lambda, IAM, DynamoDB, queue and logs.
  Selected fixes leave missing DLQ/log retention, unselected deletion protection/tracing, public API
  authorization and the separate logs wildcard statement visible.
- `examples/analyzer-coverage/`: managed policies, boundaries, conditions, explicit Deny,
  transitive S3 imports, alias evidence, statement splitting and a DynamoDB index query.
  Covered by analyzer regression suites and the local API analyze/apply integration suite.
- `examples/source-file-lambda-mapping/template.json`: two Lambdas with distinct roles and targets.
- `examples/shared-source-import-graph/`: handlers, transitive database helper, shared SDK source,
  queue helper and unrelated delete action. Its `sharedDb.ts` and `queueClient.ts` supply real SDK
  package evidence for explicit upload tests; the other example's mock commands lack that evidence.
  Cycle variants add short import edges to fresh in-memory copies, leaving fixtures untouched.
- `examples/nested-source-project/`: Orders, Audit and Payments handlers with repeated basenames,
  separate service files, a transitive shared DynamoDB helper, a deliberate cycle and unrelated code.
  See [Source project uploads](SOURCE_UPLOADS.md) for the upload and API identity rules.

These fixtures are analyzer inputs, never executed or deployed. Tests assert meaningful report
fields and specific edits instead of storing whole report snapshots. Existing rule unit tests
continue to cover the current 16 rules; integration fixtures are representative workflows, not a
second exhaustive rule matrix.

## Template validation tests

`packages/analyzer/test/templateValidation.test.ts` covers syntax/structure stages, intrinsics,
immutability, generated regressions and the shared download gate. `apps/api/test/cloudFormationValidation.test.ts`
checks the SDK command boundary, rejection/unavailability mapping, timeout and the UTF-8 body limit.
Tests use injected validators; normal Express/Lambda factory calls stay offline regardless of shell
configuration. CDK assertions check only ValidateTemplate is added and log permissions remain scoped.
See [Template validation](TEMPLATE_VALIDATION.md) for the stage contract and limits.

## Persistent AWS test workflows

Live checks use the existing InfraLensTestStack in test account 230944684535, eu-central-1.
They stay outside normal *.test.ts discovery and never deploy, bootstrap or destroy infrastructure.
Resource details come from ignored infra/cdk/cdk-outputs.test.json, which must contain only the test
stack's current outputs. Copy the full output file when moving to another machine; credentials and
access tokens do not belong in it. Do not use historical failed-stack inventories for configuration.

From the repository root, commands available after the test deployment:

```powershell
# Public HTTP smoke: no AWS credentials or user token required.
npm.cmd run test:smoke -- --target test

# Hosted save/restore/two-user isolation: requires test users and current tokens first.
aws sso login --profile infralens-test-deploy
npm.cmd run test:hosted -- --target test --region eu-central-1 --stack InfraLensTestStack --profile infralens-test-deploy --allow-test-data true
```

Hosted tests require INFRALENS_TEST_USER_A_TOKEN and INFRALENS_TEST_USER_B_TOKEN in the process
environment. Obtain short-lived access tokens by signing in as two dedicated test Cognito users;
never paste them into chat, print them, commit them or store them in deployment outputs. There is
no automatic login/refresh or user creation in this refactor. Tokens must use the selected test pool,
client and openid scope; different token strings from the same user are rejected.

The guarded workflow accepts only --target test. For data-writing hosted/storage modes, it verifies
STS caller account, intended region/stack, stable application state and every local output against
CloudFormation before starting tests. A named profile and --allow-test-data true are mandatory.
Ambient AWS credentials, role overrides and endpoints are cleared before pinning that profile/region.
Profile names are not evidence of account identity. Missing/invalid mandatory configuration fails;
explicit commands do not silently skip an entire suite. Normal tests remain credential-free.

Smoke checks public health, unauthenticated rejection for all 14 analysis/history methods, an invalid
bearer token, and optionally authenticated analysis. It reads validated local outputs and performs
HTTP calls only; it does not contact STS or independently establish live account ownership. A stale
URL fails its HTTP assertions. Set INFRALENS_SMOKE_ACCESS_TOKEN through your secure process environment
for authenticated analysis; without it, that one test reports a skip. Authentication/user workflows
remain separate from public readiness checks. Supply --outputs PATH to use another public output file.

apps/api/test/hostedHistory.hosted.ts checks authenticated save/restore and cross-user read/delete/
download isolation. Cleanup deletes only the project created by that test. API deletion can retain
metadata tombstones; pending artifact cleanup fails visibly and preserves recovery metadata. No stack
or bucket is emptied. Every API request preserves the /test/ stage, rejects redirects and has a timeout.
Local JWT claim checks detect configuration mistakes; API Gateway verifies signatures/authorization.

## Direct storage checks: separate permission setup required

apps/api/test/history.aws.ts checks real DynamoDB transactions, idempotency, pagination, owner isolation
and private S3 signed downloads. Each test creates its own random owner namespaces in the persistent
stack; tests no longer depend on an earlier test having run. Cleanup removes only its namespaces,
including metadata tombstones, and retains metadata if artifact cleanup is pending.

This suite needs its own scoped storage-test identity: STS caller identity and DescribeStacks on the
test app, adapter access to only its tables/bucket, plus DynamoDB DeleteItem for test cleanup.
The existing infralens-test-deploy profile lacks this direct data access. Establish and review those
permissions separately; do not use the Lambda role or broaden it for test cleanup. No IAM changes
or new profile were created here. The following command requires that later setup:

```powershell
# Proposed profile name; configure it only after reviewed storage-test permissions exist.
aws sso login --profile infralens-test-storage
npm.cmd run test:aws -- --target test --region eu-central-1 --stack InfraLensTestStack --profile infralens-test-storage --allow-test-data true
```

INFRALENS_DISPOSABLE_AWS and manual smoke/API URL, table and bucket variables are retired. Remove
INFRALENS_SMOKE_API_BASE_URL, INFRALENS_TEST_API_URL, INFRALENS_TEST_PROJECTS_TABLE,
INFRALENS_TEST_RUNS_TABLE and INFRALENS_TEST_ARTIFACT_BUCKET from the process environment before using
the new commands. The workflow rejects legacy overrides; resource names are derived from outputs.
The data opt-in authorizes temporary test records/artifacts and cleanup, not stack teardown.
Direct Mocha invocation of live files is unsupported; use guarded npm commands.

## Manual smoke workflow in GitHub Actions

Long-term authentication design: provision two persistent test-only Cognito users in an idempotent
setup step and obtain fresh tokens automatically during each authenticated run. Keep user credentials
in protected secrets, not pre-generated access tokens. Automate the app's OAuth authorization-code/PKCE
flow so the tokens include its required scopes, then refresh or re-authenticate before expiry.
This acquisition helper is future work; the current refactor validates supplied tokens only.

The manual deployed-smoke.yml workflow remains HTTP-only and uses no AWS credentials. Set the repository
Actions variable INFRALENS_TEST_DEPLOYMENT_OUTPUTS to the full public JSON from the test output file;
replace the old URL variable. An optional INFRALENS_SMOKE_ACCESS_TOKEN Actions secret enables authenticated
analysis while valid. The job materializes an ignored output file and calls the same guarded smoke
command. Missing/malformed outputs fail the manually requested job. It does not deploy, upload assets,
create users or acquire/refresh tokens. Standard push/PR CI still builds and runs offline tests only.

## What passing tests guarantee—and what they do not check

- Cognito and API Gateway authorize deployed requests before invoking Lambda. Direct Lambda and
  local Express calls intentionally do not enforce hosted authentication. Existing CDK assertions
  verify Cognito protection and `openid` scope for all analysis routes; adapter integration tests
  verify request validation and error contracts, while deployed smoke tests check actual rejection.
  Cognito sign-in, PKCE, token refresh, invitation and browser session behavior remain manual.
- Source-action `confidence` is mapping confidence; `actionConfidence` is SDK-package confidence;
  `PolicySuggestion.confidence` is a separate aggregate. Handler mappings are medium, filename
  mappings low and explicit mappings high. Medium/low mapping evidence cannot auto-narrow actions.
- Unknown or non-Lambda explicit IDs are currently ignored by inference, allowing automatic fallback.
  Invalid mapping *shapes* return 400. Tests preserve both behaviors without changing validation.
  Unresolved actions are omitted from `AnalysisReport`, so the unresolved evidence assertion calls
  the public inference function alongside the API report assertion.
- Compare accepts templates only, without separate source trees. Diff exports therefore contain
  suggestions based on template evidence. Shared diff export supports Markdown; CLI diff JSON uses
  ordinary JSON serialization, which is exercised here. CLI argument/file-output behavior retains
  its existing tests; this suite does not spawn the CLI process.
- Unexpected analyzer failure needs the existing injectable callback to trigger deterministically;
  successful workflows use the real analyzer. No test-only production behavior was added.
- Browser upload controls, path preservation, navigation, selection rendering, clipboard and actual
  download clicks remain manual. Exporters are tested without a browser. Reports intentionally
  contain template properties (including inline `Code.ZipFile`, if supplied); the privacy assertion
  concerns separately uploaded source bodies, not redaction of the CloudFormation template.
- Generated templates pass local structure regression checks; AWS responses are simulated only at
  the validator boundary. Tests neither deploy templates nor prove complete CloudFormation schema
  validity or live AWS acceptance. CDK assertions check validation IAM/configuration, not deployed
  behavior. Hosted authenticated apply/diff, operational alarms and provisioning remain outside smoke
  coverage. Validation-state rendering and disabled download clicks still require manual UI checks.

## Saved projects checks

`apps/api/test/history.integration.test.ts` tests owner isolation, server-authoritative saves,
idempotency, scoped cursors, retention, quotas, failure recovery, deletion races and fresh-client
report restoration without a browser. These checks are included in normal tests and integration.

Live storage and hosted Cognito checks use the guarded persistent-test workflows described above.
See [Saved projects verification](SAVED_PROJECTS.md#persistent-aws-test-checks). Production is prohibited.
No browser E2E, hosted smoke or live storage tests were run for this refactor.

## Deployment separation checks

`infra/cdk/test/deployment-workflow.test.ts` uses mocked process/AWS identity responses to verify
explicit target validation, account mismatches, region/stack guards, pending production-region
confirmation, bootstrap failures, output isolation, credential environment isolation, template-only
diff and deployment command construction. No operational command reaches AWS in these tests.

`infra/cdk/test/infralens-stack.test.ts` synthesizes both real stack definitions and checks account,
resource isolation, all 14 protected API methods, public preflight, matching origins/Cognito URLs,
Lambda runtime settings, separate outputs and retention. `apps/api/test/environmentConfiguration.test.ts`
checks frontend configuration, session isolation, exact CORS and working local Express memory history
with an explicit fake identity and no AWS configuration. Frontend helpers run under Mocha without a browser.

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test
npm.cmd run test:integration
npm.cmd run synth --workspace @infralens/cdk -- --target test
npm.cmd run synth --workspace @infralens/cdk -- --target production
```

`infra/cdk/test/test-permissions.test.ts` checks the test policy package and offline bootstrap
preparation. These are structural assertions, not an IAM evaluator. The normal test command never
calls AWS. The separate `infra/cdk/verify-test-policies.ps1` performs optional read-only Access
Analyzer validation and IAM simulations with a verified test account; see the
[policy setup guide](TEST_DEPLOYMENT_PERMISSIONS.md) for its scope and API Gateway simulation limit.

The npm tests and offline synthesis require no AWS credentials or bootstrap. See [deployment commands](PRODUCTION_DEPLOYMENT.md)
for read-only operational preflight/diff and later deployment. Hosted login, the localhost Gateway
auth-error CORS limitation, real storage permissions and actual user isolation still require a later
authorized verification task. Keep the test stack deployed between those runs.
