# InfraLens Codex Handoff

## Start Here

At the time this handoff was refreshed:

- Current branch: `main`
- Working tree before this documentation edit: clean
- Current commit: `d2100ff Protect hosted API for invited access (#48)`
- This `HANDOFF.md` update may be the only uncommitted change.

Always begin a new task by checking the live repository state rather than assuming this snapshot is
still exact:

```powershell
git status --short --branch
git log --oneline --decorate -8
```

Read `AGENTS.md`, the root `README.md`, and the files relevant to the task before changing code. Do
not discard unrelated user changes in a dirty worktree.

## Project Summary

InfraLens is a TypeScript monorepo for local-first AWS architecture analysis. It parses
CloudFormation JSON/YAML, builds resource and runtime relationship graphs, detects security and
reliability risks, compares templates, and generates evidence-based least-privilege IAM suggestions
and structured template fixes.

The analyzer does not inspect live AWS accounts and must remain independent from React and the AWS
SDK. Do not add the AWS SDK unless a future request explicitly changes that constraint.

## Workspace Layout

- `packages/analyzer`: parsing, rules, graph/reachability analysis, source inference, diffing, and
  structured fixes
- `packages/shared`: public report/contracts and Markdown/JSON exporters
- `apps/api`: local Express API and Lambda-compatible API Gateway handler
- `apps/cli`: single-template analysis, template diff, and report export
- `apps/web`: React + Vite analysis, compare, report, source mapping, apply, and authentication UI
- `infra/cdk`: S3/CloudFront frontend hosting, REST API Gateway, Lambda, Cognito, logs, alarms, and
  optional budget
- `examples`: CloudFormation and source-code fixtures
- `docs`: architecture, roadmap, demos, and protected deployment instructions

Use npm workspaces and Mocha/Chai. Do not introduce Jest or Vitest.

## Current Capabilities

### Analysis And Rules

The analyzer currently:

- Parses JSON and YAML CloudFormation templates.
- Extracts `Ref`, `Fn::GetAtt`, `Fn::Sub`, `Fn::Join`, `Fn::If`, `Fn::ImportValue`, and `DependsOn`.
- Builds `references`, `uses-role`, `invokes`, and `dead-letter` graph edges.
- Detects public entry points/reachability and contextually escalates reachable IAM wildcard risks.
- Compares old/new templates and separates added, removed, changed, introduced, resolved, and
  unchanged results.
- Creates structured, selectable template fixes while preserving unrelated properties and intrinsic
  functions.

Current rule IDs:

- `IAM_WILDCARD_PERMISSIONS`
- `IAM_PASSROLE_WILDCARD`
- `IAM_PRIVILEGE_ESCALATION_ACTIONS`
- `API_GATEWAY_METHOD_NO_AUTH`
- `API_GATEWAY_ACCESS_LOGGING_MISSING`
- `API_GATEWAY_TRACING_DISABLED`
- `S3_PUBLIC_ACCESS_BLOCK_MISSING`
- `S3_VERSIONING_DISABLED`
- `SQS_MISSING_DLQ`
- `SNS_TOPIC_ENCRYPTION_MISSING`
- `DYNAMODB_MISSING_PITR`
- `DYNAMODB_DELETION_PROTECTION_DISABLED`
- `LOG_GROUP_MISSING_RETENTION`
- `LAMBDA_TRACING_DISABLED`
- `LAMBDA_DEAD_LETTER_CONFIG_MISSING`
- `LAMBDA_RESERVED_CONCURRENCY_RISK`

Every analyzer rule must have Mocha/Chai unit tests and every finding must include `ruleId`, `title`,
`severity`, `resourceId`, `explanation`, `evidencePath`, and `suggestion`.

### Source Inference And Least Privilege

Uploaded JavaScript/TypeScript files are scanned through lightweight package-aware AWS SDK v3
command matching. Source actions include the source path, command, IAM action, Lambda logical ID when
known, action confidence, mapping confidence, and evidence.

Source-to-Lambda mapping supports:

- Explicit mappings from API/UI input, treated as high confidence
- Lambda `Properties.Handler`, code/metadata conventions, and file-name matching
- `Auto-detect` and `Shared / not a Lambda handler` in the web UI
- A relative local import graph for ES imports, side-effect imports, and practical CommonJS requires
- `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, and index-file resolution
- Transitive/shared imports, cycle protection, ambiguity rejection, and deduplication

Shared files contribute actions only to Lambda handlers that can reach them through the uploaded
import graph. They do not receive IAM roles of their own. Different Lambda source trees must not mix
actions.

Least-privilege metadata currently covers DynamoDB, S3, SQS, SNS, Lambda invocation, EventBridge,
Secrets Manager, SSM Parameter Store, and conservatively reviewed KMS actions. Exact action
narrowing requires strong source command/package and Lambda mapping evidence. Unknown actions,
mixed-service statements, ambiguous resources, and KMS changes remain manual review where a safe
patch cannot be proven.

Important contract detail: `PolicySuggestion` has `currentActions`, `suggestedActions`, and the
legacy `actions` alias. Original policy rendering must use `currentActions`. A suggestion with equal
current/suggested actions is not action narrowing; the UI now says no safe action narrowing was
inferred and does not offer a copyable no-op replacement.

### API

Both Express and Lambda support:

- `GET /health`
- `POST /analyze`
- `POST /diff`
- `POST /apply`

`POST /analyze` accepts a raw JSON/YAML template or an envelope containing:

```json
{
  "template": "{ \"Resources\": {} }",
  "sourceFiles": {
    "src/handler.ts": "source text"
  },
  "sourceFileMappings": {
    "src/handler.ts": "HandlerFunction"
  },
  "sourceFileExclusions": []
}
```

`POST /diff` accepts `oldTemplate` and `newTemplate` strings. `POST /apply` accepts a template string
and selected structured fixes.

Centralized API limits in `apps/api/src/requestLimits.ts` are shared by Express and Lambda:

- Request: 4 MiB
- Template: 1 MiB
- Source files: 100
- One source file: 256 KiB
- Combined source: 2 MiB
- Source mappings: 100
- Source exclusions: 100
- Combined diff templates: 2 MiB
- Selected fixes: 200

Oversized input returns a structured `413 PAYLOAD_TOO_LARGE` before analyzer work. Operation logs are
structured and intentionally exclude templates, source contents, bodies, tokens, and secrets.

### CLI And Exports

The CLI supports readable, JSON, and Markdown analysis output, output files, and old/new template
diffing. Shared exporters support `AnalysisReport` JSON/Markdown and `DiffReport` Markdown.

Examples:

```powershell
npm.cmd run analyze -- examples\order-service-risky-template.json
npm.cmd run analyze -- --json examples\order-service-risky-template.json
npm.cmd run diff -- examples\simple-good-template.json examples\simple-bad-template.json
npm.cmd run analyze -- --diff --markdown examples\simple-good-template.json examples\simple-bad-template.json
```

### Web App

Main routes:

- `/`: workspace home
- `/analyze`: template input, source upload, and Lambda mapping
- `/report`: score, graph, findings, least privilege, evidence, exports, and apply suggestions
- `/compare`: old/new template comparison and diff export
- `/auth/callback`: production Cognito OAuth callback

The frontend can download JSON and Markdown reports and generate/download a modified template from
selected deterministic fixes. It never overwrites or deploys the submitted template.

Production authentication uses Cognito hosted sign-in with authorization-code flow and PKCE, stores
tokens in session storage, refreshes expired access tokens, adds bearer tokens to protected requests,
and handles `401`/`403`. Authentication is isolated under `apps/web/src/auth`.

### Hosted Infrastructure

The existing API is REST API Gateway, not HTTP API Gateway. Production CDK configuration:

- Creates a Cognito User Pool with self-sign-up disabled.
- Protects `POST /analyze`, `/diff`, and `/apply` with a Cognito authorizer and `openid` scope.
- Leaves the cheap mock `GET /health` endpoint unauthenticated.
- Restricts CORS to the CloudFront/custom frontend origin and allows only required methods/headers.
- Uses a 30-second, 512 MiB ARM64 Lambda.
- Leaves reserved concurrency unset by default because reduced-quota AWS accounts may be unable to
  reserve any; `lambdaReservedConcurrency` remains an opt-in CDK context setting.
- Throttles REST API traffic at 2 requests/second with a burst of 5 by default.
- Retains structured Lambda/API access logs for 30 days.
- Creates alarms for Lambda errors, throttles, p95 duration near timeout, and API 5XX responses.
- Optionally creates SNS email alarm delivery and an AWS monthly budget.
- Gives the analyzer Lambda only `logs:CreateLogStream` and `logs:PutLogEvents` on its own log group.

See `docs/PRODUCTION_DEPLOYMENT.md` before changing or deploying this stack.

## Deployment Lessons And Gotchas

- There is no `npm run deploy` script. Deploy from the root with `npm exec`:

```powershell
npm.cmd run build --workspace @infralens/cdk
npm.cmd exec --workspace @infralens/cdk -- cdk deploy --context environment=production --context cognitoDomainPrefix=YOUR_VALID_PREFIX
```

- Cognito prefix domains must be globally unique, 1-63 lowercase letters/numbers/internal hyphens,
  and cannot contain the reserved strings `aws`, `amazon`, or `cognito`. CDK now validates this
  before deployment.
- A deployment using `infralens-cognito` failed because `cognito` is reserved.
- A deployment using default reserved concurrency of 5 failed in a reduced-quota account because it
  would leave fewer than 10 executions unreserved. Reserved concurrency is now opt-in.
- Failed/removed production stacks can leave Cognito User Pools, S3 buckets, and log groups because
  they use `RemovalPolicy.RETAIN`. Delete orphaned resources manually when complete cleanup is wanted.
- `cdk destroy` takes the app offline but does not remove those retained resources.
- CDK creates the frontend bucket/distribution but does not upload `apps/web/dist`. Build the web app
  with the deployed `VITE_INFRALENS_*` values, run `aws s3 sync`, and invalidate CloudFront.
- PowerShell does not use `\` as a line continuation. Prefer one-line commands in user instructions
  unless PowerShell backticks are shown explicitly.
- A manually exercised production deployment succeeded after using a valid domain and omitting
  reserved concurrency, but do not assume any AWS resources are still deployed.

Required frontend production variables:

- `VITE_INFRALENS_API_BASE_URL`
- `VITE_INFRALENS_AUTH_ENABLED=true`
- `VITE_INFRALENS_COGNITO_CLIENT_ID`
- `VITE_INFRALENS_COGNITO_DOMAIN`
- Optional explicit callback/logout URI overrides

## Example Fixtures

- `examples/order-service-risky-template.json` plus `examples/order-handler-source.ts`: basic source
  action narrowing demo
- `examples/source-file-lambda-mapping`: two-Lambda explicit mapping request/fixtures
- `examples/shared-source-import-graph`: shared, transitive, circular, excluded, and unrelated source
  graph examples
- `examples/compare`: documented introduced/resolved/added/removed/changed diff workflow
- `examples/simple-good-template.json` and `examples/simple-bad-template.json`: basic rule fixtures
- `examples/simple-yaml-template.yaml`: YAML parsing fixture

`simple-bad-template.json` currently produces six findings and score 25, but no least-privilege
suggestions. Its policy uses generic `Action: "*"`, its Lambda has no table/queue reference, and no
source is submitted. It is a rule fixture, not a least-privilege fixture.

## Testing And Build Notes

Common commands:

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd run test
npm.cmd run build
npm.cmd run synth --workspace @infralens/cdk
```

Production synthesis requires a valid Cognito prefix:

```powershell
npm.cmd run build --workspace @infralens/cdk
npm.cmd exec --workspace @infralens/cdk -- cdk synth --context environment=production --context cognitoDomainPrefix=infralens-login-synth-review
```

Tests use Mocha and Chai. Test `tsconfig` files intentionally include Mocha types; preserve that
pattern when adding tests in a new workspace/folder.

Workspace dependencies can be stale when a package test resolves another package's `dist` output.
If API/CLI tests cannot find or appear not to include analyzer/shared changes, build these first:

```powershell
npm.cmd run build --workspace @infralens/shared
npm.cmd run build --workspace @infralens/analyzer
```

CDK synthesis/tests invoke esbuild. In restricted tooling environments, bundling can require access
outside the default sandbox or a separate `--output` directory if another CDK process is using
`infra/cdk/cdk.out`.

Recent verification for the protected API work included the full workspace typecheck, Mocha suites,
workspace build, development/production synth, IAM review, plus focused web and CDK checks after
deployment fixes. No browser/E2E test was used for that task.

The Vite build currently emits a non-failing warning that the main bundle is slightly over 500 kB.

## Current Limitations

Keep this summary consistent with the root README:

- Rule/service/SDK-command coverage is useful but not comprehensive AWS security coverage.
- Source inference is lightweight and the browser uploader loses source directory paths, so nested
  paths or duplicate names can require explicit mapping/API input.
- High-confidence IAM output is only as complete as the submitted template and source files.
- Parsing is not full CloudFormation schema/deployment validation.
- Compare does not accept separate old/new source trees.
- Reports are not persisted across browser sessions.

## Recommended Next Work

Follow `docs/ROADMAP.md`, currently ordered as:

1. Test the complete Analyze -> Review -> Apply -> Compare workflow.
2. Preserve source project directory structure in the web upload flow.
3. Add stronger validation for analyzed and generated CloudFormation templates.
4. Expand analyzer and least-privilege coverage from real use cases.
5. Add persistence only when history/collaboration requirements are clear.

Not near-term: PDF export, live AWS account scanning/AWS SDK integration, broad multi-IaC parsing,
or attempting a perfect graph layout for every template.
