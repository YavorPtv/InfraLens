# InfraLens Codex Handoff

## Current Repo State

- Current branch at handoff time: `master`
- Working tree at handoff time: clean
- Latest visible commits:
  - `e49c5ef Add template diff UI (#34)`
  - `9d8f75c Add template diff analysis (#33)`
  - `8a95b5e Update README for source upload analysis`
  - `e6ff4a8 Feature/source code upload ui (#32)`

Always start a new task by running:

```powershell
git status --short --branch
git log --oneline --decorate -5
```

## Project Summary

InfraLens is a local-first AWS architecture analyzer. It parses CloudFormation JSON/YAML, builds resource and architecture graphs, detects security/reliability risks, and generates evidence-based IAM least-privilege suggestions.

The analyzer does not call AWS APIs and should not add AWS SDK dependencies unless explicitly requested.

## Workspace Layout

- `packages/analyzer`: CloudFormation parsing, rule engine, graph/reachability analysis, diff analysis, source scanning, least-privilege suggestions
- `packages/shared`: shared public types, including `AnalysisReport` and `DiffReport`
- `apps/api`: local Express API plus Lambda-compatible handler
- `apps/web`: React + Vite frontend
- `apps/cli`: CLI report output
- `infra/cdk`: CDK skeleton for hosting/API infrastructure
- `examples`: demo templates and source-code fixtures
- `docs`: architecture/demo docs

## Current Major Features

### Analyzer

- Parses CloudFormation JSON and YAML.
- Extracts references from `Ref`, `Fn::GetAtt`, `Fn::Sub`, `Fn::Join`, `Fn::If`, `Fn::ImportValue`, and `DependsOn`.
- Builds runtime architecture edges:
  - Lambda uses IAM role: `uses-role`
  - API Gateway invokes Lambda: `invokes`
  - SQS queue uses DLQ: `dead-letter`
- Detects public entry points and public reachability.
- Applies contextual severity for publicly reachable IAM wildcard permissions.
- Generates least-privilege suggestions for DynamoDB, SQS, and SNS resources.
- Scans uploaded Lambda source files by simple AWS SDK v3 command-name matching.
- Compares old/new templates with `analyzeTemplateDiff`.

### Rules

- `IAM_WILDCARD_PERMISSIONS`
- `API_GATEWAY_METHOD_NO_AUTH`
- `S3_PUBLIC_ACCESS_BLOCK_MISSING`
- `SQS_MISSING_DLQ`
- `DYNAMODB_MISSING_PITR`
- `LOG_GROUP_MISSING_RETENTION`

### API

Local Express API in `apps/api`.

Endpoints:

- `GET /health`
- `POST /analyze`
- `POST /diff`

`POST /analyze` accepts raw JSON/YAML templates or this JSON envelope:

```json
{
  "template": "{ \"Resources\": {} }",
  "sourceFiles": {
    "handler.ts": "await client.send(new GetCommand({ TableName: tableName }));"
  }
}
```

`POST /diff` accepts:

```json
{
  "oldTemplate": "{ \"Resources\": {} }",
  "newTemplate": "{ \"Resources\": {} }"
}
```

The Lambda-compatible handler in `apps/api/src/lambda.ts` routes `POST /analyze` and `POST /diff`.

### Web App

React + Vite app in `apps/web`.

Routes:

- `/`: home
- `/analyze`: analyze a single template, with optional Lambda source upload
- `/report`: display analysis report
- `/compare`: compare old/new templates and display `DiffReport`

The web app uses `VITE_INFRALENS_API_BASE_URL` for API base URL. See `.env.example` files.

### Demo Files

- `examples/order-service-risky-template.json`
- `examples/order-handler-source.ts`
- `examples/simple-bad-template.json`
- `examples/simple-good-template.json`
- `examples/simple-yaml-template.yaml`

For source-upload testing, use:

- Template: `examples/order-service-risky-template.json`
- Source file: `examples/order-handler-source.ts`

Expected effect: least-privilege suggestion should narrow `dynamodb:*` to `dynamodb:GetItem` and `dynamodb:PutItem`.

## Important Design Notes

- Keep analyzer logic independent from React and AWS SDK.
- Shared public contract types belong in `packages/shared`.
- Use Mocha and Chai for tests.
- Prefer small pure functions and scoped changes.
- Do not add Bootstrap.
- Do not add React to analyzer/API packages.
- Do not add AWS SDK unless the user explicitly changes that constraint.

## Known Gotchas

- API tests can use built package output for workspace dependencies. If API tests behave as if analyzer changes are stale, rebuild dependencies first:

```powershell
npm.cmd run build --workspace @infralens/shared
npm.cmd run build --workspace @infralens/analyzer
```

- The source-code scanner is intentionally shallow. It matches known command names in source text and does not parse ASTs or map files to Lambda logical IDs yet.
- `PolicySuggestion` currently includes both explicit fields and a compatibility alias:
  - `currentActions`
  - `suggestedActions`
  - `actions` as a legacy/suggested-action alias
- The Report UI must render original policy statements from `currentActions`, not `actions`.
- The graph layout uses React Flow and Dagre. Perfect graph layout for every template is not realistic; keep changes practical.

## Common Commands

Install:

```powershell
npm.cmd install
```

Run all tests:

```powershell
npm.cmd run test
```

Run all typechecks:

```powershell
npm.cmd run typecheck
```

Run full build:

```powershell
npm.cmd run build
```

Run API locally:

```powershell
npm.cmd run build --workspace @infralens/api
npm.cmd run start --workspace @infralens/api
```

Run web locally:

```powershell
npm.cmd run dev --workspace @infralens/web
```

Run CLI:

```powershell
npm.cmd run analyze -- examples\order-service-risky-template.json
npm.cmd run analyze -- --json examples\order-service-risky-template.json
```

## Likely Next Good Tasks

- Add CLI support for template diff analysis.
- Add source-file-to-Lambda mapping so source actions are scoped per Lambda.
- Add source inference display/evidence improvements in the least-privilege UI.
- Add `POST /diff` support to deployed CDK API Gateway routes if not already connected in infrastructure.
- Add tests or fixture docs for the Compare Templates page workflow.

