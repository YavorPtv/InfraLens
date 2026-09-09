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

Run the complete local workflow integration suite (builds shared/analyzer dependencies first):

```sh
npm run test:integration
```

Integration tests also run under `npm test`. Deployed HTTP smoke tests are separate and opt-in.
See [Workflow testing](docs/TESTING.md) for coverage, fixture locations, remaining manual checks,
and smoke configuration. Smoke tests validate an existing deployment; CI does not deploy InfraLens.

Run typecheck across all workspaces:

```sh
npm run typecheck
```

Run a full build:

```sh
npm run build
```

## CI

GitHub Actions runs the same core workspace checks on pushes and pull requests:

```sh
npm ci
npm run typecheck
npm run test
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

Compare two templates and print a readable `DiffReport` summary:

```sh
npm run diff -- examples/simple-good-template.json examples/simple-bad-template.json
```

The same diff command also supports JSON and Markdown output:

```sh
npm run diff -- --json examples/simple-good-template.json examples/simple-bad-template.json
npm run analyze -- --diff --markdown examples/simple-good-template.json examples/simple-bad-template.json
```

Windows PowerShell equivalent:

```powershell
npm.cmd run analyze -- examples\order-service-risky-template.json
npm.cmd run analyze -- --json examples\order-service-risky-template.json
npm.cmd run diff -- examples\simple-good-template.json examples\simple-bad-template.json
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
- `POST /diff`
- `POST /apply`

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

`POST /diff` accepts old and new template strings and returns a `DiffReport`:

```json
{
  "oldTemplate": "{ \"Resources\": {} }",
  "newTemplate": "{ \"Resources\": {} }"
}
```

`POST /apply` accepts an original template string and explicitly selected structured fixes from an
`AnalysisReport`. It returns a new modified template plus a result for each fix. The original
template is never modified:

```json
{
  "template": "{ \"Resources\": {} }",
  "fixes": []
}
```

Fixes that no longer match their expected target, conflict with another selected fix, or require
manual review are returned as failures instead of being applied to a different location.

For a compare workflow demo, use `examples/compare/old-order-service-template.json` and `examples/compare/new-order-service-template.json`. The fixture README documents the expected added, removed, changed, introduced, and resolved results.

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
- `.tsx`
- `.js`
- `.jsx`
- `.mjs`
- `.cjs`

Use **Upload Source Folder** to preserve the directory hierarchy, including the selected folder's
name. Source files and Lambda mappings use normalized relative paths, so duplicate basenames in
different directories stay distinct. Re-uploading the same path replaces its content, keeps its
mapping, and marks it **Replaced**. Removing a file removes its associated mapping. Ordinary file
upload remains available, but the browser may expose only a basename for those files.

See [Source project uploads](docs/SOURCE_UPLOADS.md) for folder filtering, API compatibility, safe
path normalization, and nested/shared import behavior.

For a quick demo, upload:

- `examples/order-service-risky-template.json` as the template
- `examples/order-handler-source.ts` as the Lambda source file

The source file contains mocked DynamoDB `GetCommand` and `PutCommand` usages, so InfraLens displays the inferred actions and related table for review. Because the self-contained demo has no real `@aws-sdk/lib-dynamodb` import, it does not automatically apply action narrowing. Uploaded application source with the matching SDK import provides exact package evidence.

After analysis, the Apply Suggestions section lists deterministic fixes separately from suggestions
that require manual review. Select the fixes to apply, then review, copy, or download the generated
CloudFormation JSON. **Compare with original** opens the existing template diff workflow with both
templates preloaded.

On the Compare Templates page, paste:

- `examples/compare/old-order-service-template.json` into the old template field
- `examples/compare/new-order-service-template.json` into the new template field

The expected results are documented in `examples/compare/README.md`.

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
- `LAMBDA_DEAD_LETTER_CONFIG_MISSING`: detects `AWS::Lambda::EventInvokeConfig` resources without an on-failure destination; it does not flag every Lambda
- `LAMBDA_RESERVED_CONCURRENCY_RISK`: detects the deterministic case where reserved concurrency is zero and all invocations are throttled
- `S3_VERSIONING_DISABLED`: detects buckets without enabled versioning as a recovery/resilience risk
- `SNS_TOPIC_ENCRYPTION_MISSING`: detects topics without explicit KMS encryption
- `API_GATEWAY_ACCESS_LOGGING_MISSING`: detects REST API stages without a complete access log destination and format
- `API_GATEWAY_TRACING_DISABLED`: detects REST API stages without active X-Ray tracing
- `LAMBDA_TRACING_DISABLED`: detects Lambda functions without active X-Ray tracing
- `DYNAMODB_DELETION_PROTECTION_DISABLED`: detects tables without deletion protection
- `IAM_PASSROLE_WILDCARD`: detects `iam:PassRole` grants on `Resource: "*"`
- `IAM_PRIVILEGE_ESCALATION_ACTIONS`: detects a small explicit set of permission-changing IAM actions on wildcard resources

Generic S3 encryption, SQS encryption, and DynamoDB encryption-missing rules are intentionally not included. S3 encrypts all new objects with SSE-S3 by default, SQS enables SSE-SQS when `SqsManagedSseEnabled` is omitted, and DynamoDB uses an AWS owned key when KMS settings are omitted. Flagging those omissions as unencrypted would be misleading. Lambda failure handling is checked only when an `AWS::Lambda::EventInvokeConfig` proves asynchronous invocation configuration; InfraLens does not guess invocation behavior from a function alone.

Contextual severity currently adjusts `IAM_WILDCARD_PERMISSIONS` to critical when the affected role is publicly reachable or used by a publicly reachable Lambda.

## Least-Privilege Suggestions

InfraLens can generate suggestions for narrowing IAM policy statements that allow supported service actions on `Resource: "*"`.

Currently supported target services and source-inferred actions:

| Service | CloudFormation resource | Supported inferred actions |
| --- | --- | --- |
| DynamoDB | `AWS::DynamoDB::Table` | `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`, `Scan` |
| S3 | `AWS::S3::Bucket` | `GetObject`, `PutObject`, `DeleteObject`, `ListBucket` |
| SQS | `AWS::SQS::Queue` | `SendMessage`, `ReceiveMessage`, `DeleteMessage` |
| SNS | `AWS::SNS::Topic` | `Publish` |
| Lambda | `AWS::Lambda::Function` | `InvokeFunction` |
| EventBridge | `AWS::Events::EventBus` | `PutEvents` |
| Secrets Manager | `AWS::SecretsManager::Secret` | `GetSecretValue` |
| SSM Parameter Store | `AWS::SSM::Parameter` | `GetParameter`, `GetParameters`, `PutParameter` |
| KMS | `AWS::KMS::Key` | `Encrypt`, `Decrypt`, `GenerateDataKey` (manual review only) |

Least-privilege suggestions are conservative and do not attempt to infer permissions when InfraLens lacks sufficient evidence.

Action/resource compatibility is checked before a resource is suggested. S3 object actions use an object ARN ending in `/*`, while `ListBucket` uses the bucket ARN. DynamoDB `Query` and `Scan` include table and index ARN forms. Actions known to require `Resource: "*"`, unknown actions, ambiguous resources, and multi-service statements remain manual-only. KMS suggestions remain manual-only because identity policies must be reviewed with key policies and encryption context.

The analyzer infers resources from Lambda references in the template. If optional Lambda source files are provided, it can also infer exact IAM actions from supported AWS SDK v3 command names. Source files can be mapped explicitly or matched to Lambda handlers, and actions from resolved local imports can contribute to every Lambda that reaches the shared file.

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
- `ListObjectsV2Command` -> `s3:ListBucket`
- `ReceiveMessageCommand` -> `sqs:ReceiveMessage`
- `DeleteMessageCommand` -> `sqs:DeleteMessage`
- `InvokeCommand` from `@aws-sdk/client-lambda` -> `lambda:InvokeFunction`
- `PutEventsCommand` -> `events:PutEvents`
- `GetSecretValueCommand` -> `secretsmanager:GetSecretValue`
- `GetParameterCommand` -> `ssm:GetParameter`
- `GetParametersCommand` -> `ssm:GetParameters`
- `PutParameterCommand` -> `ssm:PutParameter`
- `EncryptCommand` -> `kms:Encrypt`
- `DecryptCommand` -> `kms:Decrypt`
- `GenerateDataKeyCommand` -> `kms:GenerateDataKey`

Source-code inference does not parse a full AST or analyze `node_modules`. Relative imports between uploaded JavaScript and TypeScript files are resolved conservatively; unresolved or ambiguous imports are ignored. Exact SDK command evidence requires the expected `@aws-sdk` package import; command-name-only matches remain low-confidence evidence and cannot drive automatic action narrowing.

## Apply Suggestions

Analysis reports include structured fixes rather than deriving template changes from free-form
remediation text. The current deterministic fix set includes:

- Enabling all S3 public access block settings
- Enabling DynamoDB point-in-time recovery
- Enabling DynamoDB deletion protection
- Enabling S3 versioning
- Enabling active tracing for Lambda functions and API Gateway stages
- Narrowing an IAM statement from `Resource: "*"` when exactly one referenced resource is known
- Narrowing IAM actions when high-confidence source evidence provides exact actions

CloudWatch Logs retention remains manual-review because InfraLens does not currently have a single
concrete retention value that is safe for every workload. KMS key selection, API Gateway access-log
destinations, Lambda failure destinations, and reserved-concurrency values also require workload-
specific choices. Mixed-service IAM statements, ambiguous resource candidates, stale paths, and
low-confidence replacements are left unchanged. In Apply Suggestions, a service-specific least-
privilege fix replaces the generic IAM wildcard remediation for the same policy statement.

Applying fixes creates a new CloudFormation JSON template. Logical IDs, unrelated properties, and
intrinsic functions such as `Ref`, `Fn::GetAtt`, and `Fn::Sub` are preserved. InfraLens does not
write to the uploaded file or deploy the generated template.

## Current Limitations

- Rule and least-privilege coverage is limited to the resources, services, and AWS SDK commands
  documented above. InfraLens is not yet a comprehensive AWS security assessment.
- Source inference uses lightweight command and import matching. Folder uploads preserve relative
  paths; ordinary file selection may expose only basenames. Missing files, ambiguous paths, package
  imports and TypeScript path aliases can still prevent shared-source attribution. Explicit Lambda
  mapping does not restore missing directory information.
- High-confidence IAM suggestions are based only on the submitted template and uploaded files. They
  cannot guarantee that every runtime permission or production source file was included.
- Template parsing is not full CloudFormation schema validation. Analyze and generated templates
  should still be validated before deployment.
- Compare currently compares templates only; it does not compare separate old and new source trees.
- Reports are not persisted; refreshing or leaving the current browser session loses analysis
  history.

## Hosted Deployment Security

InfraLens initially uses invited access rather than anonymous public API access. The production CDK
configuration uses Cognito hosted sign-in and API Gateway authorization for all analysis routes,
restricts CORS to the frontend origin, validates request sizes, throttles requests, caps Lambda
concurrency when configured, and configures structured logs and operational alarms.

See [Protected Production Deployment](docs/PRODUCTION_DEPLOYMENT.md) for required configuration,
first-user invitation, current limits, monitoring, cost alerts, and the pre-deployment checklist.

See [Production Roadmap](docs/ROADMAP.md) for the recommended next development priorities.
