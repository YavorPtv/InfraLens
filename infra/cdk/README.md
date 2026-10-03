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
