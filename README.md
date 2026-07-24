# InfraLens

InfraLens is a developer-focused AWS architecture analyzer. It parses CloudFormation templates, builds a resource and relationship graph, detects security and reliability risks, and produces evidence-based least-privilege IAM suggestions.

The project is intentionally local-first today. It does not call AWS APIs or inspect deployed accounts. Optional Lambda source-code upload is used only to infer IAM actions from recognizable AWS SDK command names.

## Tech Stack

- TypeScript
- npm workspaces
- Node.js and Express for the local API
- React, Vite, and React Router for the web app
- React Flow and Dagre for architecture graph rendering
- Mocha and Chai for tests
- AWS CDK with TypeScript for infrastructure skeletons

## Workspace Layout

- `packages/analyzer`: CloudFormation parsing, rules, graph analysis, reachability, and policy suggestions
- `packages/shared`: shared API/report/types used by the analyzer, CLI, API, and web app
- `apps/cli`: command-line analyzer
- `apps/api`: local Express API and Lambda-compatible analyze handler
- `apps/web`: React frontend
- `infra/cdk`: AWS CDK infrastructure skeleton
- `examples`: demo CloudFormation templates and source-code fixtures
- `docs`: architecture and demo documentation

## Install

```sh
npm install
```

On Windows PowerShell, use `npm.cmd` if `npm` script execution is not picked up correctly:

```powershell
npm.cmd install
```

## Run Tests

Run all workspace tests:

```sh
npm run test
```

Run typecheck across all workspaces:

```sh
npm run typecheck
```

Run a full build:

```sh
npm run build
```

## Run The CLI

Analyze a template with readable output:

```sh
npm run analyze -- examples/order-service-risky-template.json
```

Print the full `AnalysisReport` as JSON:

```sh
npm run analyze -- --json examples/order-service-risky-template.json
```

Windows PowerShell equivalent:

```powershell
npm.cmd run analyze -- examples\order-service-risky-template.json
npm.cmd run analyze -- --json examples\order-service-risky-template.json
```

## Run The API Locally

Build and start the local API:

```sh
npm run build --workspace @infralens/api
npm run start --workspace @infralens/api
```

The API listens on `http://localhost:3000` by default.

Endpoints:

- `GET /health`
- `POST /analyze`

`POST /analyze` accepts raw CloudFormation JSON or YAML in the request body and returns an `AnalysisReport`.

It also accepts an optional JSON envelope when Lambda source files should be analyzed with the template:

```json
{
  "template": "{ \"Resources\": {} }",
  "sourceFiles": {
    "handler.ts": "await client.send(new GetCommand({ TableName: tableName }));"
  }
}
```

Source files are not stored. They are scanned only for supported AWS SDK command names that map to IAM actions.

## Run The Web App Locally

Start the API in one terminal:

```sh
npm run build --workspace @infralens/api
npm run start --workspace @infralens/api
```

Start the web app in another terminal:

```sh
npm run dev --workspace @infralens/web
```

Open the Vite URL printed by the dev server, usually `http://localhost:5173`.

On the Analyze page, paste or upload a CloudFormation JSON/YAML template. You can also upload optional Lambda source files with these extensions:

- `.ts`
- `.js`
- `.mjs`
- `.cjs`

For a quick demo, upload:

- `examples/order-service-risky-template.json` as the template
- `examples/order-handler-source.ts` as the Lambda source file

The source file contains DynamoDB `GetCommand` and `PutCommand` usages, so the least-privilege suggestion can narrow `dynamodb:*` to `dynamodb:GetItem` and `dynamodb:PutItem`.

## Current Supported AWS Resources And Signals

InfraLens currently recognizes and analyzes CloudFormation resources including:

- `AWS::IAM::Role`
- `AWS::IAM::Policy`
- `AWS::Lambda::Function`
- `AWS::Lambda::Permission`
- `AWS::ApiGateway::RestApi`
- `AWS::ApiGateway::Method`
- `AWS::ApiGatewayV2::Api`
- `AWS::CloudFront::Distribution`
- `AWS::ElasticLoadBalancingV2::LoadBalancer`
- `AWS::DynamoDB::Table`
- `AWS::SQS::Queue`
- `AWS::SNS::Topic`
- `AWS::S3::Bucket`
- `AWS::Logs::LogGroup`

Graph and exposure analysis currently includes:

- Raw CloudFormation references from `Ref`, `Fn::GetAtt`, `Fn::Sub`, and `DependsOn`
- Lambda function uses IAM role: `uses-role`
- API Gateway method invokes Lambda: `invokes`
- SQS queue uses dead-letter queue: `dead-letter`
- Public entry point detection for API Gateway, API Gateway V2, CloudFront, and internet-facing ALBs
- Public reachability traversal over architecture edges 
- Source-code IAM action inference from simple AWS SDK v3 command-name matches

## Current Rules

- `IAM_WILDCARD_PERMISSIONS`: detects broad IAM permissions such as wildcard actions/resources
- `API_GATEWAY_METHOD_NO_AUTH`: detects REST API methods with missing or `NONE` authorization
- `S3_PUBLIC_ACCESS_BLOCK_MISSING`: detects S3 buckets without all public access block settings enabled
- `SQS_MISSING_DLQ`: detects SQS queues without a dead-letter queue
- `DYNAMODB_MISSING_PITR`: detects DynamoDB tables without point-in-time recovery
- `LOG_GROUP_MISSING_RETENTION`: detects CloudWatch log groups without retention

Contextual severity currently adjusts `IAM_WILDCARD_PERMISSIONS` to critical when the affected role is publicly reachable or used by a publicly reachable Lambda.

## Least-Privilege Suggestions

InfraLens can generate suggestions for narrowing IAM policy statements that allow supported service actions on `Resource: "*"`.

Currently supported target services:

- DynamoDB tables
- SQS queues
- SNS topics

The analyzer infers resources from Lambda references in the template. If optional Lambda source files are provided, it can also infer exact IAM actions from supported AWS SDK v3 command names.

Current source-code action inference is intentionally simple matching. Supported command mappings include:

- `GetCommand` -> `dynamodb:GetItem`
- `PutCommand` -> `dynamodb:PutItem`
- `UpdateCommand` -> `dynamodb:UpdateItem`
- `DeleteCommand` -> `dynamodb:DeleteItem`
- `QueryCommand` -> `dynamodb:Query`
- `ScanCommand` -> `dynamodb:Scan`
- `SendMessageCommand` -> `sqs:SendMessage`
- `PublishCommand` -> `sns:Publish`
- `GetObjectCommand` -> `s3:GetObject`
- `PutObjectCommand` -> `s3:PutObject`
- `DeleteObjectCommand` -> `s3:DeleteObject`

Source-code inference does not parse ASTs yet and does not prove which Lambda owns a file. It is best used by uploading the source file for the Lambda represented in the template.

## Current Limitations

- CloudFormation JSON and YAML templates are supported. CDK source parsing is not implemented yet; analyze synthesized CloudFormation output instead.
- The analyzer is template-only and does not call AWS APIs.
- Lambda source-code analysis is limited to simple AWS SDK v3 command-name matching.
- The web app does not include authentication yet.
- Least-privilege suggestions are conservative and only cover a small set of services.
- Uploaded source files are analyzed in request memory only; there is no source-code storage workflow.
- Graph layout is optimized for readability, but infrastructure diagrams cannot be made perfect for every possible template.
