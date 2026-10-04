# Test deployment permission package

Status: **test SSO login created; bootstrap update prepared, not applied**. This package targets only account `230944684535`,
region `eu-central-1`, application stack `InfraLensTestStack`, and the existing version 32
`CDKToolkit` with qualifier `hnb659fds`. Production's bootstrap is outside this package.

On October 4, 2026, the user configured `InfraLensTestDeploy` and the `infralens-test-deploy` CLI
profile. Their STS result identifies the expected test account and SSO role. Read-only IAM
inspection confirmed that role's inline policy matches `test-deployer.policy.json`, with no
attached managed policies or boundary. User/group assignments have not been independently
inspected. The remaining bootstrap update must be reviewed and applied before routine deployment;
the bootstrap roles still have their previous broad permissions.

Both existing administrator profiles remain administrators. The new permission set/profile below
is for routine test deployment. Retaining administrator access for setup means its holder can still
choose that separate access; this package does not restrict the existing administrator identity.

## Files and attachment points

All policy files are in the existing `infra/cdk` directory. They contain no credentials or tokens.

| File | Intended attachment |
| --- | --- |
| `test-deployer.policy.json` | Inline policy of the new Identity Center permission set `InfraLensTestDeploy` |
| `test-deployment-role.policy.json` | Replaces the inline and managed grants on the existing test `DeploymentActionRole` |
| `test-lookup-role.policy.json` | Replaces the inline and managed grants on the existing test `LookupRole` |
| `test-file-publishing-role.policy.json` | Replaces the existing test `FilePublishingRole` grants |
| `test-execution-iam.policy.json` | Managed policy `InfraLensTestExecutionIam` on the test CloudFormation execution role |
| `test-execution-storage-compute.policy.json` | Managed policy `InfraLensTestExecutionStorageCompute` on that execution role |
| `test-execution-edge-auth.policy.json` | Managed policy `InfraLensTestExecutionEdgeAuth` on that execution role |
| `test-application-boundary.policy.json` | Managed policy `InfraLensTestApplicationBoundary`, used as the boundary on both application roles |

The offline preparer embeds these documents into a copy of the existing bootstrap template. It
replaces broad grants rather than adding narrow grants alongside `AdministratorAccess`. It changes
the trust of deployment, file-publishing and lookup roles to allow only the test account's Identity
Center role matching `AWSReservedSSO_InfraLensTestDeploy_*`. The SSO home region `eu-central-1` was
observed in the existing administrator role's path. A differently located Identity Center instance
requires a reviewed trust-policy change.

The four customer managed policies are owned by the bootstrap stack, administered separately from
the application. The application execution role cannot update them. Routine deployments cannot
update `CDKToolkit`, pass another execution role, or call `DeleteStack`. Resource deletion permissions
needed for updates/rollback are still present: this is not a guarantee against deleting application
resources through a template change. Review diffs. Existing retained data remains retained by CDK.

Test synthesis now puts the externally managed boundary on the Lambda role and API Gateway's
logging role. **Create that boundary through the reviewed setup before deploying the application.**
It limits permissions; it does not grant access by itself. Existing application identity policies
still grant the actual runtime permissions. Production synthesis and fully local memory mode do
not acquire this test boundary.

## Scope and deliberate limits

- The SSO login can inspect the selected stack/bootstrap and assume three exact test roles. It has
  no direct infrastructure writes, IAM administration, or access to production roles.
- Deployment changes target `InfraLensTestStack` and pass only the selected execution role to
  CloudFormation. The lookup role reads application/bootstrap metadata, not account-wide data.
- Asset publishing permits writes only to the existing test bootstrap bucket. It cannot delete
  assets. The unused image publishing role and ECR repository are preserved; this login cannot
  assume that role. Docker assets are outside this package.
- Execution permissions cover the current default application template. Named resources use the
  generated `InfraLensTestStack-` prefixes (lowercase for S3). Reserve these prefixes for this app.
  Optional SNS/email/budget resources, custom domains, VPCs, customer KMS keys and additional services
  require a new review; their permissions are not added speculatively.
- API Gateway, Cognito and CloudFront resources with generated IDs use `Project=InfraLens` and
  `Environment=test` tags where supported. API child resources inherit their REST API's tags for
  authorization. Ownership tags are protected against removal/change. API ownership tags must be
  supplied during REST API creation; a later `/tags` request cannot add or rewrite them.
- CloudFront's separate tag-on-create authorization can also tag a distribution with neither
  ownership tag in this test account. This is a limitation for unrelated **untagged** distributions;
  do not describe the tag controls as an absolute stack-membership boundary.
- CloudFront origin access controls cannot be scoped by tags/name before their IDs exist. Creation
  uses `Resource: "*"`; subsequent OAC actions cover that resource type in the test account. Tighten
  to the actual OAC ARN after first deployment if the account will host other applications.
- `apigateway:PATCH` on `/account` is required by the existing regional logging-account resource.
  It affects API Gateway's shared logging configuration in the test region. Role passing remains
  restricted to the bounded application logging role.
- API reads with no resource-level authorization (for example domain-status, log-group discovery,
  template validation and hook-result reads) use `Resource: "*"` with a regional condition where
  applicable. Global CloudFront and IAM operations cannot use an `eu-central-1` blanket deny.
- Application roles cannot administer IAM or assume another role. Their boundary permits the
  required logs, test history rows, owner artifacts and CloudFormation template validation.
  API execution-log names contain an AWS-generated API ID, so the logging ceiling includes
  `API-Gateway-Execution-Logs_*/test` in this account/region.
- A deployment operator controls application code, configuration and its resource policies. This
  package is not a restriction against that operator accessing or exposing the application's data.
  It is a scoped deployment baseline, not proof of the mathematically smallest permission set.
- Frontend object upload/invalidation and Cognito user invitations are separate operations. The
  routine deployment login has no direct permissions for them. Prepare those grants from the actual
  deployment outputs later; do not reuse the administrator profile as routine frontend access.

## Checks available now

Run from the repository root in PowerShell:

```powershell
npm.cmd run typecheck --workspace @infralens/cdk
npm.cmd run test --workspace @infralens/cdk
npm.cmd run synth --workspace @infralens/cdk -- --target test
npm.cmd run synth --workspace @infralens/cdk -- --target production
```

These commands are credential-free. Tests check policy sizes, scopes, boundary requirements,
role passing, trust changes, template preservation and rejection of the wrong bootstrap snapshot.
They also synthesize the real application roles with their required test boundary.

Optional **read-only AWS** policy validation and simulations:

```powershell
& ./infra/cdk/verify-test-policies.ps1 -Profile infralens-test-admin
```

The script verifies the caller account before submitting policy documents to Access Analyzer and
IAM's simulator. It never attaches a policy, assumes a deployment role or invokes the simulated
operations. `test-policy-simulations.json` contains the expected decisions. Boundary cases test the
boundary's ceiling as a standalone policy, not the complete effective permissions of a live role.

During preparation, API Gateway simulation returned `implicitDeny` even for a diagnostic wildcard
allow. The runnable simulation cases exclude API Gateway; its documented conditions remain in the
policy and structural tests. This discrepancy is unresolved. API Gateway authorization, provider
tagging behavior and complete deployment compatibility need confirmation during the first approved
test deployment. Do not broaden permissions automatically to work around a failure. Access Analyzer
validation and simulation are not evidence of successful live deployment or effective role trust.

## Export the bootstrap snapshot: read-only AWS

The following commands are available now with an active administrator SSO session. They write only
ignored local files under `infra/cdk/cdk.out`. Run offline synthesis first to create that directory.

```powershell
$auditAccount = aws sts get-caller-identity --profile infralens-test-admin --region eu-central-1 --query Account --output text --no-cli-pager
if ($LASTEXITCODE -ne 0 -or $auditAccount -ne '230944684535') {
    throw 'Expected test account 230944684535.'
}

$bootstrapState = aws cloudformation describe-stacks --stack-name CDKToolkit --profile infralens-test-admin --region eu-central-1 --output json --no-cli-pager
if ($LASTEXITCODE -ne 0) { throw 'Could not read bootstrap state.' }
$bootstrapState | Set-Content -Encoding utf8 infra/cdk/cdk.out/test-bootstrap-state.json

$bootstrapTemplate = aws cloudformation get-template --stack-name CDKToolkit --template-stage Original --profile infralens-test-admin --region eu-central-1 --output json --no-cli-pager
if ($LASTEXITCODE -ne 0) { throw 'Could not read bootstrap template.' }
$bootstrapTemplate | Set-Content -Encoding utf8 infra/cdk/cdk.out/test-bootstrap-audit.json
```

Convert the returned YAML template to JSON locally, using the repository's existing `yaml`
dependency (already installed for the analyzer; no new dependency is required):

```powershell
@'
const fs = require('node:fs');
const yaml = require('yaml');
const read = path => JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const state = read('infra/cdk/cdk.out/test-bootstrap-state.json');
const exported = read('infra/cdk/cdk.out/test-bootstrap-audit.json');
const snapshot = {
  Stacks: state.Stacks,
  TemplateBody: typeof exported.TemplateBody === 'string'
    ? yaml.parse(exported.TemplateBody) : exported.TemplateBody
};
fs.writeFileSync('infra/cdk/cdk.out/test-bootstrap-snapshot.json', JSON.stringify(snapshot, null, 2));
'@ | node
if ($LASTEXITCODE -ne 0) { throw 'Snapshot conversion failed.' }
```

## Prepare a bootstrap update: entirely offline

```powershell
npm.cmd run prepare-test-permissions --workspace @infralens/cdk -- cdk.out/test-bootstrap-snapshot.json cdk.out/test-bootstrap-scoped.template.json
```

The preparer rejects another account/region/stack, unhealthy status, another bootstrap version,
changed trust/execution parameters or renamed roles. It is specifically for the audited initial
version 32 setup, not a general bootstrap updater. It does not modify the snapshot or invoke AWS.
It writes a readable review template and an equivalent compact `.json.compact.json` copy to fit
CloudFormation's `--template-body` limit. Review the readable copy. Expected changes:

1. Modify the deployment, lookup, file publishing and execution roles without changing their names.
2. Add the application boundary and three execution managed policies.
3. Set the `BootstrapVariant` default to `InfraLensTestScopedV1`.

All other bootstrap resources, IDs, bucket/repository configuration, outputs and version remain
unchanged. The bootstrap variant must also be set as a parameter when applying the update; this
protects against a later ordinary CDK bootstrap overwriting the customized policy configuration.

Read-only CloudFormation syntax validation, after the account check above:

```powershell
aws cloudformation validate-template --template-body file://infra/cdk/cdk.out/test-bootstrap-scoped.template.json.compact.json --profile infralens-test-admin --region eu-central-1 --no-cli-pager
```

## Later application: AWS changes, not executed in this task

Apply only after the policy files and bootstrap diff have been reviewed and IAM/bootstrap changes
are explicitly authorized. Do not edit bootstrap roles manually and leave CloudFormation drift.
Keep existing administrator access available throughout setup.

1. In the management account's IAM Identity Center, create a **custom** permission set named
   `InfraLensTestDeploy`, with a one-hour session and `test-deployer.policy.json` as its inline policy.
   Attach no administrator/PowerUser managed policies. Assign your intended user/group to this
   permission set in **test account 230944684535 only**. Identity Center creates the SSO role;
   do not create or edit an `AWSReservedSSO_*` role manually.
2. Refresh the snapshot and generated template immediately before application. Review the four-role
   and four-policy change described above. Bootstrap updates use the existing test administrator
   profile, not the new deployment login.
3. Create and inspect a bootstrap change set with all current parameters preserved except the
   explicitly changed variant. These are **future AWS write commands**, not verification commands:

```powershell
$setupAccount = aws sts get-caller-identity --profile infralens-test-admin --region eu-central-1 --query Account --output text --no-cli-pager
if ($LASTEXITCODE -ne 0 -or $setupAccount -ne '230944684535') {
    throw 'Expected test account 230944684535. Setup stopped.'
}
$snapshot = Get-Content -Raw infra/cdk/cdk.out/test-bootstrap-snapshot.json | ConvertFrom-Json
if (-not $snapshot.Stacks[0].StackId.StartsWith('arn:aws:cloudformation:eu-central-1:230944684535:stack/CDKToolkit/')) {
    throw 'Wrong bootstrap snapshot.'
}
$setupParameters = @($snapshot.Stacks[0].Parameters | ForEach-Object {
    if ($_.ParameterKey -eq 'BootstrapVariant') {
        @{ ParameterKey = $_.ParameterKey; ParameterValue = 'InfraLensTestScopedV1' }
    } else {
        @{ ParameterKey = $_.ParameterKey; UsePreviousValue = $true }
    }
})
$parameterPath = Join-Path (Get-Location) 'infra/cdk/cdk.out/test-bootstrap-parameters.json'
[IO.File]::WriteAllText($parameterPath, ($setupParameters | ConvertTo-Json), [Text.UTF8Encoding]::new($false))

aws cloudformation create-change-set --stack-name CDKToolkit --change-set-name infralens-test-scoped-permissions --change-set-type UPDATE --template-body file://infra/cdk/cdk.out/test-bootstrap-scoped.template.json.compact.json --parameters file://infra/cdk/cdk.out/test-bootstrap-parameters.json --capabilities CAPABILITY_NAMED_IAM --profile infralens-test-admin --region eu-central-1 --no-cli-pager
if ($LASTEXITCODE -ne 0) { throw 'Change-set creation failed.' }
aws cloudformation wait change-set-create-complete --stack-name CDKToolkit --change-set-name infralens-test-scoped-permissions --profile infralens-test-admin --region eu-central-1
if ($LASTEXITCODE -ne 0) { throw 'Change set is not ready. Inspect its status.' }
aws cloudformation describe-change-set --stack-name CDKToolkit --change-set-name infralens-test-scoped-permissions --profile infralens-test-admin --region eu-central-1 --no-cli-pager
```

Do not proceed if the change set deletes/replaces bootstrap resources or differs from the expected
changes. Execution is a separate intentional action **after reviewing the actual change set**:

```powershell
$executionAccount = aws sts get-caller-identity --profile infralens-test-admin --region eu-central-1 --query Account --output text --no-cli-pager
if ($LASTEXITCODE -ne 0 -or $executionAccount -ne '230944684535') {
    throw 'Expected test account 230944684535. Execution stopped.'
}
aws cloudformation execute-change-set --stack-name CDKToolkit --change-set-name infralens-test-scoped-permissions --profile infralens-test-admin --region eu-central-1 --no-cli-pager
if ($LASTEXITCODE -ne 0) { throw 'Change-set execution failed.' }
aws cloudformation wait stack-update-complete --stack-name CDKToolkit --profile infralens-test-admin --region eu-central-1
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap update did not complete. Inspect events using the administrator profile.' }
```

4. Reinspect the effective attached/inline policies and trust on all modified roles. Verify the
   execution role no longer has `AdministratorAccess`, the three routine roles have the restricted
   SSO trust, and the boundary exists. The wrapper's ordinary preflight does not perform this IAM
   audit. Do not treat its success as proof that the policies were applied correctly.
5. Configure the separate CLI profile, selecting test account `230944684535`, permission set
   `InfraLensTestDeploy`, and default region `eu-central-1`:

```powershell
aws configure sso --profile infralens-test-deploy
aws sso login --profile infralens-test-deploy
npm.cmd run preflight --workspace @infralens/cdk -- --target test --region eu-central-1 --stack InfraLensTestStack --profile infralens-test-deploy
npm.cmd run diff --workspace @infralens/cdk -- --target test --region eu-central-1 --stack InfraLensTestStack --profile infralens-test-deploy
```

The target's existing administrator profile default is retained for compatibility; pass the new
profile explicitly. Only after these checks, the permission review and a separate deployment
decision should the first application deployment be run using `--profile infralens-test-deploy`.
No production setup command or teardown command is provided by this package.

## Evidence and remaining verification

Preparation results: 38 CDK tests, CDK typechecks/build and test/production offline synthesis passed.
Access Analyzer returned zero findings for all eight policy documents; 29 supported IAM simulation
cases passed. The generated compact bootstrap template passed CloudFormation `ValidateTemplate`.
No change set or bootstrap update was performed by the assistant. The user subsequently applied
the SSO permission set as recorded above; the remaining bootstrap policies are still proposals.

Preparation checked the actual test bootstrap role grants and public CloudFormation resource
handler permission schemas. The schemas include optional features not used here; those broad
optional grants were not copied blindly into the policies. Action names and supported resource
types/conditions were also checked against AWS's programmatic service authorization reference.

Before using the new access routinely, verify real provisioning, update/rollback behavior,
generated resource names, region/global-service behavior and the provider's tag-on-create calls.
On an access denial, inspect the exact operation/resource and add only a reviewed necessary grant.
Do not restore administrator permissions to make a deployment pass. Leave retained resources and
nonempty-bucket cleanup to the separate teardown process.

References:

- [AWS CDK deployment security](https://docs.aws.amazon.com/cdk/v2/guide/best-practices-security.html)
- [Custom bootstrap templates and bootstrap variants](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-customizing.html)
- [IAM permissions boundaries](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html)
- [Identity Center permission sets](https://docs.aws.amazon.com/singlesignon/latest/userguide/permissionsetsconcept.html)
- [API Gateway tag inheritance](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-tagging-supported-resources.html)
- [API Gateway tag policy examples](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-tagging-iam-policy.html)
- [CloudFront actions, resources and conditions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudfront.html)
- [IAM simulator behavior and limits](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_testing-policies.html)
