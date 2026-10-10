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

# Authenticated smoke: requires persistent users, credentials and Chromium (setup below).
npm.cmd run test:smoke -- --target test --authenticated true

# Hosted save/restore/two-user isolation: automatically signs in and renews tokens.
aws sso login --profile infralens-test-deploy
npm.cmd run test:hosted -- --target test --region eu-central-1 --stack InfraLensTestStack --profile infralens-test-deploy --allow-test-data true
```

Authenticated tests require four protected credential values: INFRALENS_TEST_USER_A_EMAIL,
INFRALENS_TEST_USER_A_PASSWORD, INFRALENS_TEST_USER_B_EMAIL and INFRALENS_TEST_USER_B_PASSWORD.
They acquire tokens automatically; do not supply or save access tokens. See the setup below.
Both users sign in before authenticated smoke runs; hosted isolation also checks different subjects.

The guarded workflow accepts only --target test. For data-writing hosted/storage modes, it verifies
STS caller account, intended region/stack, stable application state and every local output against
CloudFormation before starting tests. A named profile and --allow-test-data true are mandatory.
Ambient AWS credentials, role overrides and endpoints are cleared before pinning that profile/region.
Profile names are not evidence of account identity. Missing/invalid mandatory configuration fails;
explicit commands do not silently skip an entire suite. Normal tests remain credential-free.

Smoke checks public health, unauthenticated rejection for all 14 analysis/history methods, an invalid
bearer token, and optionally authenticated analysis. It reads validated local outputs and performs
HTTP calls only; it does not contact STS or independently establish live account ownership. A stale
URL fails its HTTP assertions. Use --authenticated true for automatic two-user sign-in and authenticated
analysis; without that flag, only authenticated analysis is skipped. With the flag, missing credentials
or failed login fails the suite. Supply --outputs PATH to use another public output file.

apps/api/test/hostedHistory.hosted.ts checks authenticated save/restore and cross-user read/delete/
download isolation. Cleanup deletes only the project created by that test. API deletion can retain
metadata tombstones; pending artifact cleanup fails visibly and preserves recovery metadata. No stack
or bucket is emptied. Every API request preserves the /test/ stage, rejects redirects and has a timeout.
Local JWT claim checks detect configuration mistakes; API Gateway verifies signatures/authorization.

## Persistent Cognito users and automatic authentication

The separate test:users:setup command creates persistent users A and B in the deployed test pool,
identified by configured email addresses and a fixture marker in the standard name attribute.
The deployed pool uses email-only sign-in and Cognito generates its internal usernames; no pool
configuration change or replacement is needed. Setup verifies STS, region/stack and current outputs
before starting the worker. Both users must have different dedicated email addresses you control. Invitations
are suppressed; setup marks those controlled addresses verified and sets permanent passwords.
Use strong distinct generated passwords (at least 12 characters, with upper/lowercase, numbers and
symbols to meet the pool policy). This is an administrative fixture setup, not public registration.

Run setup after the first test deployment or after an intentional test-pool replacement. Later runs
leave confirmed users and passwords intact. A partially completed FORCE_CHANGE_PASSWORD fixture can
be completed with the configured password. An existing email identity with a different email,
fixture marker, disabled state or unexpected status is rejected. Alias transfer is never enabled.
Changing secrets alone does not rotate existing passwords; credential rotation is a separate
intentional administrative operation. Do not run setup inside every test or add users/passwords to CDK.

Store the four values in a protected secret store and inject them into the local test process or the
GitHub aws-test environment. Never put them in CDK outputs, Vite variables, tracked files or command
arguments. For an interactive PowerShell session, these prompts avoid putting passwords in shell
history; use the same persistent credentials later or inject them from your chosen secret manager:

```powershell
$env:INFRALENS_TEST_USER_A_EMAIL = Read-Host "Dedicated test user A email"
$fixturePasswordA = Read-Host "Test user A password from your secret store" -AsSecureString
$env:INFRALENS_TEST_USER_A_PASSWORD = [System.Net.NetworkCredential]::new("", $fixturePasswordA).Password
$env:INFRALENS_TEST_USER_B_EMAIL = Read-Host "Dedicated test user B email"
$fixturePasswordB = Read-Host "Test user B password from your secret store" -AsSecureString
$env:INFRALENS_TEST_USER_B_PASSWORD = [System.Net.NetworkCredential]::new("", $fixturePasswordB).Password

# Administrative setup, explicitly creates users. Prepared here; not executed by this coding task.
# The existing admin profile can run it. The routine deployment profile cannot.
aws sso login --profile infralens-test-admin
npm.cmd run test:users:setup -- --target test --region eu-central-1 --stack InfraLensTestStack --profile infralens-test-admin --allow-user-setup true

# One-time browser binary installation on each local test machine; does not contact AWS.
npx.cmd playwright install chromium

# These commands acquire, validate, cache and renew tokens automatically.
npm.cmd run test:smoke -- --target test --authenticated true
aws sso login --profile infralens-test-deploy
npm.cmd run test:hosted -- --target test --region eu-central-1 --stack InfraLensTestStack --profile infralens-test-deploy --allow-test-data true

# Remove credential copies from this shell after testing; keep them in the protected secret store.
Remove-Item Env:INFRALENS_TEST_USER_A_EMAIL, Env:INFRALENS_TEST_USER_A_PASSWORD, Env:INFRALENS_TEST_USER_B_EMAIL, Env:INFRALENS_TEST_USER_B_PASSWORD
Remove-Variable fixturePasswordA, fixturePasswordB
```

For a later scoped setup identity, allow STS GetCallerIdentity, CloudFormation DescribeStacks for
InfraLensTestStack, and cognito-idp:AdminGetUser, AdminCreateUser and AdminSetUserPassword on **only
the test user-pool ARN** from the deployment outputs. Cognito scopes these administrative actions to
the pool, not individual usernames. Keep this identity separate from routine deployment and test
execution. No IAM changes or new profile are applied by this implementation; the supplied admin
profile still has administrator permissions. Authenticated HTTP smoke needs no AWS CLI identity or
provisioning privileges. Hosted data tests only need the existing read-only STS/stack preflight
permissions in addition to the Cognito user credentials; storage permissions remain a separate task.

The test-only Playwright library drives Cognito login in a fresh browser context for each user. It
uses the same authorization-code/PKCE S256 flow and openid/email scopes as React. The existing
http://localhost:5173/auth/callback is captured from Cognito's redirect Location header, so neither a React server
nor published frontend assets are needed for API testing. This does not test the React sign-in UI.
The browser is closed after code acquisition; tokens remain in memory only, are reused while valid,
and refresh before expiry. A revoked refresh token triggers a new login. Unexpected server errors
fail without retrying API writes. Subject checks prevent a mid-run identity
switch. Different token strings for the same subject do not qualify as two users.

The current test pool uses password sign-in without MFA. Unsupported challenges/MFA or sign-in page
changes fail clearly; do not disable production security to accommodate test automation. Token
responses and browser diagnostics are not printed; acquired tokens are masked in GitHub Actions.
No traces, screenshots, storage-state files or token artifacts are produced. Remove the retired
INFRALENS_SMOKE_ACCESS_TOKEN, INFRALENS_TEST_USER_A_TOKEN and INFRALENS_TEST_USER_B_TOKEN variables/secrets; they now fail
as legacy overrides. Neither normal tests nor offline synthesis launch browsers or contact Cognito.

See [Cognito token endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html)
for PKCE/refresh and [Playwright library](https://playwright.dev/docs/library) for browser installation.

If automatic sign-in fails, the message identifies the stage: Chromium launch, page loading, locating
the form, filling/submitting controls or waiting for the callback. Classic Cognito renders two login
forms; the helper selects one visible password form and keeps all three controls within it.
Submission uses input[name="signInSubmitButton"]: Cognito displays "Sign in" but its aria-label is
"submit", so a role locator searching for the visible text does not match the button. This control
metadata was confirmed with a public login-page read; no credentials were submitted during diagnosis.
Browser errors remain sanitized: do not enable raw Playwright call logs/traces to diagnose credential failures.
For a launch error saying Chromium is missing, run npx.cmd playwright install chromium in the same
Windows user session as the test. The helper captures the registered callback from a trusted Cognito
3xx response's Location header, validating its exact URL, state and authorization code before use.
Playwright page.route intercepts only the first URL in a redirect chain, so it cannot reliably capture
the redirect destination. No successful localhost navigation is required. It also watches for allowlisted Cognito
rejections (email/password, attempt limit, reset/new-password, MFA or CSRF) and returns fixed messages,
never page text. Unknown failures still time out. If Cognito rejects credentials, reload the original
saved values: repeating setup or changing environment secrets does not reset confirmed passwords.
Share only the sanitized stage message. No rejection causes automatic password resets or login retries.

Unknown callback failures include a Safe diagnostics JSON summary: number of login POSTs, last login
HTTP status, request-failure/script-error counts, a fixed page category and native form-validity flags.
No URL queries, request bodies/headers, input values, emails, passwords, page text or tokens are included.
The summary distinguishes a click that never sent a request from a server response or transport failure.
Browser-inspection errors are reported separately from genuine timeouts. Share that summary if login
still fails; avoid repeated login attempts or infrastructure/policy changes without identifying the cause.
See [Playwright routing limitations](https://playwright.dev/docs/api/class-page#page-route).

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

Configure a GitHub Actions environment named aws-test, restrict its permitted branches, and set
required reviewers if appropriate. Add the four EMAIL/PASSWORD secrets above to that environment
after user setup. Set the Actions variable INFRALENS_TEST_DEPLOYMENT_OUTPUTS to the full public test
outputs JSON. No AWS keys, refresh tokens or pre-generated access-token secrets are required.

deployed-smoke.yml is manual and defaults authenticated=true. It installs Chromium, signs in as both
users and uses a fresh token for analysis. Selecting authenticated=false runs only public HTTP checks
without credential secrets or a browser launch. The job writes the ignored outputs file and uses
the same test-only safeguards. Missing outputs, secrets or login failures fail the authenticated job.
It never provisions users, deploys, uploads assets or grants permissions. Standard push/PR CI still
builds and runs offline tests only: live checks depend on a persistent external service and protected
credentials, while hosted data tests also write/clean temporary data. A future post-deployment
pipeline can invoke the guarded authenticated command with those same protected secrets; it should
follow a successful test deployment rather than run for every untrusted pull request.
GitHub must have the workflow file on the default branch to expose its manual Run workflow action;
then select the reviewed branch containing these changes. This coding task does not push or merge it.

Read-only remote checks on October 10 confirmed main matches the local commit containing
deployed-smoke.yml with workflow_dispatch. You can test the new workflow **before merging**: push
feature/hosted-test-workflows, open Actions -> Smoke tests (existing deployment required) -> Run workflow,
choose that feature branch and enable authenticated. Configure aws-test secrets/outputs first, and
permit that reviewed feature branch in the environment's branch rules. After the run passes, open a PR.
This branch depends on feature/separate-aws-environments; use that branch as the PR base until the
environment work has merged into main, then retarget the hosted-test PR to main as appropriate.

## What passing tests guarantee—and what they do not check

- Cognito and API Gateway authorize deployed requests before invoking Lambda. Direct Lambda and
  local Express calls intentionally do not enforce hosted authentication. Existing CDK assertions
  verify Cognito protection and `openid` scope for all analysis routes; adapter integration tests
  verify request validation and error contracts, while deployed smoke tests check actual rejection.
  The authenticated workflows exercise Cognito PKCE sign-in and acquire/renew tokens automatically.
  Refresh behavior is covered offline with mocks; a short smoke run need not trigger a live refresh.
  Invitations and the React sign-in UI are outside these API workflows.
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
