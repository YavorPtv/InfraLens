# InfraLens Handoff

Last refreshed: October 4, 2026.

## Latest checkpoint and unresolved failure

- The user subsequently reported another deployment failure at 20:46:04 on
  `AnalysisApiAccount6CD7A6DE` (`AWS::ApiGateway::Account`): API Gateway rejected the logging role ARN
  because its required trust or role permissions were not configured (`InvalidRequest`, HTTP 400).
  The exact cause has not been investigated; trust, attached grants and the application boundary
  are possibilities, not established findings.
- The user explicitly requested no fix or further investigation yet, then requested a commit of
  the current work. Preserve this stop instruction until they ask to resume. No AWS inspection,
  permission change, deployment or cleanup was performed for this latest failure.
- The earlier rollback status and retained-resource inventory below describe a previous attempt.
  Current stack state, resource inventory, cleanup actions and application of the latest tag repair
  have not been independently rechecked. Do not use the old inventory as authority for deletion.
- This checkpoint includes the earlier policy corrections, regression tests, failed-stack safeguard
  and deployment/CloudTrail documentation. Their passing checks do not establish that the complete
  test deployment succeeds. Production permissions still need separate review and validation.

## Current work and verified repository state

- Branch: `feature/separate-aws-environments`, created from clean `main` at `8896116`
  (`Add saved projects and analysis history (#53)`). The user requested a local commit of the
  environment-separation implementation. No push was requested.
- Saved projects/history is merged, not an uncommitted feature branch. Earlier handoff claims about
  `main` at `694ff3d`, missing persistence and missing Lambda authorizer claims were stale.
  `apps/api/src/lambda.ts` already reads trusted Cognito `sub`; saved reports can survive a fresh
  browser session. Stateless unsaved reports remain in browser state.
- Read `AGENTS.md` first. Preserve unrelated changes and keep the existing npm workspace layout.
  Analyzer logic remains independent of React/AWS SDK; no dependencies or workspace changes were added.
- This task prepares explicit AWS environment separation. No deployment, bootstrap, resource
  destruction, IAM/Organizations change, browser E2E, hosted smoke or live AWS storage test was
  performed by the assistant. A subsequent read-only test bootstrap/IAM audit is recorded below.
  No CI success is claimed.

## Environment separation implementation

Read [AWS test and production deployment](docs/PRODUCTION_DEPLOYMENT.md) for the exact PowerShell
commands, prerequisites, authentication behavior, retained resources and later deployment checklist.

| Environment | Account / region | Stack / behavior |
| --- | --- | --- |
| Local | No AWS needed | React + Express; explicit memory history and fake local identity |
| AWS test | `230944684535`, `eu-central-1` | `InfraLensTestStack`; persistent between test runs |
| Production | `609124256824`, proposed `eu-central-1` | `InfraLensProdStack`; no existing application stack |

- `infra/cdk/src/deployment-target.ts` defines explicit validated identities, Cognito prefixes and
  frontend origin settings. A target is mandatory. `NODE_ENV`, runtime settings and active AWS
  credentials cannot select a deployment target. Old `environment` CDK context is rejected.
- The same `InfraLensStack` defines both environments. Each owns its Lambda/API, two tables,
  artifact bucket, frontend/CloudFront and Cognito. Both use production runtime safeguards and AWS
  history storage; all 14 analysis/history methods require Cognito. Health and OPTIONS are public.
- The Lambda runtime and esbuild target now use Node.js 22 in both environments. Both GitHub
  workflows use Node.js 22 as well. Synthesis assertions check the runtime for both targets.
- The user confirmed **both** test frontends: the generated test CloudFront origin and exactly
  `http://localhost:5173`. Both use test Cognito. Production permits its own CloudFront origin only.
  Callback paths are `/auth/callback`; logout URLs end in `/`. Vite uses port 5173 with strictPort.
- `deployment-workflow.ts` implements synth/preflight/diff/deploy/frontend-config. Online commands
  validate explicit region/stack, verify STS caller account, and inspect bootstrap read-only before
  proceeding. They use a pinned profile/region with ambient credentials and endpoint/role overrides
  removed. Profile names alone are never identity evidence. Assembly identity is checked too.
- Production online commands additionally require `--confirm-production-region eu-central-1` while
  the region remains proposed in configuration. This is an invocation-level explicit decision.
- Synth directly runs the CDK app without CLI credential discovery. Assemblies are separated under
  `infra/cdk/cdk.out/test` and `infra/cdk/cdk.out/production`. No lookups or credentials are needed.
- Diff uses template comparison, without creating change sets or publishing assets. Deploy retains
  CDK's permission-broadening approval and can target only the application stack. Neither command
  bootstraps or destroys anything. Direct CDK CLI operations bypass wrapper safeguards; use scripts.
- Deploy writes ignored `infra/cdk/cdk-outputs.test.json` / `cdk-outputs.production.json`, including
  identity, API URL, table names, artifact bucket, frontend details and Cognito identifiers/URLs.
  `frontend-config` validates those outputs and generates ignored environment-specific Vite files.
  Hosted API configurations require auth. Browser sessions are scoped by Cognito domain and client.
- Frontend asset upload and first-user invitation remain later operations. CDK does not upload the
  web build. There are no actual deployment outputs from this task, and no tracked secrets/tokens.
- Test and production retain tables, buckets, Cognito pools and log groups on deletion/replacement.
  Production tables have PITR. Teardown is separate and intentional; nonempty buckets need manual
  cleanup before deletion. No auto-empty/auto-destroy functionality was added.

## AWS setup and read-only test permissions audit

- Organizations and IAM Identity Center are configured.
- Test profile `infralens-test-admin` and production profile `infralens-prod-admin` both have
  administrator permissions. They are **not** restricted deployment access. The separate test
  deployment login, scoped bootstrap update and publishing-policy correction are applied. No custom
  organization policies/restrictions were added.
- The user reports no production application stack, so no migration is needed. Production
  `CDKToolkit` exists according to the user and must remain unchanged; production was not inspected.
  Test initially had no bootstrap stack; the user later reported passing preflight and supplied
  the first application diff. A successful application deployment has not been reported.
- Read-only audit on October 3, 2026, using `infralens-test-admin`: STS confirmed account
  `230944684535` and the Identity Center `AdministratorAccess` role. `CDKToolkit` in `eu-central-1`
  is `CREATE_COMPLETE`, version 32, qualifier `hnb659fds`, with termination protection disabled.
  The administrator role and all five bootstrap roles were inspected for trust, attached/inline
  policies and permissions boundaries. The initial sandbox could not see the profile; the audit
  succeeded with host access. No credentials or tokens were collected or stored.
- At the initial October 3 audit, both the SSO administrator role and `cdk-hnb659fds-cfn-exec-role-230944684535-eu-central-1` had
  `AdministratorAccess` and no permissions boundary. The deployment role has CloudFormation write
  permissions on `*`, including stack deletion, and can pass that execution role. Its additional
  cross-account artifact grants are part of the default bootstrap policy. The lookup role has
  `ReadOnlyAccess` with an explicit KMS decrypt deny. The publishing roles target their bootstrap
  S3/ECR resources. Bootstrap role trusts name the test account, with no external account trust
  observed; account trust does not mean only the root user can assume them.
- The [test permission package](docs/TEST_DEPLOYMENT_PERMISSIONS.md) is now prepared: eight JSON
  policies in `infra/cdk`, the offline `prepare-test-permissions` command, and the optional read-only
  `verify-test-policies.ps1` script. The user applied the bootstrap changes; the publishing-policy
  correction described below has also been applied and inspected read-only. The routine
  profile is `infralens-test-deploy`, using permission set `InfraLensTestDeploy`; existing admin
  profiles remain administrators. The target default is retained; pass the new profile explicitly.
- On October 4, the user reported creating and assigning `InfraLensTestDeploy`, then supplied STS
  output for account `230944684535` and role `AWSReservedSSO_InfraLensTestDeploy_b55078ad9d9725df`.
  Read-only IAM inspection confirmed its expected Identity Center path, no attached managed
  policies or boundary, and an inline policy exactly matching `test-deployer.policy.json`.
  User/group assignments were reported by the user, not independently inspected. At this point
  the bootstrap roles were still broad; the user subsequently applied the proposed update.
- The October 4 pre-update bootstrap refresh found `CDKToolkit` in `CREATE_COMPLETE`. The
  regenerated local proposal modifies four role resources and adds four managed policies, with
  other resource definitions unchanged and only the variant default changed outside Resources.
  No change set was created or executed by the assistant. The user then reported executing the
  update. Read-only inspection confirmed `UPDATE_COMPLETE` and variant `InfraLensTestScopedV1`.
- Test application roles now require `arn:aws:iam::230944684535:policy/InfraLensTestApplicationBoundary`.
  The boundary is imported, not created by the application. The applied bootstrap update created
  it and three execution managed policies, replaces grants on four existing roles, and restricts
  deployment/file/lookup trust to the new test SSO role. It preserves bootstrap resource names,
  storage, ECR/image publishing and version 32. Variant `InfraLensTestScopedV1` protects future setup
  from an ordinary default bootstrap overwrite. No production boundary or bootstrap change is made.
- The readiness audit found a preparer bug: `FilePublishingRoleDefaultPolicy` is a separate
  `AWS::IAM::Policy` resource, so adding `FilePublishingRole.Properties.Policies` left its old
  grant active. The role then still had `s3:DeleteObject*` on bootstrap assets and the original
  placeholder KMS statement. The new scoped inline policy, all four managed policy documents,
  execution-role attachments and routine-role trusts match the prepared configuration; this
  leftover policy is the discrepancy among the four inspected roles. No IAM changes were made.
- Fixed initial preparation to replace the separately owned publishing-policy document. Added
  `--repair-file-publishing-policy` for the already applied V1 template: it changes only
  `FilePublishingRoleDefaultPolicy` and removes the duplicate inline policy from `FilePublishingRole`.
  All resource IDs/names, trust, other policies, parameters and storage are preserved. The generated
  ignored `infra/cdk/cdk.out/test-bootstrap-file-publishing-fix.template.json` and compact copy were
  checked against the current applied snapshot and passed CloudFormation syntax validation.
  The user subsequently reported applying the repair. Read-only inspection confirmed `UPDATE_COMPLETE`,
  no managed policies on the publisher, and exactly its default-named inline policy, whose document
  matches `test-file-publishing-role.policy.json`. Its old deletion/KMS grants and duplicate inline
  policy are gone. No change set or IAM mutation was performed by the assistant.
- The publishing-policy correction and test CloudTrail setup are verified. Budget coverage remains
  unverified before the first application deployment. Deploy-role mutations target only
  `InfraLensTestStack`; teardown and bootstrap administration remain separate. Execution policies
  enforce and protect the application boundary, including restrictions on role passing.
- The user's first application deployment failed after synthesis: CloudFormation's execution role
  lacked `ssm:GetParameters` on the exact test `/cdk-bootstrap/hnb659fds/version` parameter. This was
  an omission in the prepared policy; deployment/lookup role permissions do not transfer to the
  execution role. Read-only inspection then returned no `InfraLensTestStack` or its change set.
  No application deletion is needed in that observed state; bootstrap assets may have been uploaded.
  `test-execution-storage-compute.policy.json` now adds only that parameter read. The offline
  `--repair-bootstrap-version-read` mode validates the known scoped bootstrap and prepares a change
  solely to `InfraLensTestExecutionStorageCompute`, refusing unexpected existing policy differences.
  Ignored `cdk.out/test-bootstrap-before-ssm-fix.snapshot.json` and
  `cdk.out/test-bootstrap-ssm-read-fix.template.json` (plus compact copy) hold the current snapshot
  and proposal. The next read-only bootstrap snapshot confirms this version-read correction is now
  applied in an `UPDATE_COMPLETE` template; no assistant AWS writes or commits occurred.
- The following application attempt failed creating `AnalysisApi6763914B`: the API ownership-tag
  deny blocked `apigateway:PUT` even when writing the correct required values. The edge/auth policy
  now denies ownership-tag removal and incorrect requested values while allowing initial/idempotent
  correct writes. A new offline `--repair-api-ownership-tags` mode changes only three deny statements
  in `InfraLensTestExecutionEdgeAuth`, retaining the applied SSM and publishing fixes. Its ignored
  snapshot and proposed template use `cdk.out/test-bootstrap-before-api-tags-fix.snapshot.json` and
  `cdk.out/test-bootstrap-api-tags-fix.template.json` (plus compact copy). This correction is not applied.
- The application is now `ROLLBACK_COMPLETE`; the API was the only direct failure, with other
  creates cancelled. Eight resources have `DELETE_SKIPPED` and `DeletionPolicy: Retain`: two buckets,
  two tables, two log groups, Cognito pool and API logging role. Exact IDs are recorded in the
  permissions guide and ignored `test-failed-deployment-resources.json` / `test-failed-deployment-template.json`.
  Contents have not been inspected and are not presumed empty. Recovery needs a separate explicit
  decision; no deletion, bucket emptying, resource import or recreation was performed.
- Inspection of the installed CDK CLI found automatic deletion/recreation of failed-creation stacks.
  The deployment wrapper now checks selected application identity/status before synthesis/CDK;
  failed/active states are blocked, including when using administrator credentials. Only the specific
  missing-stack ValidationError permits initial creation; other AWS errors fail closed. The ordinary
  preflight/diff remains read-only and is not proof that application recovery is complete.
- Scope limits are documented: global CloudFront operations, OAC ID wildcards in the test account,
  regional API Gateway account logging, generated API execution log names, and CloudFront tagging
  of distributions with neither ownership tag. Optional SNS/budget/custom-domain/VPC resources,
  direct frontend publishing and Cognito user invitations need separate reviewed grants.
  API Gateway tag endpoints support request tags/tag keys, not resource-tag conditions; permitting
  correct ownership writes also permits applying those values to other REST APIs in the test region.
  This limitation is documented rather than claiming strict within-account application isolation.
- The bootstrap command supplied for manual execution must include `--context target=test` when
  run in the CDK workspace: the installed CLI evaluates the configured app even with an explicit
  account/region. The corrected guarded command is in the deployment guide. It has not been run
  by the assistant; standard bootstrap uses an administrator CloudFormation execution role.
- Test Cognito prefix `infralens-test-230944684535-euc1` returned an empty `DomainDescription` on
  October 4: unclaimed at that check, not reserved. The production proposal
  `infralens-prod-609124256824-euc1` remains unchecked.
- Production `eu-central-1` is still a proposal. Do not treat synthesis as region confirmation.
- The initial readiness audit returned no trails. The user subsequently created
  `infralens-test-audit`. October 4 read-only inspection confirmed account `230944684535`, home region
  `eu-central-1`, multi-region/global-event coverage, log validation, and both read/write management
  events without exclusions. Logging is active; latest successful delivery was `2026-10-04T16:51:49Z`,
  with no delivery error reported. Its bucket `infralens-test-audit-230944684535-euc1` has all four
  public-access blocks enabled, a nonpublic policy and default SSE-S3 encryption. This is an account
  trail, not an organization trail; no Insights or CloudWatch Logs/SNS integration is configured.
  The assistant made no AWS changes. A $1 management-account budget exists; its scope/coverage has
  not been verified. No member-account spending protection is inferred.

## Verification in this task

- API tagging/recovery correction: CDK build/typechecks and 52 credential-free tests passed, including
  both target synthesis assertions and blocked failed-stack recovery tests. AWS's IAM simulator
  reproduced the old tagging `explicitDeny` and the corrected `allowed` decision with an encoded ARN
  and string-list `aws:TagKeys`. The actual snapshot comparison changes only three deny statements
  in one managed policy; CloudFormation syntax validation passed. No AWS changes or commit occurred.
  Correct PUT writes and incorrect ownership values were simulated successfully. DELETE tagging
  returned `implicitDeny` with no matching statements even under unconditional wildcard Allow and
  Deny controls; three cases are marked unverified rather than falsely counted as passes. The script
  now supports string-list context and reports passes/skips separately. Removal protection remains
  structurally tested and unchanged; its live enforcement is unverified.
  Final read-only run: eight policies validated without findings, 38 simulations passed, and three
  DELETE tagging cases explicitly reported as unverified. No deployment or live application test ran.
- Bootstrap version-read correction: CDK typechecks/build and all 47 credential-free tests passed,
  including both target synthesis assertions. AWS Access Analyzer returned no findings for all eight
  policies; all 33 supported IAM simulations passed, including the allowed exact parameter read and
  denied production/unrelated reads and version writes. The actual snapshot-to-proposal comparison
  changed only one managed policy document; CloudFormation `ValidateTemplate` passed. These are
  read-only checks of a proposed correction, not evidence that it is applied or deployment succeeds.
- After CloudTrail creation, the guarded preflight and template-only diff passed again using
  `infralens-test-deploy`; `InfraLensTestStack` remains an initial create. Actual provisioning and
  rollback permissions still require the first deployment to exercise them. No deploy was run.
- October 4 readiness/correction: the guarded preflight and template-only diff passed using
  `infralens-test-deploy`, with the application still an initial create. Lambda account quota is
  10 total/unreserved concurrent executions, with zero existing functions in `eu-central-1`;
  the template leaves reserved concurrency unset. The IAM audit found the publishing omission above.
  The local correction passed CDK build/typechecks and all 42 tests, including both target synthesis
  assertions and new regression coverage for separate inline-policy resources and the narrow repair.
  Its two-resource diff and CloudFormation syntax validation passed. No deployment, hosted/browser
  test, live storage operation or AWS mutation was performed. Code/docs corrections are uncommitted.
- Policy follow-up: 38 CDK tests and CDK typechecks/build passed; both offline syntheses include
  the expected environment-specific boundary configuration. Read-only Access Analyzer validation
  returned zero findings for all eight documents; 29 supported IAM simulations passed. A local
  proposal generated from the actual bootstrap snapshot changes only four existing role resources
  and adds four policies (plus the variant default); CloudFormation `ValidateTemplate` passed.
  No change set was created and no bootstrap, IAM or application change was executed.
- API Gateway simulation returned `implicitDeny` even with diagnostic wildcard grants. Its two
  simulation cases were excluded, not treated as passes or used to broaden the policy. Documented
  tag conditions and structural tests remain; real API Gateway authorization and provider tagging
  behavior need verification in the first approved deployment. Simulations do not prove live trust,
  deployed effective permissions or full create/update/rollback compatibility.
- Node.js 22 follow-up: API 137 tests and CDK 27 tests passed on local Node.js 22.13.1, along with
  all workspace typechecks/builds and both offline syntheses. Both synthesized application Lambdas
  use `nodejs22.x`. The existing Vite >500 kB warning remains. GitHub workflows were updated but
  not run remotely; no hosted smoke, browser E2E, live AWS storage or deployment was performed.
- Environment separation is committed locally as `f5f7da3`; Node.js 22, the initial permission
  package and setup-status updates were committed as `360498d` at the user's request on the same
  branch. The user has now requested a checkpoint commit of the newer policy corrections,
  safeguards, tests and readiness/CloudTrail documentation. No push was requested or performed.
- Workspace typecheck and full build passed. Vite retains the existing >500 kB chunk warning.
- Workspace suites passed: 485 tests total (API 137, CLI 17, analyzer 284, shared 20, CDK 27).
  The API suite was rerun after the final frontend build-mode guards; the targeted deployment
  workflow tests were rerun after the assembly verifier correction.
  Integration cases are included by the normal test command. New coverage checks explicit targets,
  mocked STS mismatches/failures, region/stack/assembly safeguards, bootstrap gating, separate outputs,
  hosted authentication/origins/URLs, session isolation and credential-free local memory history.
- Offline synthesis passed for both `test` and `production`. CDK's sandboxed esbuild initially could
  not read the repository; tests/synth passed with filesystem access outside that sandbox.
- Real synthesis revealed that CDK omits `stackName` when it equals the assembly artifact ID. The
  verifier handles that default, still rejects an explicit wrong name, and has regression coverage.
- Default local, test-local, test-hosted and production-hosted frontend builds passed using offline
  public-configuration fixtures. Temporary fixture builds were removed. AWS build modes fail if
  generated configuration is absent or belongs to the wrong target/local-versus-hosted variant.
- Local success does not establish live deployment, IAM effectiveness, prefix availability or actual
  browser authentication. Hosted/manual checks remain outstanding.

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test
npm.cmd run synth --workspace @infralens/cdk -- --target test
npm.cmd run synth --workspace @infralens/cdk -- --target production
```

Local memory setup and additional integration command: [Saved projects](docs/SAVED_PROJECTS.md).
Deployment safeguards and testing boundaries: [Testing](docs/TESTING.md).

## Known limitations and next actions

- REST API Gateway-generated auth errors use the deployed frontend's static CORS origin. Valid local
  test requests and Lambda errors have exact localhost CORS, but rejected Gateway tokens can appear
  as generic CORS/network errors from localhost. Sign in again; verify this later with hosted checks.
- The legacy opt-in `test:aws` suite still accepts manual resource names and ambient SDK credentials.
  Before enabling it, connect it to validated test outputs and account/region checks. Its old
  `INFRALENS_DISPOSABLE_AWS` flag is about disposable data, not per-run stack deployment/destruction.
  It needs scoped test cleanup permissions separately; do not broaden the application Lambda role.
- Work is stopped at the user's request after the later API Gateway logging-role failure described
  at the top. When the user resumes, inspect current state before following this earlier plan:
  review/apply the one-policy API tagging correction using the test administrator session and
  wait for `CDKToolkit` `UPDATE_COMPLETE`. Then explicitly decide recovery for the failed application
  stack record and its retained resources before retrying with `infralens-test-deploy`. No automatic
  cleanup or deletion is authorized. The prior publishing/version-read corrections are applied;
  CloudTrail logging/delivery passed read-only checks.
  Verify the still-unconfirmed budget scope/member-account cost alerts. After deployment,
  invite users, generate/upload the test frontend, and verify both frontend options and ownership.
- Production region/prefix/bootstrap preparation is a separate later decision, not a prerequisite
  for the first test deployment. The current test bootstrap roles are scoped to InfraLens; another
  application in this account would need deliberately configured deployment roles/permissions.
- Production `CDKToolkit` remains outside application lifecycle operations. No application migration
  is planned because no production application stack exists.

## Project/code map and continuing product work

| Area | Location |
| --- | --- |
| Parsing, rules, graph, IAM/source inference, fixes and diff | `packages/analyzer/src` |
| Shared report/API and history contracts | `packages/shared/src` |
| Express/Lambda API, history service and storage adapters | `apps/api/src` |
| React, saved reports and Cognito PKCE | `apps/web/src` |
| CLI | `apps/cli/src` |
| Target configuration, operational scripts and reusable stack | `infra/cdk/src` |

The priority remains portfolio value and learning AWS architecture; avoid broad analyzer expansion.
[Roadmap](docs/ROADMAP.md) describes later asynchronous analysis/reliable dispatch/operations work.
Saved history code is merged; hosted verification is still required before declaring it complete.

Preserve evidence limits: IAM evaluation is partial, uncertain/shared replacements require review,
source inference is static in-memory syntax/import analysis, and ValidateTemplate does not prove
successful deployment. See [Analyzer coverage](docs/ANALYZER_COVERAGE.md),
[Template validation](docs/TEMPLATE_VALIDATION.md), and [Source uploads](docs/SOURCE_UPLOADS.md).
