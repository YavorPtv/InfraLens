# Test deployment permission package

Status: **test SSO login, bootstrap update and publishing-policy correction applied by the user and inspected read-only**. This package targets only account `230944684535`,
region `eu-central-1`, application stack `InfraLensTestStack`, and the existing version 32
`CDKToolkit` with qualifier `hnb659fds`. Production's bootstrap is outside this package.

On October 4, 2026, the user configured `InfraLensTestDeploy` and the `infralens-test-deploy` CLI
profile. Their STS result identifies the expected test account and SSO role. Read-only IAM
inspection confirmed that role's inline policy matches `test-deployer.policy.json`, with no
attached managed policies or boundary. User/group assignments have not been independently
inspected. The user subsequently applied the bootstrap update. Read-only inspection confirmed
`UPDATE_COMPLETE`, the three scoped execution policies instead of `AdministratorAccess`, and the
application boundary. A deeper readiness audit found one leftover publishing policy, described below.
The user applied its correction on October 4. Subsequent read-only inspection confirmed
`UPDATE_COMPLETE`, no managed policies on the file-publishing role, and exactly one inline policy
(the existing default-named policy) whose document matches `test-file-publishing-role.policy.json`.
The publishing-policy procedure below is retained for reference; this account does not need that
repair applied again. The first deployment subsequently exposed a separate missing bootstrap-version
read on the CloudFormation execution role. That correction is now present in the deployed bootstrap
template. The API tagging correction is also present in the October 5 bootstrap snapshot. The latest
failure concerns the API Gateway logging role's permissions boundary; its correction below is prepared
locally and has not been applied to AWS.

## API Gateway logging boundary correction

October 5 read-only inspection found the current application in `ROLLBACK_COMPLETE`, stack ARN
`arn:aws:cloudformation:eu-central-1:230944684535:stack/InfraLensTestStack/5f5ff451-c01b-11f1-abb5-066020afc539`.
The retained logging role is
`InfraLensTestStack-AnalysisApiCloudWatchRole9101699-coXyuXB7hbGF`. It correctly trusts
`apigateway.amazonaws.com`, has `AmazonAPIGatewayPushToCloudWatchLogs` attached, no inline policies,
and uses `InfraLensTestApplicationBoundary`. The role's managed policy permits the seven required
logging actions on `*`; the boundary instead limited six of them to application/execution log prefixes.
Actual-role IAM simulation confirmed those six broader operations were blocked by the boundary.

`ApiGatewayAccountLogging` now permits the seven documented logging actions on `*` **only** when
`aws:PrincipalArn` matches the test `InfraLensTestStack-AnalysisApiCloudWatchRole*` roles and
`aws:RequestedRegion` is `eu-central-1`. This reflects the regional, account-level logging role used
by REST API Gateway. It allows that role broader regional log access, including unrelated log groups;
it does not give the Lambda role that exception. Existing Lambda log/data restrictions and explicit
identity-administration/role-chaining denies are preserved. Boundaries limit grants; this statement
does not attach new identity permissions to other roles or create a production boundary.

The prepared proposal changes only `InfraLensTestApplicationBoundary.Properties.PolicyDocument`:

```powershell
npm.cmd run prepare-test-permissions --workspace @infralens/cdk -- cdk.out/test-bootstrap-before-logging-fix.snapshot.json cdk.out/test-bootstrap-api-logging-fix.template.json --repair-api-logging-boundary
```

The command is offline, validates the known test bootstrap, refuses unexpected boundary edits or an
already applied correction, and preserves all other template fields and previous fixes. The snapshot
and both readable/compact proposals are ignored local files in `infra/cdk/cdk.out`.

Apply the correction manually using the test administrator session, account `230944684535`, region
`eu-central-1`: CloudFormation > `CDKToolkit` > Create a change set. Upload
`infra/cdk/cdk.out/test-bootstrap-api-logging-fix.template.json.compact.json`, preserve **all** current
parameters including `BootstrapVariant=InfraLensTestScopedV1`, name it
`infralens-test-api-logging-fix`, and acknowledge named IAM resources. Expect exactly one **Modify**,
`InfraLensTestApplicationBoundary`, with no replacement and only the new logging statement. Review
that preview, execute it, and wait for `UPDATE_COMPLETE`. The existing retained logging role already
uses this boundary, so its maximum permissions change with the managed policy; no trust edit or
manual policy attachment is needed.

The current application remains `ROLLBACK_COMPLETE`; the wrapper will block deployment until a
separate failed-stack recovery is completed. The older retained-resource inventory below belongs to
a different stack attempt and must not be used for current cleanup. Recheck current resources before
any separately authorized deletion/import. Do not delete `CDKToolkit` or CloudTrail.

Verification: CDK build/typechecks and all 55 tests passed, including both environment synthesis
assertions. The actual role simulated with the proposed boundary override permits all seven required
logging actions. CloudFormation template syntax and the one-policy snapshot comparison passed.
AWS policy validation returned no findings for all eight documents; 49 IAM simulations passed,
including the role/region exclusions, with the existing three API tag-deletion limitations reported
as unverified rather than counted as passes.
These checks do not execute API Gateway account configuration or prove the complete deployment.
No AWS writes, deployment, cleanup, commit or push were performed for this correction.

Reference: [AWS API Gateway logging policy and required actions](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonAPIGatewayPushToCloudWatchLogs.html).

## API ownership-tag correction and failed-stack recovery

Historical October 4 procedure: the current bootstrap now includes this tagging correction. Its
failed-stack inventory below is historical; use the latest logging failure/status above for planning.

The next deployment failed on `AnalysisApi6763914B`: `KeepApiOwnershipTagsImmutable` denied
`apigateway:PUT` whenever `Project` or `Environment` appeared in `aws:TagKeys`. This also denied the
required initial tag write. Adding another Allow cannot override an explicit Deny.

The corrected `test-execution-edge-auth.policy.json` changes three deny statements:

- Keep denying deletion of `Project` and `Environment` through `apigateway:DELETE`.
- Allow writing/reapplying `Project=InfraLens` and `Environment=test` through the existing tag grant.
- Include `apigateway:PUT` in the value protections, denying a requested ownership tag with a
  different value. Requests concerning only unrelated keys are unaffected.

No Allow statement, SSO policy, role trust, application boundary or production resource changes.
AWS's read-only IAM simulator reproduced the original explicit deny and allowed the corrected
request using an encoded API tagging ARN and `aws:TagKeys` as a string list. PUT tagging cases work.
DELETE tagging simulation returned `implicitDeny` with no matched statements even under unconditional
wildcard Allow and Deny controls. The three DELETE cases are explicitly marked unverified in the
simulation fixtures/script, not counted as passes. The unchanged removal deny has structural tests;
its live enforcement remains unverified. Earlier API operation simulation limitations also remain.

The proposal comes from the current applied bootstrap, retaining the previous fixes:

```powershell
npm.cmd run prepare-test-permissions --workspace @infralens/cdk -- cdk.out/test-bootstrap-before-api-tags-fix.snapshot.json cdk.out/test-bootstrap-api-tags-fix.template.json --repair-api-ownership-tags
```

This is offline. The preparer validates the test bootstrap and refuses unexpected policy changes.
The actual snapshot comparison changes only `InfraLensTestExecutionEdgeAuth.PolicyDocument`.
CDK typechecks/build and all 52 tests passed, including both target synthesis assertions and mocked
failed-stack safeguards. CloudFormation syntax validation passed; these checks do not deploy anything.
The final read-only policy check validated all eight documents without findings: 38 simulations
passed and three DELETE tagging cases were explicitly reported as unverified.
To apply it manually, use the test administrator session in account `230944684535`, region
`eu-central-1`: CloudFormation > `CDKToolkit` > Create a change set. Upload
`infra/cdk/cdk.out/test-bootstrap-api-tags-fix.template.json.compact.json`, preserve **all** current
parameters including `BootstrapVariant=InfraLensTestScopedV1`, name the change set
`infralens-test-api-tags-fix`, and acknowledge named IAM resources. Expect one **Modify** for
`InfraLensTestExecutionEdgeAuth`, no replacement, and only the three deny-rule changes above.
Execute only after reviewing that preview, then wait for `UPDATE_COMPLETE`.

Do not immediately retry the application: read-only inspection found `InfraLensTestStack` in
`ROLLBACK_COMPLETE`. The installed CDK CLI attempts to delete/recreate failed-creation stacks;
the routine role denies `DeleteStack`. The wrapper now checks application identity/status before
synthesis and blocks failed or active stacks, even when invoked with an administrator profile.
Only an explicit AWS missing-stack error permits a fresh create. No deletion or recovery is automatic.

The failed stack has these eight resources marked `DELETE_SKIPPED` with `DeletionPolicy: Retain`:

| Resource | Physical ID |
| --- | --- |
| API access logs | `InfraLensTestStack-AnalysisApiAccessLogGroup47F74889-jxk4TzEjl3MI` |
| API logging role | `InfraLensTestStack-AnalysisApiCloudWatchRole9101699-44gw5AnXS02r` |
| Lambda logs | `InfraLensTestStack-AnalysisFunctionLogGroup860A7F87-AOI3Yh16iwVK` |
| Artifacts | `infralensteststack-artifactbucket7410c9ef-fjcegyfgoblp` |
| Frontend assets | `infralensteststack-frontendbucketefe2e19c-ur3xyfc7hd7e` |
| Projects | `InfraLensTestStack-ProjectsTableAA0A2089-17UBQANX3CX4Y` |
| Runs | `InfraLensTestStack-RunsTable9D121A51-18M3UAGWVRXF4` |
| Cognito pool | `eu-central-1_P4u9SrKJc` |

Inventory and template evidence are in ignored `cdk.out/test-failed-deployment-resources.json` and
`cdk.out/test-failed-deployment-template.json`. Retained status is not proof of empty resources;
their contents have not been inspected. Buckets must not be automatically emptied.

Recovery is a separate decision: after applying the policy correction, an administrator must
intentionally remove the failed stack record before a fresh creation, or plan resource import into
a replacement stack. Deleting the record does not clean up retained resources. Preserve/export this
inventory first, decide whether to retain/import or separately remove each resource, and recheck
the account/region/stack status before any deletion. A fresh create uses new generated names and
does not automatically adopt the retained resources. This task does not authorize or perform cleanup.
Do not delete `CDKToolkit`, the CloudTrail trail or its bucket. Do not rerun deploy until recovery
is explicitly reviewed; no deletion command is embedded in the deployment workflow.

Sources: [API Gateway tagging condition support](https://docs.aws.amazon.com/service-authorization/latest/reference/list_apigateway.html),
[CloudFormation stack status and retained resources](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/view-stack-events.html).

## Bootstrap version read correction after the first deployment attempt

Historical procedure: the deployed bootstrap template now contains this correction. Do not apply
an older proposal over the newer API tagging correction or retry the failed application using the
historical command below before completing the recovery review above.

The first deployment failed during change-set preparation: CloudFormation's execution role
`cdk-hnb659fds-cfn-exec-role-230944684535-eu-central-1` lacked `ssm:GetParameters` on
`arn:aws:ssm:eu-central-1:230944684535:parameter/cdk-bootstrap/hnb659fds/version`.
The deployment and lookup roles already had version reads, but their permissions are not inherited
by the separate execution role. This was an omission in the prepared execution policy.

`test-execution-storage-compute.policy.json` now permits only that action on that exact parameter.
It grants no parameter writes or reads of other parameters. The SSO permission set, role trust and
application permissions boundary do not change. The correction belongs in the CloudFormation-owned
managed policy, rather than a manual extra inline policy that would diverge from the template.

Read-only inspection after the failure returned `Stack with id InfraLensTestStack does not exist`.
No application stack deletion is needed for that observed state. This does not imply that asset
publishing made no writes to the bootstrap bucket before the failure.

The ignored local proposal was prepared from a fresh test `CDKToolkit` snapshot:

```powershell
npm.cmd run prepare-test-permissions --workspace @infralens/cdk -- cdk.out/test-bootstrap-before-ssm-fix.snapshot.json cdk.out/test-bootstrap-ssm-read-fix.template.json --repair-bootstrap-version-read
```

This command is offline. It validates the test account, region, bootstrap identity/version/variant,
policy name and execution-role attachment; it refuses to overwrite unexpected policy changes or an
already corrected policy. The resulting template modifies only
`InfraLensTestExecutionStorageCompute.Properties.PolicyDocument`. All other template fields,
parameters, roles, resource names and the previous publishing correction are preserved.
For a later refresh, use the read-only snapshot export procedure in this guide with the new filename.

Validation: CDK build/typechecks and all 47 tests passed, including both target synthesis assertions.
AWS Access Analyzer reported no findings for eight policy documents; 33 IAM simulations passed,
including the new allow/deny cases. The actual template comparison changed only the expected policy
document, and CloudFormation syntax validation passed. This does not apply the correction or prove
all later provisioning permissions.

Apply the prepared correction manually in the AWS console:

1. Use the test administrator session. Confirm account `230944684535` and region `eu-central-1`.
2. Open CloudFormation > `CDKToolkit` > Stack actions > Create a change set. Replace the current
   template by uploading `infra/cdk/cdk.out/test-bootstrap-ssm-read-fix.template.json.compact.json`.
3. Keep **all current parameter values**, including `BootstrapVariant=InfraLensTestScopedV1`.
   Name the change set `infralens-test-bootstrap-version-read`; acknowledge named IAM resources.
4. Review the preview. Expect exactly one **Modify**, logical ID
   `InfraLensTestExecutionStorageCompute`, type `AWS::IAM::ManagedPolicy`, with no replacement.
   Its document adds only `ReadTestBootstrapVersion`. Stop if the preview differs.
5. Execute that reviewed change set and wait for `CDKToolkit` to reach `UPDATE_COMPLETE`.

Steps 2–5 are administrator AWS operations for the user to perform; the assistant has not executed
them. Do not rerun the default bootstrap or edit production's `CDKToolkit` for this correction.
After successful application, retry the application with the routine profile from the repository root:

```powershell
npm.cmd run deploy --workspace @infralens/cdk -- --target test --region eu-central-1 --stack InfraLensTestStack --profile infralens-test-deploy
```

If a later attempt reports a different denial or leaves a failed stack, inspect that exact error
and stack state before retrying. Do not automatically delete the stack or switch the application
deployment to administrator access. The initial preflight/diff did not exercise CloudFormation's
parameter resolution; a passing template diff cannot prove all provisioning permissions.

References: [AWS Systems Manager actions and parameter resource scope](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ssm.html),
[CDK bootstrap version parameter](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html).

## Publishing-policy correction before first deployment

The original preparer missed `FilePublishingRoleDefaultPolicy`, a separate `AWS::IAM::Policy`
resource owned by the bootstrap stack. Adding `FilePublishingRole.Properties.Policies` did not
replace it. The file-publishing role therefore had both the scoped inline policy and the old
bootstrap policy, including `s3:DeleteObject*` on the test bootstrap bucket. Its KMS statement also
remained, targeting the `AWS_MANAGED_KEY` placeholder. The execution role's administrator policy
was removed correctly; the issue was confined to the file-publishing role among the four inspected
roles. Their other policies and trust documents match the intended configuration.

The preparer now updates the separately owned policy and avoids adding a duplicate. The dedicated
repair mode accepts the known applied `InfraLensTestScopedV1` setup and changes only:

1. `FilePublishingRoleDefaultPolicy`: replace its document with `test-file-publishing-role.policy.json`.
2. `FilePublishingRole`: remove the redundant `InfraLensTestScopedAccess` inline policy.

It preserves resource IDs/names, trust, all other policies, bucket/repository configuration and all
parameters. No resources are added or removed. The original initial-setup command still rejects
an already customized bootstrap; use the explicit repair flag for this correction.

The latest applied snapshot and repair are ignored local artifacts under `infra/cdk/cdk.out`.
For a fresh export, use the read-only export/conversion procedure below with the filenames
`test-bootstrap-applied-state.json`, `test-bootstrap-applied-template.json` and
`test-bootstrap-applied-snapshot.json`. Then generate the correction offline:

```powershell
npm.cmd run prepare-test-permissions --workspace @infralens/cdk -- cdk.out/test-bootstrap-applied-snapshot.json cdk.out/test-bootstrap-file-publishing-fix.template.json --repair-file-publishing-policy
```

The October 4 repair passed CloudFormation syntax validation and 42 credential-free CDK tests.
The user has now applied the repair; the assistant only inspected it read-only. For reference, to create the
preview in the console, use the test administrator session in account `230944684535`, region
`eu-central-1`: CloudFormation > CDKToolkit > Stack actions > Create a change set. Upload
`test-bootstrap-file-publishing-fix.template.json.compact.json`, preserve **all** current parameters
(including `BootstrapVariant=InfraLensTestScopedV1`), and acknowledge named IAM resources. Expect
only the two modifications above and no replacements. Execute only after that review, then inspect
the role to confirm only its existing default-named inline policy remains and its document matches
`test-file-publishing-role.policy.json`. Do not manually delete the CloudFormation-owned policy.

PowerShell alternative for creating the preview, using the prepared compact template:

```powershell
$repairAccount = aws sts get-caller-identity --profile infralens-test-admin --region eu-central-1 --query Account --output text --no-cli-pager
if ($LASTEXITCODE -ne 0 -or $repairAccount -ne '230944684535') { throw 'Expected test account 230944684535.' }
$repairStateJson = aws cloudformation describe-stacks --stack-name CDKToolkit --profile infralens-test-admin --region eu-central-1 --output json --no-cli-pager
if ($LASTEXITCODE -ne 0) { throw 'Could not read test bootstrap state.' }
$repairState = ($repairStateJson | ConvertFrom-Json).Stacks[0]
if (-not $repairState.StackId.StartsWith('arn:aws:cloudformation:eu-central-1:230944684535:stack/CDKToolkit/') -or $repairState.StackStatus -ne 'UPDATE_COMPLETE') { throw 'Unexpected bootstrap identity or status.' }
if (($repairState.Parameters | Where-Object ParameterKey -eq 'BootstrapVariant').ParameterValue -ne 'InfraLensTestScopedV1') { throw 'Unexpected bootstrap variant.' }
$repairParameters = @($repairState.Parameters | ForEach-Object { @{ ParameterKey = $_.ParameterKey; UsePreviousValue = $true } })
$repairParameterPath = Join-Path (Get-Location) 'infra/cdk/cdk.out/test-bootstrap-repair-parameters.json'
[IO.File]::WriteAllText($repairParameterPath, ($repairParameters | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
aws cloudformation create-change-set --stack-name CDKToolkit --change-set-name infralens-test-file-publishing-fix --change-set-type UPDATE --template-body file://infra/cdk/cdk.out/test-bootstrap-file-publishing-fix.template.json.compact.json --parameters file://infra/cdk/cdk.out/test-bootstrap-repair-parameters.json --capabilities CAPABILITY_NAMED_IAM --profile infralens-test-admin --region eu-central-1 --no-cli-pager
if ($LASTEXITCODE -ne 0) { throw 'Repair change-set creation failed.' }
aws cloudformation wait change-set-create-complete --stack-name CDKToolkit --change-set-name infralens-test-file-publishing-fix --profile infralens-test-admin --region eu-central-1
if ($LASTEXITCODE -ne 0) { throw 'Repair change set is not ready.' }
aws cloudformation describe-change-set --stack-name CDKToolkit --change-set-name infralens-test-file-publishing-fix --profile infralens-test-admin --region eu-central-1 --no-cli-pager
```

After reviewing the two-resource preview, execution is a separate AWS write:

```powershell
$repairAccount = aws sts get-caller-identity --profile infralens-test-admin --region eu-central-1 --query Account --output text --no-cli-pager
if ($LASTEXITCODE -ne 0 -or $repairAccount -ne '230944684535') { throw 'Expected test account 230944684535.' }
aws cloudformation execute-change-set --stack-name CDKToolkit --change-set-name infralens-test-file-publishing-fix --profile infralens-test-admin --region eu-central-1 --no-cli-pager
if ($LASTEXITCODE -ne 0) { throw 'Repair execution failed.' }
aws cloudformation wait stack-update-complete --stack-name CDKToolkit --profile infralens-test-admin --region eu-central-1
if ($LASTEXITCODE -ne 0) { throw 'Inspect bootstrap events before continuing.' }
```

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
| `test-file-publishing-role.policy.json` | Replaces the document of `FilePublishingRoleDefaultPolicy`, attached to `FilePublishingRole` |
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
  authorization. Ownership tags are protected against removal or writes of other values. The API
  tag endpoint must allow the correct values both during creation and on later idempotent writes.
  API Gateway's `Tags` authorization supports request tags and tag keys, not resource-tag conditions.
  Consequently the encoded REST API tag ARN wildcard can also label other APIs in this test region
  with InfraLens ownership. This is not a strict isolation boundary between apps in the same account;
  do not broaden these roles to other apps without reviewing separate deployment permissions.
- CloudFront's separate tag-on-create authorization can also tag a distribution with neither
  ownership tag in this test account. This is a limitation for unrelated **untagged** distributions;
  do not describe the tag controls as an absolute stack-membership boundary.
- CloudFront origin access controls cannot be scoped by tags/name before their IDs exist. Creation
  uses `Resource: "*"`; subsequent OAC actions cover that resource type in the test account. Tighten
  to the actual OAC ARN after first deployment if the account will host other applications.
- `apigateway:PATCH` on `/account` is required by the existing regional logging-account resource.
  It affects API Gateway's shared logging configuration in the test region. Role passing remains
  restricted to the bounded application logging role.
- The boundary allows the API Gateway logging role the seven required regional account-level logging
  actions on `*`, guarded by its test role ARN prefix and region. This role can access broader regional
  logs; the Lambda role does not receive this exception. See the logging correction above.
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

During initial preparation, some API Gateway simulations returned `implicitDeny` even for a diagnostic
wildcard allow. Those earlier cases remain excluded. The new encoded-ARN PUT tagging cases work and
are included, with string-list context for `aws:TagKeys`. DELETE tagging cases are marked unverified
after contradictory wildcard Allow/Deny controls; the script reports them separately from passes.
The simulator discrepancy remains unresolved.
API Gateway authorization, provider
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
2. Replace the separately owned `FilePublishingRoleDefaultPolicy` document.
3. Add the application boundary and three execution managed policies.
4. Set the `BootstrapVariant` default to `InfraLensTestScopedV1`.

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
2. Refresh the snapshot and generated template immediately before application. Review the four-role,
   existing publishing-policy and four-new-policy changes described above. Bootstrap updates use the existing test administrator
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
the SSO permission set and initial bootstrap update. The readiness audit identified the leftover
publishing policy described at the top of this guide; the user subsequently applied the repair,
and read-only inspection confirmed that the leftover grants and duplicate inline policy are gone.

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
