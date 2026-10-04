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

Both profiles currently have **administrator permissions**. They are not restricted deployment
roles. Narrower permissions and bootstrap trust/execution policies are a later task. Profile names
are labels; the workflow checks the actual STS caller account every time.

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
- CloudTrail has not been configured.
- A $1 management-account budget exists; its scope and coverage are unverified.
- Neither proposed Cognito prefix's availability has been verified. Region confirmation is still
  required for production; successful offline synthesis does not confirm that decision.

Each application stack creates its own Lambda, REST API, two DynamoDB tables, private artifact
bucket, private frontend bucket, CloudFront distribution, Cognito user pool/client/domain, logs and
alarms. No resource is imported from the other environment. Both hosted targets use production
**runtime** safeguards, AWS history storage, and Cognito access tokens; local identity is never set.
The Lambda IAM action set is unchanged by environment separation.
Both application Lambdas use Node.js 22 with esbuild targeting `node22`. GitHub workflows also use
Node.js 22; use that version locally for consistent builds and tests.
Test application roles now reference the administrator-owned `InfraLensTestApplicationBoundary`.
The [test permission package](TEST_DEPLOYMENT_PERMISSIONS.md) prepares its policy and a reviewed
bootstrap update. It must be applied separately before the first test application deployment.

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

## Next deployment checklist

1. Review and apply the prepared [test permission package](TEST_DEPLOYMENT_PERMISSIONS.md) in a
   separately authorized setup task. Both current administrator profiles remain broad; no IAM or
   Organizations changes were made here.
2. Verify the applied test bootstrap permissions and new deployment profile. Review production
   bootstrap read-only; do not rename, replace or update its `CDKToolkit` in this task.
3. Confirm production region and check proposed Cognito prefix availability before first deployment.
4. Plan/configure CloudTrail in a separately authorized task; it is currently unconfigured.
5. Verify the $1 management budget's scope; configure appropriate member-account coverage,
   recipients/alerts and cost monitoring. Budgets are not real-time spending caps.
6. Run test preflight and template diff, review resources/policies/costs, then authorize the first
   persistent test deployment. Export outputs, invite users, generate/build/upload the test frontend.
7. In a later task verify both test frontends, token rejection/renewal, two-user isolation and actual
   storage behavior. Run no browser E2E, hosted smoke or live-storage checks as part of this change.
