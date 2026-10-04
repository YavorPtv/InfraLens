# AWS test and production deployment

InfraLens has three independent modes: local Express/React, persistent AWS test, and AWS production.
Deployment identity is defined in `infra/cdk/src/deployment-target.ts`, never inferred from
`NODE_ENV`, `INFRALENS_ENVIRONMENT`, `CDK_DEFAULT_ACCOUNT`, or active credentials.

## Configuration and known AWS state

| Setting | AWS test | Production |
| --- | --- | --- |
| Target argument | `test` | `production` |
| Account | `230944684535` | `609124256824` |
| Region | `eu-central-1` | `eu-central-1`, proposed, pending confirmation |
| Application stack | `InfraLensTestStack` | `InfraLensProdStack` |
| Supplied CLI profile | `infralens-test-admin` | `infralens-prod-admin` |
| Proposed Cognito prefix | `infralens-test-230944684535-euc1` | `infralens-prod-609124256824-euc1` |
| Frontend origins | Own CloudFront HTTPS origin and `http://localhost:5173` | Own CloudFront HTTPS origin only |
| DynamoDB point-in-time recovery | Disabled | Enabled |

Both supplied administrator profiles still have **administrator permissions**. The additional
`infralens-test-deploy` profile selects `InfraLensTestDeploy`. The user applied scoped bootstrap
permissions and the publishing-policy correction; both have been inspected read-only.
Profile names are labels; the workflow checks the actual STS caller account every time.

AWS state (user-supplied except for the read-only test audit below):

- AWS Organizations and IAM Identity Center are configured. No custom organization policies or
  permission restrictions were added.
- There is no production application stack. No migration or application stack rename is needed.
- Production has `CDKToolkit` according to the user; leave it unchanged. Test initially had no
  bootstrap stack. The user subsequently reported passing preflight and supplied the first
  application diff; a successful application deployment has not been reported.
- Read-only test audit on October 3, 2026: STS confirmed account `230944684535`; `CDKToolkit` in
  `eu-central-1` is `CREATE_COMPLETE`, version 32, qualifier `hnb659fds`. Both the active SSO role
  and bootstrap CloudFormation execution role have `AdministratorAccess` without a permissions
  boundary. The deployment role permits stack mutations on `*`, including deletion. No AWS changes
  were made and production was not inspected. Full audit notes are in `HANDOFF.md`.
- October 4 readiness audit: test `CDKToolkit` is `UPDATE_COMPLETE` with variant
  `InfraLensTestScopedV1`. Execution policies and the application boundary match the prepared
  documents; the three routine-role trusts match the intended SSO role. The first audit found the
  original publishing policy alongside the new policy. The user then applied the two-resource
  [publishing-policy correction](TEST_DEPLOYMENT_PERMISSIONS.md#publishing-policy-correction-before-first-deployment).
  A follow-up audit confirmed `UPDATE_COMPLETE`, no managed policy attachments and exactly one
  publisher inline policy, matching the intended scoped document with no delete-object grant.
- The guarded preflight and template-only diff passed again after CloudTrail setup using
  `infralens-test-deploy`; the application is still an initial create. These checks do not prove all
  provisioning/update/rollback permissions.
- The user's first deployment then failed resolving the bootstrap version: the CloudFormation
  execution role lacked `ssm:GetParameters` on the exact test version parameter. Read-only inspection
  found no application stack afterward. The [one-policy correction](TEST_DEPLOYMENT_PERMISSIONS.md#bootstrap-version-read-correction-after-the-first-deployment-attempt)
  was subsequently applied and is present in the current `UPDATE_COMPLETE` bootstrap template.
- The next deployment hit an explicit API tagging deny and rolled back, leaving eight resources
  marked retained in that attempt. The [API tagging correction and historical recovery inventory](TEST_DEPLOYMENT_PERMISSIONS.md#api-ownership-tag-correction-and-failed-stack-recovery)
  are recorded; the October 5 bootstrap template confirms that correction is applied. Deploy blocks failed application stacks
  before CDK can attempt deletion/recreation. Do not retry until separate recovery is reviewed.
- The user created `infralens-test-audit`. October 4 read-only inspection confirmed active logging,
  successful S3 delivery, multi-region/global-event coverage, log validation and both read/write
  management events without exclusions. The dedicated bucket has all public-access blocks enabled,
  a nonpublic policy and default SSE-S3 encryption. The assistant made no AWS changes.
- October 5: the bootstrap now contains the API tagging correction. The next deployment failed
  configuring the regional API Gateway logging account because its role's boundary restricted the
  required logging scope. Correct trust/managed policy were confirmed read-only. The
  [logging boundary correction](TEST_DEPLOYMENT_PERMISSIONS.md#api-gateway-logging-boundary-correction)
  is prepared, not applied; it affects only the test API logging role's maximum logging permissions.
  The current application is `ROLLBACK_COMPLETE`; earlier inventories are from a different attempt.
- A $1 management-account budget exists; its scope and coverage are unverified.
- The test Cognito prefix returned an empty `DomainDescription` on October 4, so it was unclaimed
  at that check; availability is not reserved. Production prefix and region remain unverified.

Each application stack creates its own Lambda, REST API, two DynamoDB tables, private artifact
bucket, private frontend bucket, CloudFront distribution, Cognito user pool/client/domain, logs and
alarms. No resource is imported from the other environment. Both hosted targets use production
**runtime** safeguards, AWS history storage, and Cognito access tokens; local identity is never set.
The Lambda IAM action set is unchanged by environment separation.
Both application Lambdas use Node.js 22 with esbuild targeting `node22`. GitHub workflows also use
Node.js 22; use that version locally for consistent builds and tests.
Test application roles now reference the administrator-owned `InfraLensTestApplicationBoundary`.
The [test permission package](TEST_DEPLOYMENT_PERMISSIONS.md) created that policy in the bootstrap
update applied by the user. Its publishing-policy correction has also been applied and inspected.

Edit reviewed target settings in the existing CDK workspace. The created CloudFront origin is always
allowed. `additionalFrontendOrigins` adds exact origins, with HTTPS required except for the one test
localhost origin. There are no wildcard origins. Custom-domain DNS/certificates and extra frontend
build variants are not provisioned by this task. Existing numeric operational/request-limit CDK
context settings remain available to direct offline app synthesis; the guarded workflow uses their
defaults. Change reviewed defaults before using the workflow if needed.

## Commands available now: entirely offline

Run from the repository root in PowerShell after installing dependencies with `npm.cmd ci`:

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test
npm.cmd run test:integration
npm.cmd run synth --workspace @infralens/cdk -- --target test
npm.cmd run synth --workspace @infralens/cdk -- --target production
```

Normal tests use mocks or local memory and make no live AWS calls. Offline synth directly runs the
CDK application without the CDK CLI's credential discovery, clears inherited AWS/CDK environment
settings, and rejects assemblies with unresolved lookups. It writes to `infra/cdk/cdk.out/test` and
`infra/cdk/cdk.out/production`. No bootstrap or credentials are required. CDK bundling requires
local esbuild process/filesystem access. Tests and synth are not deployment evidence.

Missing/invalid `--target` fails. The old `-c environment=development|production` interface is
rejected by the CDK app. Bare `cdk synth` has no default target. Use the scripts above for offline
work and the guarded scripts below for operations; direct `cdk deploy` bypasses the wrapper's STS
check and is not the supported deployment workflow.

## Read-only operational checks, after SSO access is available

Preflight, diff, and deploy require explicit region and stack, validate them against the target,
then call `aws sts get-caller-identity` with the selected profile and region. A wrong account,
failed/expired login, wrong region, wrong stack, or unconfirmed production region stops the workflow.
Inherited AWS keys, session tokens, role/endpoint overrides and region settings are removed from
child processes. Profiles are read from the normal AWS shared files. `--profile <name>` can select
a future narrower profile, but never changes the expected account.

After STS succeeds, preflight reads `CDKToolkit` in that account/region and requires a stable stack
status. It does not create, update, rename or repair bootstrap resources. Missing bootstrap is a
failure requiring a separate setup decision. This check is not a full audit of bootstrap version,
trust policies or deployment permissions.

These commands are implemented now and are read-only, but require working SSO sessions and existing
bootstrap stacks/permissions. The user reports test preflight passes; rerun it when preparing a
deployment. These commands were **not run by the assistant**:

```powershell
npm.cmd run preflight --workspace @infralens/cdk -- --target test --region eu-central-1 --stack InfraLensTestStack --profile infralens-test-admin
npm.cmd run diff --workspace @infralens/cdk -- --target test --region eu-central-1 --stack InfraLensTestStack --profile infralens-test-admin
```

Diff repeats preflight, synthesizes locally, verifies the assembly's account/region/stack, and uses
`cdk diff --method template`. This avoids change-set creation and asset publication; replacement
predictions are less precise than change-set diff. See the [AWS CDK diff reference](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-diff.html).

Only **after confirming production's region** use these exact production checks. The confirmation
flag records the decision for that invocation; it does not mark the proposed region as confirmed
in source control:

```powershell
npm.cmd run preflight --workspace @infralens/cdk -- --target production --region eu-central-1 --stack InfraLensProdStack --profile infralens-prod-admin --confirm-production-region eu-central-1
npm.cmd run diff --workspace @infralens/cdk -- --target production --region eu-central-1 --stack InfraLensProdStack --profile infralens-prod-admin --confirm-production-region eu-central-1
```

## Test bootstrap: separate manual setup

The following command was supplied when test had no `CDKToolkit`. Since test preflight now passes,
do not rerun bootstrap as part of the application deployment. For reference, the guarded setup
command runs from the repository root with an active SSO session:

```powershell
$bootstrapAccount = aws sts get-caller-identity --profile infralens-test-admin --region eu-central-1 --query Account --output text --no-cli-pager

if ($LASTEXITCODE -ne 0 -or $bootstrapAccount -ne '230944684535') {
    throw 'Account verification failed. Bootstrap stopped.'
}

npm.cmd exec --workspace @infralens/cdk -- cdk bootstrap aws://230944684535/eu-central-1 --profile infralens-test-admin --region eu-central-1 --context target=test
```

This creates bootstrap resources and IAM roles in the test account/region. Standard bootstrap gives
the CloudFormation execution role `AdministratorAccess`; it does not establish narrower deployment
permissions. See the [AWS bootstrap reference](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-bootstrap.html).
The explicit context is necessary because the installed CLI evaluates the configured CDK app during
bootstrap, even with an explicit environment. Evaluating the app does not deploy `InfraLensTestStack`.
After bootstrap succeeds, rerun test preflight. Leave production `CDKToolkit` unchanged.
This command has been supplied for manual execution; it was not executed by the assistant.

## Deployment commands: implemented, for a later authorized task

Do not run these until deployment permissions/bootstrap setup have been reviewed and deployment is
intended. The supplied administrator profiles technically have broad permissions; these prerequisites
are remaining operational work, not restrictions already applied to those profiles.

The [test permission package and setup guide](TEST_DEPLOYMENT_PERMISSIONS.md) is prepared but not
applied. Review it before creating the custom Identity Center deployment permission set and updating
test bootstrap permissions. It scopes deployment, execution and application roles together. Keep
bootstrap administration and intentional teardown separate from routine deployment. Application of
the policies is a separately authorized AWS change; production `CDKToolkit` remains unchanged.
See [AWS CDK deployment security guidance](https://docs.aws.amazon.com/cdk/v2/guide/best-practices-security.html).

```powershell
npm.cmd run deploy --workspace @infralens/cdk -- --target test --region eu-central-1 --stack InfraLensTestStack --profile infralens-test-deploy
```

Production, only after region confirmation and a separate production deployment decision:

```powershell
npm.cmd run deploy --workspace @infralens/cdk -- --target production --region eu-central-1 --stack InfraLensProdStack --profile infralens-prod-admin --confirm-production-region eu-central-1
```

The command repeats preflight, synthesizes fresh code, validates the resulting assembly, and deploys
only the selected application stack. CDK's permission-broadening approval remains enabled. It does
not run bootstrap, destroy, hotswap, or deploy `CDKToolkit`. These safeguards prevent accidental
selection errors; they do not replace IAM restrictions against intentionally bypassing the workflow.

Deployment writes separate, gitignored files:

- `infra/cdk/cdk-outputs.test.json`
- `infra/cdk/cdk-outputs.production.json`

Each contains deployment identity, API base/route URLs, both table names, artifact bucket, frontend
bucket/distribution/domain/origin, allowed origins, Cognito user pool/client/domain and callback/logout
URLs. Keep these with the matching environment. They contain public configuration, not credentials
or tokens; do not add secrets to them or commit generated environment files.

## Frontends after the first deployment

The user confirmed both test frontend options. Both authenticate against **test Cognito** when
calling the test API. The localhost port is fixed to 5173; Vite fails instead of silently choosing
an origin that Cognito does not allow. `127.0.0.1:5173` is supported for the fully local API but is
not a test Cognito callback origin.

After successful test deployment, generate frontend configuration from validated outputs:

```powershell
npm.cmd run frontend-config --workspace @infralens/cdk -- --target test
npm.cmd run dev --workspace @infralens/web -- --mode aws-test-local
```

The generator validates output identity, API region/stage, Cognito domain and callback/logout URLs.
It writes ignored `apps/web/.env.aws-test-local.local` and `.env.aws-test-hosted.local`. Local React
calls the test AWS API directly; do not start the local fake-identity Express API for this mode.

Build the deployed test frontend separately:

```powershell
npm.cmd run build --workspace @infralens/web -- --mode aws-test-hosted --outDir dist/aws-test
```

Production has its own output file, Cognito configuration and hosted build:

```powershell
npm.cmd run frontend-config --workspace @infralens/cdk -- --target production
npm.cmd run build --workspace @infralens/web -- --mode aws-production-hosted --outDir dist/aws-production
```

These generation/build commands are offline but require real outputs from the corresponding prior
deployment. No output files or Cognito identifiers are invented by this task. Clear stale shell
`VITE_INFRALENS_*` overrides before selecting a build mode. Vite validates hosted configuration;
an `aws-*` mode fails if its generated settings are missing or its target/frontend variant is wrong.
The browser additionally rejects an origin different from that build's configured origin. Session
storage keys include the Cognito domain and client, separating sessions even when using localhost.

CDK creates the frontend infrastructure but does not upload the web build. In the later deployment
task, upload only the matching `dist/aws-test` or `dist/aws-production` directory to that target's
`FrontendBucketName`, then invalidate its `FrontendDistributionId`. Repeat the guarded preflight and
validate the outputs immediately before these AWS writes. First-user invitation through Cognito is
also a later authorized operation using that target's `CognitoUserPoolId`; it is not part of normal
tests or the Lambda's permissions. Do not upload a local/fake-identity frontend build.

## Authentication, CORS and operational behavior

Both stacks disable self-sign-up and use invited Cognito users, authorization-code flow with PKCE,
and `openid email` scopes. All 14 analysis/project/history methods require their own pool's
API Gateway authorizer and the `openid` access-token scope. Only health and OPTIONS are public.
History ownership comes from trusted authorizer `sub`, never frontend identity headers.

The same origin list feeds API Gateway preflight, Lambda/Express CORS, Cognito callback URLs
(`<origin>/auth/callback`), logout URLs (`<origin>/`) and deployment outputs. CDK's preflight template
selects the exact allowed origin. Lambda echoes only recognized origins with `Vary: Origin`.
Production contains no localhost origin. Hosted CORS cannot fall back to local defaults.

REST API Gateway-generated 401/403 responses support static response header mappings, not conditional
VTL origin selection. They use the deployed CloudFront origin, never `*` or unchecked Origin
reflection. Successful localhost requests and Lambda errors have the correct local CORS header;
a rejected/expired token at Gateway can appear as a generic CORS/network error in the localhost
frontend. Sign in again in that case. This limitation needs hosted/manual verification, not a claim
of browser testing. See [API Gateway mapping variables](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-mapping-template-reference.html).

Existing defaults remain: 4 MiB request limit, 1 MiB template limit, 100 source files, 256 KiB per
source file, 2 MiB combined source, 100 mappings/exclusions, 2 MiB combined diff templates, and 200
fixes. Lambda is 512 MiB with a 30-second timeout. API throttling is 2 requests/second with burst 5;
reserved concurrency is opt-in after checking regional quota. Structured logs exclude source,
templates and tokens, retain for 30 days, and alarms cover errors/throttles/duration/API 5XX.
Optional alert email/SNS and monthly budget settings retain their existing behavior. No application
budget is enabled by default. A management-account budget is not proof that these accounts are covered.

## Persistent test environment and intentional teardown

Keep `InfraLensTestStack` deployed between test runs. Tests create/delete their own data; they do not
create or destroy stacks. There is deliberately no teardown command in the guarded workflow.

Both environments retain the two tables, artifact bucket, frontend bucket, Cognito pool and log
groups on stack deletion/replacement. Production tables additionally enable point-in-time recovery.
Retained resources can continue to incur costs. Other stack resources follow their CDK lifecycle.
Artifact input objects expire after seven days; report artifacts persist until explicitly removed.
DynamoDB TTL is asynchronous and is not a full cleanup strategy.

Teardown must be a separate reviewed operation, including account/region/resource inventory,
backups where needed, and retained-resource cleanup. S3 buckets must be emptied, including versions,
delete markers and incomplete uploads if present, before manual bucket deletion. There is no
auto-delete custom resource or automatic bucket emptying. Retained Cognito domains/pools can affect
later attempts to reuse a prefix. Leave production `CDKToolkit` unchanged.

## CloudTrail setup

Completed by the user and inspected read-only on October 4, 2026: `infralens-test-audit` is logging
to `infralens-test-audit-230944684535-euc1`. The latest successful delivery at inspection was
`2026-10-04T16:51:49Z`, with no delivery error reported. Coverage, management-event selectors,
validation, bucket public-access blocks and SSE-S3 encryption match the baseline below. The trail
is account-only, with no Insights or CloudWatch Logs/SNS integration. The walkthrough is retained
for reference; do not create a duplicate trail. Budget coverage remains unverified.

This is an account-level audit trail administered separately from the application and bootstrap.
The test deployment role should not gain permission to stop it or delete its audit bucket. It can
record other applications in the same account too. No trail, bucket or policy has been created by
the assistant, and no organization-wide logging change is proposed here.

For a low-cost initial test setup, use the test administrator session in account `230944684535`,
home region `eu-central-1`, and open CloudTrail > Trails > Create trail. Review these settings:

| Setting | Proposed value |
| --- | --- |
| Trail name | `infralens-test-audit` |
| Coverage | This account, all enabled regions, including global service events |
| Events | Management events, both read and write; no KMS/RDS exclusions |
| Log storage | New dedicated private S3 bucket in `eu-central-1`; keep all public access blocked |
| Bucket name | `infralens-test-audit-230944684535-euc1`, now created and inspected |
| Encryption | SSE-S3 for this initial cost-conscious setup; uncheck the console's default SSE-KMS option |
| Log file validation | Enabled |
| Data/network events, Insights, CloudTrail Lake | Not enabled in this baseline |
| CloudWatch Logs / SNS integration | Not enabled in this baseline |
| Retention | Keep logs; no automatic expiration or bucket emptying is configured |

SSE-S3 still encrypts logs; a customer-managed KMS key with a reviewed key policy is a later option
for additional access control and charges. CloudTrail's first copy of management-event delivery
to S3 has no CloudTrail delivery charge, but S3 storage/requests still cost money. Additional copies,
data events and Insights have separate charges. This baseline records management operations, not
application HTTP traffic, S3 object access or DynamoDB item access; it does not set up security alerts.
Existing Event history covers the last 90 days of regional management events without a trail.

Creating the trail in the console makes AWS changes and starts logging. Review the generated bucket
policy for the CloudTrail service principal, exact trail `aws:SourceArn`, and this account's log
prefix. After creation, verify that logging is active and files are delivered without errors.
Retain the trail independently of application teardown. Do not add it to `InfraLensTestStack` or
grant the routine deployment role access to the audit bucket. Test administrators still retain
the ability to change logging; stronger organization/log-archive controls are a later decision.

Console walkthrough for the first setup:

1. Use the AWS access portal to open account `230944684535` with `AdministratorAccess`. Check the
   account ID in the console and select Frankfurt (`eu-central-1`). CloudTrail is account auditing;
   its trail stays outside `InfraLensTestStack` and `CDKToolkit`.
2. Open CloudTrail > Trails > Create trail. Use the table above. Console-created trails are
   multi-region; Frankfurt is the home region, not a restriction on which regions are recorded.
3. Choose a new S3 bucket, leave its optional prefix blank, disable SSE-KMS for the chosen SSE-S3
   baseline, and enable log file validation. Leave SNS and CloudWatch Logs integration off. Optional
   tags can identify `Environment=test` and `Purpose=audit` without restricting which apps are logged.
4. On Choose log events, select Management events with both Read and Write. Leave exclusions
   unchecked. Leave Data, Network activity and Insights events off. Do not create a Lake event store.
   Management events record infrastructure/configuration activity; this baseline does not record
   each application HTTP request, S3 object operation or DynamoDB item operation.
5. Review the account, storage, encryption and event settings, then choose Create trail. This
   creates AWS resources and starts logging. The console prepares the bucket's CloudTrail access
   policy; it is separate from the application's deployment/runtime policies.
6. Open the resulting trail and confirm Logging is on, multi-region coverage, log validation,
   and the chosen event selectors. In S3, check that all Block Public Access settings are on,
   default encryption is SSE-S3, and log files arrive under
   `AWSLogs/230944684535/CloudTrail/<region>/<year>/<month>/<day>/`. Delivery often takes several
   minutes and is not immediate. Event history alone does not prove delivery to this bucket.

Optional read-only verification after creation (these commands do not create or start a trail):

```powershell
$trailAccount = aws sts get-caller-identity --profile infralens-test-admin --region eu-central-1 --query Account --output text --no-cli-pager
if ($LASTEXITCODE -ne 0 -or $trailAccount -ne '230944684535') { throw 'Expected test account 230944684535.' }
aws cloudtrail get-trail --name arn:aws:cloudtrail:eu-central-1:230944684535:trail/infralens-test-audit --profile infralens-test-admin --region eu-central-1 --no-cli-pager
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the test trail.' }
aws cloudtrail get-trail-status --name arn:aws:cloudtrail:eu-central-1:230944684535:trail/infralens-test-audit --profile infralens-test-admin --region eu-central-1 --no-cli-pager
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect trail logging/delivery.' }
aws cloudtrail get-event-selectors --trail-name arn:aws:cloudtrail:eu-central-1:230944684535:trail/infralens-test-audit --profile infralens-test-admin --region eu-central-1 --no-cli-pager
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect trail event selectors.' }
```

Expect the correct account/home region, multi-region/global-event coverage, validation enabled,
`IsLogging=true`, both read and write management events, a recent delivery time after activity,
and no delivery error. Keep audit logs independently of application teardown; retention can be
reviewed later without configuring automatic deletion as part of this setup.

Sources: [AWS trail setup](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-create-a-trail-using-the-console-first-time.html),
[CloudTrail security guidance](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/best-practices-security.html),
[CloudTrail pricing](https://aws.amazon.com/cloudtrail/pricing/).

## Next deployment checklist

1. Completed: test SSO login, scoped bootstrap update and publishing-policy correction. Read-only
   IAM inspection confirmed the intended publisher policy and removal of its extra old grants.
   The execution-role bootstrap-version read and API tagging corrections are also applied. Pending:
   apply the logging boundary correction and separately review recovery of `InfraLensTestStack` (`ROLLBACK_COMPLETE`)
   and its retained resources before another deployment attempt.
2. Use `infralens-test-deploy` for routine test deployment. Keep production bootstrap unchanged;
   its account/region preparation is independent of the first test deployment.
3. Recheck the test Cognito prefix when deploying. Confirm production region/prefix before a later
   production deployment; they are not prerequisites for the test environment.
4. Completed: account-level `infralens-test-audit` logging and S3 delivery verified; retain it
   independently of the application and bootstrap.
5. Verify the $1 management budget's scope; configure appropriate member-account coverage,
   recipients/alerts and cost monitoring. Budgets are not real-time spending caps.
6. Run test preflight and template diff, review resources/policies/costs, then authorize the first
   persistent test deployment. Export outputs, invite users, generate/build/upload the test frontend.
7. In a later task verify both test frontends, token rejection/renewal, two-user isolation and actual
   storage behavior. Run no browser E2E, hosted smoke or live-storage checks as part of this change.
