# InfraLens Handoff

Last refreshed: September 23, 2026.

## Start Here

- Verified local baseline: `main` at `694ff3d` (documentation refresh), following `9c156f9`
  (PR #52, analyzer coverage), PR #51 (template validation) and PR #50 (source project paths).
  These features are merged.
- No implementation is awaiting merge from that work. This refresh changes documentation only.
- The analyzer coverage task did not deploy anything. Current AWS deployment and CI status
  have not been verified; do not infer them from the local branch or historical checks.
- Read `AGENTS.md`, this file, and then only the documentation and code relevant to the task.
  Use `README.md` for setup and usage; do not reread every document for each new task.
- Always check live state before editing; preserve unrelated user changes:

```powershell
git status --short --branch
git log --oneline --decorate -5
```

## Project And Code Map

The project's primary goal is now portfolio value and learning unfamiliar AWS infrastructure.
The analyzer is sufficient for this stage: fix serious bugs, but defer broad coverage expansion.
The replacement roadmap prioritizes saved projects/history, asynchronous analysis, reliable event
dispatch and operations. The final integrated showcase comes after those features. These are plans,
not existing capabilities; no persistence or job infrastructure was added in this documentation task.

InfraLens analyzes CloudFormation JSON/YAML, including synthesized CDK templates, for AWS
security/reliability risks. It builds resource graphs, compares templates, suggests least-privilege
IAM policies, and generates modified templates from selected deterministic fixes.

TypeScript, npm workspaces, React/Vite, Node/Express, Mocha/Chai, and AWS CDK. Follow `AGENTS.md`:
keep the analyzer independent of React and AWS SDK, test every analyzer rule, and ask before
changing project structure. No Bootstrap unless requested.

| Area | Location |
| --- | --- |
| Parsing, rules, graph, IAM, source analysis, fixes and diff | `packages/analyzer/src` |
| Shared report/API types and exports | `packages/shared/src` |
| Express and Lambda API adapters | `apps/api/src` |
| React UI and Cognito authentication | `apps/web/src` |
| CLI analysis and comparison | `apps/cli/src` |
| Hosted infrastructure | `infra/cdk` |
| Templates and uploaded-source fixtures | `examples` |

Analyzer/CLI run offline. Only the API optionally calls AWS CloudFormation ValidateTemplate;
this is validation, not live account scanning. Hosted routes use REST API Gateway (not HTTP API).

## Current Behavior And Important Contracts

- Analyze -> Review -> Apply -> Compare -> Export is implemented with local integration coverage.
  API: `GET /health`, `POST /analyze`, `/diff`, `/apply`. Web: `/`, `/analyze`, `/report`, `/compare`.
- Parsing, local structure validity, analyzer completion and optional AWS validation are separate
  statuses. Generated templates are revalidated; invalid downloads are blocked but inspectable.
  AWS ValidateTemplate does not prove deployability.
- Folder uploads preserve relative paths. Shared normalization lives in
  `packages/shared/src/sourceFiles.ts`; ordinary file selection can still expose only basenames.
  Explicit Lambda mappings, handler inference, exclusions and transitive relative imports exist.
- Source inference uses TypeScript syntax and lexical symbols in a closed in-memory host. It does
  not execute source or load node_modules. Real SDK imports, aliases and literal CommonJS imports
  are supported; comments, strings, local mock classes and shadowed names do not infer actions.
- IAM analysis covers inline identity policies and template-defined attached/managed policies.
  Conditions, boundaries, unresolved references and relevant Deny paths are evidence, not computed
  effective permissions. `iamAnalysis.evaluation` is always `partial`; `iamContext` carries context.
  No boundary intersection, external-policy fetching or complete IAM evaluation is implemented.
- Uncertain, conditional, bounded or shared-policy replacements require manual review. Shared
  execution roles cannot be narrowed using only one Lambda's source.
- S3 bucket/object actions use separate suggested statements. DynamoDB Query/Scan index ARNs
  require specific source/template evidence; no automatic `/index/*` expansion.
- `PolicySuggestion.currentActions` renders the original policy; `suggestedActions` is proposed;
  `actions` is the legacy alias. Use `suggestedStatements` for multi-statement replacements.
  Do not offer a copyable no-op replacement as action narrowing.
- Supported service metadata: DynamoDB, S3, SQS, SNS, Lambda invocation, EventBridge, Secrets
  Manager, SSM and conservative/manual KMS. See `serviceMetadata.ts` and the coverage document.
- `LAMBDA_SERVICE_PERMISSION_UNSCOPED` checks supported service invocation permissions.
  Lambda failure-handling checks distinguish `$LATEST` from versions/aliases; known SQS failure
  targets are not required to have an endless chain of dead-letter queues.
- Report UI shows aggregate IAM/source limitations. The Source Inference panel shows commands,
  actions, confidence, handler roots and import chains, but does not directly render
  `importedSymbol`, `localSymbol`, `useLocation`, `sdkPackage`, `indexAccess` or per-action `limitations`.
  See `apps/web/src/components/report/LeastPrivilegeSuggestions.tsx`.

## Read More Only As Needed

| Task | Reference |
| --- | --- |
| Priorities and unfinished work | [Roadmap](docs/ROADMAP.md) |
| Setup, API inputs and CLI usage | [README](README.md) |
| Current API size/count limits | `apps/api/src/requestLimits.ts` |
| IAM semantics, source evidence, service mappings and limitations | [Analyzer coverage](docs/ANALYZER_COVERAGE.md) |
| Parse/structure/AWS validation and generated artifacts | [Template validation](docs/TEMPLATE_VALIDATION.md) |
| Folder uploads, paths, mappings and exclusions | [Source uploads](docs/SOURCE_UPLOADS.md) |
| Integration tests and opt-in hosted smoke checks | [Testing](docs/TESTING.md) |
| Authentication and deployment configuration | [Production deployment](docs/PRODUCTION_DEPLOYMENT.md) |

Use `examples/analyzer-coverage` for realistic IAM/source cases, `examples/nested-source-project`
for preserved paths, and `examples/shared-source-import-graph` for shared imports. The original
`examples/order-handler-source.ts` uses mock command classes and correctly infers no SDK actions.
`examples/compare` demonstrates template comparison.

## Verification

The analyzer coverage task recorded 435 passing tests (analyzer 284, API 106, CLI 17, shared 20,
CDK 8), workspace typecheck/build, and production CDK synthesis with no lookups. These are historical
local results, not newly rerun checks or proof of CI success. PR #52 was merged without waiting for CI.
No browser/E2E checks, live AWS calls or deployment were performed for that task.

```powershell
npm.cmd run typecheck
npm.cmd run test
npm.cmd run build
npm.cmd run test:integration
```

API/CLI tests can resolve stale workspace `dist` output; rebuild shared and analyzer first when
needed. `test:integration` already builds these dependencies. CDK tests/synth use esbuild, which
can need sandbox access or a separate output directory. Production synthesis:

```powershell
npm.cmd run build --workspace @infralens/cdk
npm.cmd exec --workspace @infralens/cdk -- cdk synth --no-lookups --context environment=production --context cognitoDomainPrefix=infralens-login-synth-review
```

## Deployment And Remaining Work

Production uses invited Cognito access, authorization-code flow with PKCE, protected POST routes,
restricted CORS, request limits, throttling, logs and alarms. Health is public. Do not log submitted
source/templates or tokens. Read the deployment guide before infrastructure changes.

Keep these deployment lessons: reserved concurrency is opt-in for reduced-quota accounts; Cognito
prefixes must be valid and unique; retained pools/buckets/logs can survive stack deletion; CDK does
not upload the web build (S3 sync and CloudFront invalidation are separate). There is no root deploy
script. PowerShell does not support backslash line continuation.

Next work: milestone 1 of [the replacement roadmap](docs/ROADMAP.md). Build owner-scoped projects
and saved analysis runs using DynamoDB metadata and private S3 artifacts. Derive ownership from
trusted Cognito claims; the current Lambda event contract still needs those claims exposed. Keep
AWS adapters outside the analyzer and preserve credential-free local tests/CLI behavior.

Start with create project -> server-side analyze/save -> list/reopen report -> cross-user denial.
Complete pagination, idempotency, deletion and retention before asynchronous processing. Later
milestones add SQS workers, DynamoDB Streams dispatch, scheduled recovery, and operational evidence.
Container workers/Step Functions/EventBridge fan-out are optional, justified scale experiments;
do not implement all by default. No project-structure change is authorized by the roadmap alone.

Browser interactions and hosted authenticated workflows still need verification. Compare accepts
templates only; reports are not persisted across browser sessions. Source analysis has no full data
flow or runtime-completeness guarantee. PDF export, live scanning and broad multi-IaC parsing are
not near-term priorities.
