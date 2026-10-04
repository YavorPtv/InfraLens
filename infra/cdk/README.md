# InfraLens CDK

The existing application stack is reused for explicit `test` and `production` deployment targets.
No target is selected by default or from AWS credentials/application runtime mode.

Both targets own their Lambda/REST API, DynamoDB tables, artifact and frontend buckets, CloudFront,
Cognito pool/client/domain, logs and alarms. All analysis/history routes require Cognito. Test permits
its CloudFront origin and `http://localhost:5173`; production permits its CloudFront origin only.
Local React/Express requires no CDK deployment and retains explicit memory/fake-identity behavior.

From the repository root, credential-free checks:

```powershell
npm.cmd run typecheck --workspace @infralens/cdk
npm.cmd run test --workspace @infralens/cdk
npm.cmd run synth --workspace @infralens/cdk -- --target test
npm.cmd run synth --workspace @infralens/cdk -- --target production
```

Assemblies are separated under `cdk.out/test` and `cdk.out/production`. Deployment outputs are
ignored `cdk-outputs.test.json` and `cdk-outputs.production.json` files. There is no bootstrap or
destroy wrapper; both environments retain persistence resources intentionally.

Read [AWS test and production deployment](../../docs/PRODUCTION_DEPLOYMENT.md) for exact PowerShell
preflight/diff/deploy commands, account safeguards, existing administrator access, pending bootstrap
and region decisions, frontend generation, authentication, retention and the deployment checklist.
Deployment commands are implemented but were not executed by the environment-separation task.

The [test deployment permission package](../../docs/TEST_DEPLOYMENT_PERMISSIONS.md) contains eight
reviewable policy documents, an offline bootstrap-template preparer, and an optional read-only AWS
validation script. Test application roles require its administrator-owned permissions boundary.
The user applied the initial package. A read-only readiness audit found that its separate default
file-publishing policy remained; the guide now contains a two-resource correction and the preparer
supports `--repair-file-publishing-policy`. The user applied that correction; read-only inspection
confirmed the publisher has exactly the intended policy and no managed-policy attachments.
The first application attempt then failed because the CloudFormation execution role lacked
`ssm:GetParameters` on the test bootstrap version. The corrected policy and offline
`--repair-bootstrap-version-read` mode prepare a one-policy bootstrap change; see the guide for
review/application instructions. The applied bootstrap template now contains this version-read fix.
The following deployment failed because the API ownership-tag deny also blocked initial tagging.
The prepared `--repair-api-ownership-tags` correction allows the required values while preserving
wrong-value/removal denials. It is not applied. The application is `ROLLBACK_COMPLETE` with retained
resources; deploy now stops before CDK's automatic failed-stack deletion/recreation. Review the guide's
inventory and separate recovery decision before retrying; no cleanup is performed by the workflow.
No production policies or bootstrap changes are included.
