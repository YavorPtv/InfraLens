# InfraLens Handoff

Last refreshed: October 4, 2026.

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
  deployment login exists, but scoped bootstrap permissions are still pending. No custom
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
- Both the SSO administrator role and `cdk-hnb659fds-cfn-exec-role-230944684535-eu-central-1` have
  `AdministratorAccess` and no permissions boundary. The deployment role has CloudFormation write
  permissions on `*`, including stack deletion, and can pass that execution role. Its additional
  cross-account artifact grants are part of the default bootstrap policy. The lookup role has
  `ReadOnlyAccess` with an explicit KMS decrypt deny. The publishing roles target their bootstrap
  S3/ECR resources. Bootstrap role trusts name the test account, with no external account trust
  observed; account trust does not mean only the root user can assume them.
- The [test permission package](docs/TEST_DEPLOYMENT_PERMISSIONS.md) is now prepared: eight JSON
  policies in `infra/cdk`, the offline `prepare-test-permissions` command, and the optional read-only
  `verify-test-policies.ps1` script. The bootstrap changes have not been applied. The routine
  profile is `infralens-test-deploy`, using permission set `InfraLensTestDeploy`; existing admin
  profiles remain administrators. The target default is retained; pass the new profile explicitly.
- On October 4, the user reported creating and assigning `InfraLensTestDeploy`, then supplied STS
  output for account `230944684535` and role `AWSReservedSSO_InfraLensTestDeploy_b55078ad9d9725df`.
  Read-only IAM inspection confirmed its expected Identity Center path, no attached managed
  policies or boundary, and an inline policy exactly matching `test-deployer.policy.json`.
  User/group assignments were reported by the user, not independently inspected. The login can
  still assume the existing broad bootstrap roles until the proposed bootstrap update is applied.
- The October 4 read-only bootstrap refresh still found `CDKToolkit` in `CREATE_COMPLETE`. The
  regenerated local proposal modifies four role resources and adds four managed policies, with
  other resource definitions unchanged and only the variant default changed outside Resources.
  No change set was created or executed. The next setup step is creating and reviewing a test
  bootstrap change set; execution and the first application deployment remain separate actions.
- Test application roles now require `arn:aws:iam::230944684535:policy/InfraLensTestApplicationBoundary`.
  The boundary is imported, not created by the application. The proposed bootstrap update creates
  it and three execution managed policies, replaces grants on four existing roles, and restricts
  deployment/file/lookup trust to the new test SSO role. It preserves bootstrap resource names,
  storage, ECR/image publishing and version 32. Variant `InfraLensTestScopedV1` protects future setup
  from an ordinary default bootstrap overwrite. No production boundary or bootstrap change is made.
- Hold the first application deployment until the policy package is reviewed and a separate
  IAM/bootstrap setup is authorized, applied and verified. Deploy-role mutations target only
  `InfraLensTestStack`; teardown and bootstrap administration remain separate. Execution policies
  enforce and protect the application boundary, including restrictions on role passing.
- Scope limits are documented: global CloudFront operations, OAC ID wildcards in the test account,
  regional API Gateway account logging, generated API execution log names, and CloudFront tagging
  of distributions with neither ownership tag. Optional SNS/budget/custom-domain/VPC resources,
  direct frontend publishing and Cognito user invitations need separate reviewed grants.
- The bootstrap command supplied for manual execution must include `--context target=test` when
  run in the CDK workspace: the installed CLI evaluates the configured app even with an explicit
  account/region. The corrected guarded command is in the deployment guide. It has not been run
  by the assistant; standard bootstrap uses an administrator CloudFormation execution role.
- Test Cognito prefix proposal: `infralens-test-230944684535-euc1`. Separate production proposal:
  `infralens-prod-609124256824-euc1`. Availability has not been checked.
- Production `eu-central-1` is still a proposal. Do not treat synthesis as region confirmation.
- CloudTrail has not been configured. A $1 management-account budget exists; its scope/coverage
  has not been verified. No member-account spending protection is inferred from that budget.

## Verification in this task

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
- Environment separation is committed locally as `f5f7da3`; the user requested a follow-up commit
  on the same branch for the Node.js 22, test permission-package and setup-status updates.
  Before that commit, the CDK build/typechecks and all 38 CDK tests passed again. No push was performed.
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
- Next: review/apply/verify the test permission package in a separately authorized setup; confirm the
  production region; verify Cognito prefix availability; configure CloudTrail; verify budget scope
  and member-account cost alerts. Then preflight/diff and authorize the first persistent test deploy,
  invite users, generate/upload the test frontend, and verify both frontend options and ownership.
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
