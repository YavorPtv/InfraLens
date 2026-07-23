# InfraLens CDK

Initial AWS CDK skeleton for hosting InfraLens.

## Resources

- S3 bucket for frontend build artifacts
- CloudFront distribution in front of the frontend bucket
- Lambda function bundled from the API analyze handler
- API Gateway REST API with `POST /analyze`
- API Gateway REST API with `GET /health`

CloudFront is configured with an SPA fallback so routes such as `/analyze` and `/report` return `index.html` on browser refresh.

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

After deployment, get these stack outputs:

- `FrontendBucketName`
- `FrontendDistributionDomainName`
- `FrontendDistributionId`
- `AnalysisApiBaseUrl`

Build the React app with the deployed API Gateway base URL:

```sh
VITE_INFRALENS_API_BASE_URL=https://example.execute-api.eu-central-1.amazonaws.com/prod npm run build --workspace @infralens/web
```

On Windows PowerShell:

```powershell
$env:VITE_INFRALENS_API_BASE_URL = "https://example.execute-api.eu-central-1.amazonaws.com/prod"
npm.cmd run build --workspace @infralens/web
Remove-Item Env:VITE_INFRALENS_API_BASE_URL
```

Upload the static files to the frontend bucket:

```sh
aws s3 sync apps/web/dist s3://YOUR_FRONTEND_BUCKET_NAME --delete
```

Then invalidate CloudFront so the distribution serves the newest build:

```sh
aws cloudfront create-invalidation --distribution-id YOUR_DISTRIBUTION_ID --paths "/*"
```

CloudFront will serve the uploaded files from `FrontendDistributionDomainName`.

## Notes

- No authentication is configured yet.
- No DynamoDB table is created yet.
- No secrets are hardcoded in the stack.
- The frontend bucket is private and read through CloudFront.
- The API currently allows CORS from all origins for local/demo integration; tighten this once a production frontend domain is known.
