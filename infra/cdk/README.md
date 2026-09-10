# InfraLens CDK

AWS CDK stack for the InfraLens frontend and analysis API.

## Resources

- Private S3 frontend bucket and CloudFront distribution with SPA fallback
- Node.js Lambda for `/analyze`, `/diff`, and `/apply`
- REST API Gateway with an unauthenticated `/health` endpoint
- Production Cognito User Pool, hosted sign-in domain, app client, and API authorizer
- Explicit API and Lambda log groups, throttling, reserved concurrency, and CloudWatch alarms
- Optional SNS email notifications and AWS monthly budget

Development is the default CDK mode and supports the local Vite origin. A public deployment must use
the production mode, which protects every analysis route with Cognito and disables self-sign-up.

See [Protected Production Deployment](../../docs/PRODUCTION_DEPLOYMENT.md) for configuration,
deployment outputs, inviting the first user, frontend auth settings, request limits, monitoring, and
the production checklist.

## Template validation

The Lambda enables INFRALENS_CLOUDFORMATION_VALIDATION=true and can call only
cloudformation:ValidateTemplate in addition to its scoped log writes. Resource `*` is required for
this validation action, which has no resource-level scope; no stack deployment permission is granted.
See [Template validation](../../docs/TEMPLATE_VALIDATION.md) for offline mode and validation limits.

## Verify

From the repository root:

```sh
npm install
npm run build --workspace @infralens/cdk
npm run test --workspace @infralens/cdk
npm run synth --workspace @infralens/cdk
```

Production synthesis requires a unique Cognito domain prefix. Do not include the reserved terms
`aws`, `amazon`, or `cognito` in it:

```sh
npm run synth --workspace @infralens/cdk -- \
  -c environment=production \
  -c cognitoDomainPrefix=infralens-your-project
```

Synthesis does not deploy resources.
