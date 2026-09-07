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
| `apiContract.integration.test.ts` | Real Express/Lambda parity for analysis, base64 API Gateway input, apply and diff. Both adapters reject missing bodies, malformed templates/diffs/fixes, excessive templates/request bodies/source count/source bytes and invalid mapping shapes. One injected analyzer exception verifies the actual route/logging/error conversion boundary returns `500 ANALYSIS_ERROR`. |

Reusable fixture loading lives in `apps/api/test/workflowFixtures.ts`, resolved relative to the
helper rather than the shell's current directory. The tests reuse these small existing fixtures:

- `examples/order-service-risky-template.json`: realistic API, Lambda, IAM, DynamoDB, queue and logs.
  Selected fixes leave missing DLQ/log retention, unselected deletion protection/tracing, public API
  authorization and the separate logs wildcard statement visible.
- `examples/source-file-lambda-mapping/template.json`: two Lambdas with distinct roles and targets.
- `examples/shared-source-import-graph/`: handlers, transitive database helper, shared SDK source,
  queue helper and unrelated delete action. Its `sharedDb.ts` and `queueClient.ts` supply real SDK
  package evidence for explicit upload tests; the other example's mock commands lack that evidence.
  Cycle variants add short import edges to fresh in-memory copies, leaving fixtures untouched.

These fixtures are analyzer inputs, never executed or deployed. Tests assert meaningful report
fields and specific edits instead of storing whole report snapshots. Existing rule unit tests
continue to cover the current 16 rules; integration fixtures are representative workflows, not a
second exhaustive rule matrix.

## Deployed HTTP smoke tests

Smoke tests validate an existing deployment; CI does not deploy InfraLens.

`apps/api/test/deployedRoutes.smoke.ts` is excluded from normal `*.test.ts` discovery. It only makes
HTTP calls to an explicitly configured existing HTTPS API, preserving any API Gateway stage path.
It checks public `GET /health` and unauthenticated rejection of `POST /analyze`, `/diff` and `/apply`.
Requests use a tiny synthetic queue template, no uploaded source, finite timeouts and no redirects.
No configuration means a clearly reported skipped suite, with no network calls.

```powershell
$env:INFRALENS_SMOKE_API_BASE_URL = 'https://YOUR_EXISTING_API_HOST/YOUR_STAGE'
npm.cmd run test:smoke
```

| Configuration | Local environment / GitHub Actions |
| --- | --- |
| `INFRALENS_SMOKE_API_BASE_URL` | Required for HTTP tests; set locally or as a repository Actions variable. No hardcoded deployment URL. |
| `INFRALENS_SMOKE_ACCESS_TOKEN` | Optional valid, short-lived Cognito **access** token with the deployed route's `openid` scope. Set locally through your secure environment or as an Actions secret. Enables one authenticated synthetic `/analyze` test. Expired tokens cause that opt-in test to fail. Never commit tokens. |

The dedicated **Smoke tests (existing deployment required)** workflow runs only via manual
`workflow_dispatch`, and skips its job when the URL variable is absent. Configure the repository
variable and optional secret, then run it from GitHub Actions. It installs npm dependencies and runs
the HTTP suite; it has no AWS credentials, deploy commands, CloudFormation updates, or asset uploads.
Normal pull-request CI continues typechecking, building and testing locally without needing a
deployed environment. No token acquisition, user invitation, refresh process, or long-lived test
credential is introduced.

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
- Generated templates are not deployed or fully CloudFormation-schema validated by these tests.
  The hosted authenticated apply/diff flow, operational alarms and infrastructure provisioning remain
  outside smoke coverage. Production CDK files are unchanged.
