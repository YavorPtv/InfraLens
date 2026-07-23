# InfraLens Architecture

InfraLens is organized around a pure TypeScript analyzer core with multiple presentation and delivery surfaces around it.

## Analyzer Pipeline

The main analyzer entry point is `analyzeTemplate` in `packages/analyzer`.

At a high level it:

1. Parses the CloudFormation template into resource nodes.
2. Extracts raw CloudFormation references.
3. Builds typed runtime architecture edges.
4. Detects public entry points.
5. Computes public reachability over the architecture graph.
6. Generates least-privilege policy suggestions.
7. Creates an `AnalysisContext`.
8. Runs rules.
9. Applies contextual severity adjustments.
10. Builds the final `AnalysisReport`.

The `AnalysisReport` is the contract consumed by the CLI, API, and web app. Shared report types live in `packages/shared`.

## Parser

The parser accepts raw CloudFormation JSON or YAML and converts resources into `ResourceNode` objects:

- logical id
- resource type
- properties

The parser validates that:

- the input is valid JSON or YAML
- the root is an object
- `Resources` exists and is an object
- each resource is an object with a non-empty `Type` string
- `Properties`, when present, is an object

The parser supports common CloudFormation YAML short-form intrinsic tags such as `!Ref`, `!GetAtt`, and `!Sub` by normalizing them to their long-form JSON equivalents. It does not parse CDK source code.

## Reference Extraction

Reference extraction walks CloudFormation values and detects references from:

- `Ref`
- `Fn::GetAtt`
- `Fn::Sub`
- `DependsOn`

These become raw architecture edges such as:

- `references`
- `depends-on`

Raw references preserve template-level dependency information. They are different from runtime edges, which describe what resources do at runtime.

## Runtime Graph Analysis

The runtime graph builder adds typed `ArchitectureEdge` objects for relationships inferred from known CloudFormation properties.

Current runtime edges:

- Lambda function uses IAM role: `uses-role`
- API Gateway method invokes Lambda: `invokes`
- SQS queue uses dead-letter queue: `dead-letter`

The final report keeps both raw reference edges and runtime architecture edges. This lets the UI show both dependency structure and meaningful runtime behavior.

## Public Exposure And Reachability

Public entry point detection currently marks these resources as public entry points:

- `AWS::ApiGateway::RestApi`
- `AWS::ApiGatewayV2::Api`
- `AWS::CloudFront::Distribution`
- `AWS::ElasticLoadBalancingV2::LoadBalancer` with `Scheme: "internet-facing"`

Public reachability starts from those entry points and traverses architecture edges. The result is included in the report as `publiclyReachableResourceIds`.

This reachability data is also used by contextual severity scoring.

## Rule Engine

Rules are small objects with:

- `id`
- `title`
- `severity`
- `evaluate(context)`

Rules receive an `AnalysisContext`, which contains:

- parsed resources
- architecture edges
- the original template
- public reachability data
- helper methods for resource and edge lookup

Current rules include IAM wildcard permissions, API Gateway methods without auth, missing S3 public access block settings, missing SQS DLQs, missing DynamoDB PITR, and missing CloudWatch log retention.

Rules should stay focused on detecting a risk. Broader context, such as public reachability, should be applied in the severity adjustment layer when possible.

## Contextual Severity

After rules run, InfraLens applies severity adjustment logic.

Currently, `IAM_WILDCARD_PERMISSIONS` is raised to critical when the affected role is publicly reachable or used by a publicly reachable Lambda function.

This keeps individual rules simpler while still allowing the report to reflect architecture context.

## Least-Privilege Suggestions

Least-privilege suggestions are generated from the template only.

The current implementation looks for this pattern:

- a Lambda function uses an IAM role
- a role policy allows supported service actions on `Resource: "*"`
- the Lambda references a supported resource type in its environment or properties

Supported suggestions:

- DynamoDB table resource ARN via `Fn::GetAtt`
- SQS queue resource ARN via `Fn::GetAtt`
- SNS topic resource via `Ref`

Suggestions include confidence:

- `high`: one matching resource was inferred
- `medium`: multiple matching resources were inferred
- `low`: no safe replacement resource was inferred

The analyzer does not inspect Lambda source code yet, so suggestions are conservative.

## Local API

`apps/api` exposes the analyzer through an Express app.

Endpoints:

- `GET /health`
- `POST /analyze`

The local API accepts raw CloudFormation JSON or YAML and returns `AnalysisReport` JSON. Request parsing and analysis error handling are shared with the Lambda-compatible handler where practical.

## Lambda Handler

`apps/api` also contains a Lambda-compatible analyze handler for API Gateway events.

The handler:

- accepts API Gateway request bodies
- decodes base64 bodies when needed
- validates and analyzes CloudFormation JSON or YAML
- returns JSON responses with clear 400 and 500 errors

The CDK stack does not yet bundle and deploy this handler. That wiring is expected in a later infrastructure step.

## Frontend

`apps/web` is a React and Vite app.

The current frontend can:

- accept pasted CloudFormation JSON or YAML
- upload `.json`, `.yaml`, and `.yml` template files
- call the local API
- show score and severity summary
- group findings by severity
- render the architecture graph
- show public entry and reachability information
- display least-privilege policy suggestions

The graph uses React Flow for interaction and Dagre for layout.

## CLI

`apps/cli` provides a command-line interface over the analyzer.

It can print:

- readable text output
- formatted JSON via `--json`

The CLI is useful for demos, quick local checks, and validating analyzer behavior without the web app.

## Infrastructure

`infra/cdk` contains the initial AWS CDK skeleton.

Current planned resources:

- S3 bucket for frontend hosting
- CloudFront distribution for the frontend
- Lambda function for the analysis API
- API Gateway endpoint for `POST /analyze`

The skeleton is intentionally minimal. It does not add authentication, DynamoDB, secrets, or full Lambda bundling yet.
