# InfraLens

InfraLens is a developer-focused AWS architecture analyzer. It parses CloudFormation templates, builds a resource and relationship graph, detects security and reliability risks, and produces evidence-based least-privilege IAM suggestions.

The project is intentionally template-first today. It does not call AWS APIs or inspect deployed accounts.

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
- `examples`: demo CloudFormation templates
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

## Current Rules

- `IAM_WILDCARD_PERMISSIONS`: detects broad IAM permissions such as wildcard actions/resources
- `API_GATEWAY_METHOD_NO_AUTH`: detects REST API methods with missing or `NONE` authorization
- `S3_PUBLIC_ACCESS_BLOCK_MISSING`: detects S3 buckets without all public access block settings enabled
- `SQS_MISSING_DLQ`: detects SQS queues without a dead-letter queue
- `DYNAMODB_MISSING_PITR`: detects DynamoDB tables without point-in-time recovery
- `LOG_GROUP_MISSING_RETENTION`: detects CloudWatch log groups without retention

Contextual severity currently adjusts `IAM_WILDCARD_PERMISSIONS` to critical when the affected role is publicly reachable or used by a publicly reachable Lambda.

## Least-Privilege Suggestions

InfraLens can generate template-only suggestions for narrowing IAM policy statements that allow supported service actions on `Resource: "*"`.

Currently supported target services:

- DynamoDB tables
- SQS queues
- SNS topics

The analyzer infers resources from Lambda references in the template. It does not inspect Lambda source code.

## Current Limitations

- CloudFormation JSON and YAML templates are supported. CDK source parsing is not implemented yet; analyze synthesized CloudFormation output instead.
- The analyzer is template-only and does not call AWS APIs.
- Lambda source code analysis is not implemented.
- The web app does not include authentication yet.
- Least-privilege suggestions are conservative and only cover a small set of services.
- Graph layout is optimized for readability, but infrastructure diagrams cannot be made perfect for every possible template.
