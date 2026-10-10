# InfraLens handoff

Last refreshed: October 10, 2026.

## Current task and Git state

- Read AGENTS.md first. Preserve unrelated changes; keep npm workspaces, Mocha/Chai and the existing layout.
- Active branch: feature/hosted-test-workflows, created from feature/separate-aws-environments at 9f4c0b1.
  The parent has four environment/policy commits beyond local main (8896116). This is a dependent branch;
  merge the environment work first or adjust the base later. Read-only remote references on October 10
  confirm main and the parent still match those commits; the hosted-test branch is not pushed. No merge was performed.
- Authorized work: automatic persistent test-user setup and fresh OAuth token acquisition/renewal.
  User authorized a checkpoint commit, including the API test-folder type-definition resolution fix.
  Do not push, deploy/bootstrap/destroy, modify IAM/Organizations, or run hosted smoke,
  live storage or browser tests without a new explicit request. Read-only AWS inspection is allowed if needed.
- Test-only API dev dependencies: Playwright and Cognito SDK. No workspace restructuring or application
  infrastructure changes. No browser binary installed or real browser launched by the assistant.

## AWS environments and deployment status

| Mode | Identity | Behavior |
| --- | --- | --- |
| Local | No AWS | React + Express; memory history and explicit fake local identity |
| AWS test | 230944684535 / eu-central-1 / InfraLensTestStack | Persistent stack; user reports successful deployment |
| Production | 609124256824 / proposed eu-central-1 / InfraLensProdStack | No application stack reported; region pending confirmation |

- The ignored infra/cdk/cdk-outputs.test.json exists and identifies the correct test account/region/stack,
  API URL, tables/bucket, CloudFront frontend and Cognito. Read-only October 10 inspection checked the
  live stack and Cognito configuration. Earlier ROLLBACK_COMPLETE states and cleanup inventories describe obsolete failed attempts.
- Test supports CloudFront and exactly http://localhost:5173; both use test Cognito with the AWS API.
  Production permits its configured hosted origin only. All 14 analysis/history methods require Cognito;
  health and OPTIONS are public. Local memory mode remains credential-free.
- Frontend publishing has not been reported complete. CDK creates frontend infrastructure but does not
  upload React assets. Both dedicated Cognito fixtures were verified enabled/CONFIRMED on October 10.
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
- Smoke uses validated test outputs without AWS credentials. --authenticated true obtains fresh Cognito
  tokens; otherwise only public checks run. HTTP-only smoke does not verify live AWS ownership.
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
- test:users:setup requires --allow-user-setup true and an explicit profile/region/stack. After STS/current
  outputs checks, it creates two persistent users identified by dedicated emails plus a name fixture marker.
  The existing pool is email-only; Cognito generates internal usernames. Suppress invitations, never transfer
  aliases or reset confirmed passwords; resume only matching FORCE_CHANGE_PASSWORD fixtures. Setup was not run by the assistant.
- Four protected INFRALENS_TEST_USER_A_EMAIL/PASSWORD and B_EMAIL/PASSWORD values replace manual token input.
  Test-only Playwright login uses OAuth/PKCE/openid in isolated browser contexts; capture the existing
  localhost callback from Cognito redirect headers, so API tests do not require React assets/server. Cache/refresh in memory, re-login on
  revoked refresh, preserve subjects. No token files/traces; sanitize errors and mask tokens in Actions.
- Manual GitHub smoke uses protected aws-test environment credentials and public output JSON from
  INFRALENS_TEST_DEPLOYMENT_OUTPUTS. Authenticated mode defaults true; public-only mode stays available.
  No AWS identity/provisioning privileges in that job. Retired static token variables now fail clearly.
- October 10: submit selector corrected: public classic Cognito button displays "Sign in" but has
  aria-label="submit"; use its named input within one visible form. User then reached callback timeout.
  Verified read-only via test-admin after STS/live-stack/output checks: both fixtures enabled/CONFIRMED,
  MFA OFF, localhost callback registered, code grant and openid/email scopes correct. No emails printed.
  Latest diagnostic: POST /login returned 302, then a failed request/other-origin page. Playwright docs
  confirm page.route only intercepts the first URL of a redirect chain; the callback-only route misses
  Cognito's redirect. Helper now observes trusted Cognito 3xx Location headers, validates exact callback,
  state/code, and captures in memory before token exchange. Regression simulates unrouted redirects and
  chrome-error://chromewebdata/ plus wrong-origin/state/code cases. Unknown failures retain safe counters.
  No raw URLs/headers, codes, credentials or page text logged. No live login/browser run by the assistant;
  the user subsequently reported everything working and is proceeding to GitHub workflow setup (step 9).
- See docs/TESTING.md and docs/SAVED_PROJECTS.md for exact PowerShell commands and requirements.

## Verification and next work

- October 10 editor-config fix: apps/api/test/tsconfig.json explicitly resolves the workspace's hoisted
  node_modules/@types. Compiling that exact config, all workspace typechecks and builds passed.
  Full offline npm test passed, including 160 API tests and 69 CDK tests with synthesis assertions.
  Restart the editor's TypeScript server if cached diagnostics remain; no editor restart was performed.
- October 10 login-helper update: 160 offline API tests passed, including 13 mocked OAuth/browser tests.
  API typecheck passed. User reports live tests working after the redirect fix; no real browser/login or
  hosted smoke run by the assistant. User reports using the original
  saved passwords. The latest read-only inspection verified fixture status/client settings, not passwords.
- October 8 implementation: 546 offline tests passed (API 156, CLI 17, analyzer 284, shared 20, CDK 69),
  including mocked user setup/browser/OAuth/refresh, identity guards and both real synthesis assertions.
  Workspace typechecks/build and explicit offline synth for test/production passed; existing Vite
  >500 kB warning remains. Current test outputs and Actions YAML validated offline; setup entry point
  rejects production before network calls. Windows sandbox blocked local HTTP/CDK file operations;
  offline suite/synth passed with host access. No hosted/live-storage/browser tests or AWS operations ran.
- Read-only npm audit reported 13 findings in existing dependencies, none in the newly added Cognito
  SDK or Playwright packages. Dependency remediation was not mixed into this authentication task.
- Prior logging fix: 55 CDK tests, workspace typechecks/build, one-policy template validation, and 49 IAM
  simulations passed; three API tag-deletion simulator cases remained explicitly unverified. The user
  subsequently reported successful test deployment. Simulation success alone is not live coverage.
- Next: publish the reviewed branch and configure the GitHub aws-test environment, its four user secrets
  and public deployment-output variable, then run that branch's authenticated smoke workflow. Local
  main already contains deployed-smoke.yml with workflow_dispatch; read-only remote references confirm
  that commit remains current, so merging first is unnecessary. Exact steps are in docs/TESTING.md.
  Routine test execution never provisions users. No IAM changes or actual user creation by the assistant.
- Publish the frontend for real React verification; API OAuth tests can run before assets are published. Run public
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
until explicitly authorized. Ask only for missing user/secret-store setup or a scoped storage-test identity
when those become necessary; never request credentials/tokens in chat.
