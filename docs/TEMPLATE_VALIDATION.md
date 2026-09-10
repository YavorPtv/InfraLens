# Template validation

Analysis success does not mean that a CloudFormation template is deployable.
Passing AWS CloudFormation ValidateTemplate does not guarantee that stack creation/update will succeed.

## Input pipeline

Input -> Parse JSON/YAML -> Local CloudFormation structure checks -> Analyzer -> Optional AWS validation.

These are separate results. `AnalysisReport.analysisStatus` is `completed` only when the analyzer
returns a report. `validation` contains `parse`, `structure`, `cloudFormation`, and `issues`.
Each validation stage has one of four statuses:

| Status | Meaning |
| --- | --- |
| `valid` | That stage ran and passed its checks. |
| `invalid` | That stage ran and rejected the template. |
| `not-run` | The stage was disabled or an earlier required stage failed. |
| `unavailable` | AWS validation was enabled but could not complete, or the template exceeded its body limit. |

The existing parser in `packages/analyzer/src/parseTemplate.ts` remains the single parser used by
analysis, local validation and generated-output validation. As with CloudFormation, it tries JSON
first, then YAML. A string that is invalid JSON but valid YAML can therefore pass parsing. YAML
short-form intrinsics are normalized into objects such as `Ref` and `Fn::Sub`, not flattened strings.
Parser issues retain diagnostic text and YAML line/column locations without stack traces or source
excerpts. Unsupported YAML tags fail explicitly instead of silently losing their semantics.

Local checks require an object root, a Resources object, resource objects with non-empty Type
strings, and object-shaped Properties/Metadata/CreationPolicy/UpdatePolicy. They check modeled
section shapes, parameter Type, output Value, DependsOn, resource condition/policy strings, and
Transform/Description/version field shapes. They also reject cyclic YAML aliases, non-finite numbers
and nesting deeper than 100 levels before recursive analysis. Shared acyclic aliases are accepted.

This is a limited structural check, not the entire CloudFormation specification. Empty Resources
remains accepted locally for compatibility with analyzer/compare fixtures; AWS may reject it.
The checker does not validate every resource property, required service property, intrinsic argument,
logical reference, type name, condition expression or cross-resource relationship. Macro-expanded
structures such as `Fn::ForEach` resource entries are not modeled. JSON parsing retains its usual
last-value behavior for duplicate object keys; YAML duplicate keys are rejected by the YAML parser.

## API contract and analyzer failures

Express and Lambda use the same operation and validation functions:

- `/analyze` returns a report with explicit validation results. AWS rejection does not remove
  findings or change `analysisStatus: completed` into an analysis failure.
- Invalid input retains HTTP 400 and the existing `INVALID_TEMPLATE` envelope code. Its
  `error.validation.issues` identify `TEMPLATE_PARSE_ERROR` or `TEMPLATE_STRUCTURE_ERROR` with a stage
  and optional path; `error.analysisStatus` is `not-run`.
- An internal analyzer exception returns HTTP 500 `ANALYZER_INTERNAL_ERROR`, with successful local
  validation preserved and `error.analysisStatus: failed`. It does not echo exception messages.
- Malformed request envelopes, source mappings and request limits retain their existing errors;
  these are request validation failures, not results of template validation.
- `/diff` runs local checks through both analyses and includes their status in its reports. It does
  not call AWS. The original and generated `/apply` checks provide the optional AWS layer for the
  Analyze -> Apply -> Compare workflow.

Validation issues are separate from IAM/security/reliability findings and do not change risk scores.
The web report, CLI readable output, JSON exports and Markdown exports include validation status.
The CLI is offline by default and has no AWS flags or credential requirement. Direct analyzer calls
raise `TemplateValidationError` for parse/structure failure; their internal exceptions remain distinct.

## Generated templates and downloads

Selected fixes -> Generate a copy -> Serialize/re-parse -> Local structure checks -> Optional AWS
validation -> Review/download.

The patch engine preserves the original template, intrinsic objects and unrelated properties. Its
existing per-fix transaction behavior remains: a patch failure rejects that fix's candidate copy;
unrelated successful fixes remain applied. Validation failures do not silently roll back the output.
The API rechecks the actual returned artifact, even if a custom patch engine reports success.
AWS receives the same formatted JSON that the web UI offers for download.

`ApplySuggestionsResult` includes `originalValidation`, generated `validation`, and
`generatedTemplateStatus`:

| Result | UI behavior |
| --- | --- |
| `ready` | Local checks and AWS validation passed; review/download allowed. |
| `review-required` | Local checks passed, AWS is not-run/unavailable; review/download allowed with an explicit warning. |
| `invalid` | Local checks did not pass or AWS rejected the output; normal download and immediate compare blocked. |

While the request runs, the button says “Applying and validating...” and no previous artifact is
offered. Failed output remains visible and copyable for debugging. The UI uses the shared validation
predicate to gate download, rather than trusting applied-fix count or a standalone ready flag.
An HTTP 200 `/apply` response means the operation returned an artifact and its validation result;
it does not mean that artifact passed validation. API clients must check `validation` before use.

Issues include possible contributing fix IDs where practical: resource-local issues identify
applied fixes targeting that resource, while AWS issues list the applied fixes because AWS does not
identify a patch. These are candidates for review, not proof of causation. Comparing original and
generated statuses helps distinguish an existing problem from a patch-generation regression.

## Optional AWS check

The SDK v3 implementation and `CloudFormationTemplateValidator` interface live in
`apps/api/src/cloudFormationValidation.ts`. `packages/analyzer` has no AWS SDK dependency.

The shipped CDK Lambda configuration sets `INFRALENS_CLOUDFORMATION_VALIDATION=true`. After that
configuration is deployed, `/analyze` and `/apply` run ValidateTemplate following successful local
checks. The local API defaults to offline mode; set the same variable to `true` to opt in with an
AWS region and credentials configured in the backend environment. Factory functions used by tests
accept an explicit validator and default to offline, independently of environment variables.

Only the template is sent to AWS, not separately uploaded source files. Templates may themselves
contain inline Lambda code or other sensitive values. No S3 upload, temporary stack, change set,
deployment simulation or deployment is performed. This implementation change does not deploy itself.

The SDK request is bounded to five seconds with one attempt. Missing credentials/region, access
denial, throttling, network failures and timeout return `AWS_VALIDATION_UNAVAILABLE`. A service
`ValidationError` becomes `CLOUDFORMATION_VALIDATION_ERROR` and status `invalid`. Raw AWS messages,
credentials and request metadata are not returned or logged; rejection gets a safe general message.

[ValidateTemplate's direct body limit](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_ValidateTemplate.html)
is 51,200 UTF-8 bytes. InfraLens still accepts its existing larger local template limit; when AWS
validation is enabled, an oversized body returns `unavailable` without making an AWS request.

The Lambda role adds only `cloudformation:ValidateTemplate`, using Resource `*` because this
operation has no resource-level IAM scope. Its existing log permissions remain scoped to its own
log group. It gains no permissions to create/update stacks or inspect account resources.

## Verification and remaining limits

Mocha/Chai tests cover syntax and shape failures, intrinsics, immutability, deterministic patches,
malformed generated output, readiness/download gating, AWS adapter mappings/timeouts/size limits,
Express/Lambda parity and Analyze -> Apply -> Compare. Tests inject only the AWS adapter boundary
and exceptional engine cases; normal tests need no AWS credentials and make no live AWS calls.
CDK tests and synth verify environment configuration and the narrow IAM action.

The UI is typechecked and built; browser rendering, clipboard and download clicks still require
manual verification. A real AWS acceptance check is not established by adapter unit tests or synth.

Even after all stages pass, deployment can fail because of permissions, quotas, unsupported regional
features, missing runtime dependencies, invalid parameter values, resource-name conflicts, account
state, service property constraints, macro behavior, custom resource failures or changes between
validation and deployment. ValidateTemplate is not a deployment rehearsal or comprehensive schema
validator. Review the generated changes and validate the intended stack operation in its real
deployment context.
