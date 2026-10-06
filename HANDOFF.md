# InfraLens handoff

Last refreshed: October 6, 2026.

## Current task and Git state

- Read AGENTS.md first. Preserve unrelated changes; keep npm workspaces, Mocha/Chai and the existing layout.
- Active branch: feature/hosted-test-workflows, created from feature/separate-aws-environments at 9f4c0b1.
  The parent has four environment/policy commits beyond local main (8896116). This is a dependent branch;
  merge the environment work first or adjust the base later. No remote refresh/merge was performed.
- Authorized work: refactor live-test configuration/safeguards and simplify this handoff; the user
  requested a checkpoint commit. Do not push, deploy/bootstrap/destroy, modify IAM/Organizations, or run hosted smoke,
  live storage or browser tests without a new explicit request. Read-only AWS inspection is allowed if needed.
- No new dependencies, workspace restructuring or application infrastructure changes in this refactor.

## AWS environments and deployment status

| Mode | Identity | Behavior |
| --- | --- | --- |
| Local | No AWS | React + Express; memory history and explicit fake local identity |
| AWS test | 230944684535 / eu-central-1 / InfraLensTestStack | Persistent stack; user reports successful deployment |
| Production | 609124256824 / proposed eu-central-1 / InfraLensProdStack | No application stack reported; region pending confirmation |

- The ignored infra/cdk/cdk-outputs.test.json exists and identifies the correct test account/region/stack,
  API URL, tables/bucket, CloudFront frontend and Cognito. No fresh live stack inspection was performed
  in this task. Earlier ROLLBACK_COMPLETE states and cleanup inventories describe obsolete failed attempts.
- Test supports CloudFront and exactly http://localhost:5173; both use test Cognito with the AWS API.
  Production permits its configured hosted origin only. All 14 analysis/history methods require Cognito;
  health and OPTIONS are public. Local memory mode remains credential-free.
- Frontend publishing and Cognito test-user setup have not been reported complete. CDK creates frontend
  infrastructure but does not upload the React build. Two distinct test users are needed for isolation.
- infralens-test-admin and infralens-prod-admin remain administrators. Routine test deployment uses
  infralens-test-deploy / InfraLensTestDeploy. It does not grant direct table/bucket test access, frontend
  upload/invalidation or user invitation. A scoped direct-storage test identity is a separate later setup.
- Test CDKToolkit is customized (version 32, qualifier hnb659fds, variant InfraLensTestScopedV1).
  Preserve it; don't run default bootstrap over the custom policies. Production CDKToolkit stays unchanged.
- API Gateway logging uses the test application boundary's role/region exception for its seven logging
  actions. That role has broader regional log access; Lambda keeps its restrictions. Full policy history,
  limitations and reviewed repair procedures live in docs/TEST_DEPLOYMENT_PERMISSIONS.md and Git history.
- CloudTrail infralens-test-audit was verified read-only on October 4: active multi-region management
  logging, successful delivery, private SSE-S3 bucket and log validation. It is independent of the app.
- The management account's $1 budget exists according to the user; scope, alerts and member-account
  coverage remain unverified. Production policies/preparation are a separate review.

## Live-test refactor

- Normal npm tests and synthesis stay offline. Live suites remain outside the *.test.ts glob.
- infra/cdk/src/hosted-test-workflow.ts provides explicit test-only smoke/hosted/storage commands.
  It validates local deployment outputs and rejects legacy URL/resource/opt-in overrides.
- Smoke uses HTTPS and validated test outputs without AWS credentials. Authenticated analysis is optional
  and reports a skip when no short-lived token is supplied. HTTP-only smoke does not verify live AWS ownership.
- Hosted/storage writes require an explicit profile, matching region/stack and --allow-test-data true.
  Before tests, STS must match the test account and CloudFormation must match the output file/current stack.
  Ambient AWS credentials/endpoints are removed before the selected profile/region are pinned.
- apps/api/test/hostedTestHelpers.ts validates worker config and access-token issuer/client/type/expiry/scope.
  These are configuration checks, not JWT signature verification; API Gateway remains the authenticator.
- Hosted Cognito tests moved to hostedHistory.hosted.ts. Direct DynamoDB/S3 tests stay in history.aws.ts,
  with independent per-test random-owner fixtures and cleanup confined to those namespaces.
- No test creates/destroys a stack. Hosted deletion uses the API and may retain metadata tombstones;
  direct-storage cleanup needs scoped DeleteItem plus adapter permissions. Pending cleanup must preserve
  recovery metadata. Never broaden the application Lambda role for testing.
- Manual GitHub smoke workflow reads public test output JSON from INFRALENS_TEST_DEPLOYMENT_OUTPUTS;
  optional access tokens remain ephemeral environment values/Actions secrets, never tracked or printed.
- See docs/TESTING.md and docs/SAVED_PROJECTS.md for exact PowerShell commands and requirements.

## Verification and next work

- This refactor: 527 offline tests passed (API 142, CLI 17, analyzer 284, shared 20, CDK 64), including
  mocked deployment safeguards and both environment synthesis assertions. Workspace typechecks/build
  passed; the existing Vite >500 kB warning remains. Current test outputs also validated offline.
  No hosted/live-storage/browser tests or AWS operations ran.
  Root/API npm entry points also rejected production before starting tests or network calls.
- Prior logging fix: 55 CDK tests, workspace typechecks/build, one-policy template validation, and 49 IAM
  simulations passed; three API tag-deletion simulator cases remained explicitly unverified. The user
  subsequently reported successful test deployment. Simulation success alone is not live coverage.
- Next: automate test authentication: idempotently provision two persistent test Cognito users through
  a separate setup step, then acquire fresh tokens during each authenticated test run. Keep credentials
  in a protected secret store; do not use pre-generated access tokens as long-term CI secrets. Use the
  app's OAuth authorization-code/PKCE flow, cache valid tokens within the run and refresh/re-authenticate
  before expiry. The current refactor validates externally supplied tokens; acquisition is not implemented.
  The user wants this long-term design, not further manual token-copying instructions.
- Publish the frontend and prepare test Cognito users as prerequisites for authenticated verification. Run public
  smoke, authenticated workflows and two-user isolation only when explicitly authorized and ready.
- Direct storage verification additionally needs its own scoped identity; leave the stack deployed between runs.
- Frontend localhost can show generic CORS errors for Gateway-generated auth failures; browser login,
  PKCE/refresh and actual frontend behavior still need later verification.

## Useful references

- docs/PRODUCTION_DEPLOYMENT.md: identities, deployment/frontend commands, retention and CloudTrail.
- docs/TEST_DEPLOYMENT_PERMISSIONS.md: applied policy design, repair history and remaining limitations.
- docs/TESTING.md: offline and live suites; docs/SAVED_PROJECTS.md: persistence and cleanup semantics.
- Core analyzer: packages/analyzer; shared contracts: packages/shared; API/history: apps/api;
  frontend: apps/web; CLI: apps/cli; deployment/test workflows: infra/cdk.

## Starting a fresh chat

Read AGENTS.md and HANDOFF.md first, then inspect the current branch and uncommitted diff. Continue
InfraLens from feature/hosted-test-workflows. The user reports the persistent AWS test stack deployed;
its public outputs are in ignored infra/cdk/cdk-outputs.test.json. Preserve changes and follow the
verification/next-work section. Do not commit, push, change AWS resources/permissions, or run live tests
until explicitly authorized. Ask only for missing Cognito users/tokens or a scoped storage-test identity
when those become necessary; never request credentials/tokens in chat.
