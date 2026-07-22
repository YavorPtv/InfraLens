# InfraLens CDK

Initial AWS CDK skeleton for hosting InfraLens.

## Resources

- S3 bucket for frontend build artifacts
- CloudFront distribution in front of the frontend bucket
- Lambda function placeholder for the analysis API
- API Gateway REST API with `POST /analyze`

The Lambda is intentionally a placeholder. Packaging the analyzer and API handler for Lambda should be implemented in a later step.

## Expected Deployment Flow

From the repository root:

```sh
npm install
npm run build --workspace @infralens/cdk
npm run synth --workspace @infralens/cdk
```

When the stack is ready to deploy:

```sh
npm run build --workspace @infralens/cdk
npm exec --workspace @infralens/cdk -- cdk deploy
```

After deployment, build the React app and upload its static files to the frontend bucket output by the stack. CloudFront will serve the uploaded files.

## Notes

- No authentication is configured yet.
- No DynamoDB table is created yet.
- No secrets are hardcoded in the stack.
- The frontend bucket is private and read through CloudFront.
- The API currently allows CORS from all origins for local/demo integration; tighten this once a production frontend domain is known.
