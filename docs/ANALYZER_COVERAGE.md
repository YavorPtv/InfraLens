# Analyzer coverage and evidence limits

InfraLens analyzes submitted CloudFormation JSON/YAML (including synthesized CDK
templates) and uploaded JavaScript/TypeScript. It does not inspect an AWS account.
This document describes the implementation on `feature/deepen-analyzer-coverage`.

## Changes driven by existing examples

The existing order-service example includes an API Gateway Lambda permission;
the compare, mapping and shared-source fixtures include queues and IAM policies.
The existing expanded-rule tests include asynchronous Lambda configuration. The
new `examples/analyzer-coverage` fixture extends these patterns with managed
policies, boundaries, alternate failure handling and real SDK imports.

| Addition or improvement | Detectable evidence | False-positive boundary | Severity rationale |
| --- | --- | --- | --- |
| `LAMBDA_SERVICE_PERMISSION_UNSCOPED` (new) | `AWS::Lambda::Permission`, exact `lambda:InvokeFunction`, an S3/SNS/EventBridge/API Gateway service principal, and absent SourceArn, SourceAccount and PrincipalOrgID | Deliberate broad cross-account service integrations may be valid. Unknown principals, intrinsic source restrictions, function URLs and unsupported services are not guessed. A supplied restriction is not certified safe. | High: the policy potentially permits invocation via resources controlled by other accounts. It is not a claim that invocation is certainly possible. |
| `LAMBDA_DEAD_LETTER_CONFIG_MISSING` | An EventInvokeConfig without OnFailure is checked against an exactly resolved function's DeadLetterConfig for `$LATEST` | A current function DLQ cannot prove the configuration of a published version/alias. External functions and other qualifiers remain explicitly reviewable. | Medium remains appropriate for loss of failed asynchronous events. Existing function DLQs now prevent a false alarm. |
| `SQS_MISSING_DLQ` | A queue referenced as a failure target by a Lambda function/config/event source, EventBridge rule target, SNS subscription or another SQS queue | Only direct local references are resolved. Conditional/indirect targets and literal external ARNs are not resolved to arbitrary queues. | Medium remains appropriate for an ordinary queue without failure isolation; failure queues no longer need an endless chain of DLQs. |
| Existing `IAM_WILDCARD_PERMISSIONS`, `IAM_PASSROLE_WILDCARD`, `IAM_PRIVILEGE_ESCALATION_ACTIONS` | Identity policy Allow statements, attached policy documents, Condition, Deny and boundary evidence | These are statement-level risks. Contextual critical escalation is withheld when relevant modifiers are present; no condition or boundary is assumed to make a policy safe. | High remains the base risk for broad grants and permission mutation. Critical requires public reachability without the represented modifiers. |

Not added: blanket EventBridge/SNS DLQ requirements, mandatory Secrets Manager
rotation, broad IAM trust analysis, or generic encryption-missing rules. The
template does not establish a workload's delivery/rotation requirements or all
trust-policy semantics. S3, SQS and DynamoDB encryption defaults must not be
misrepresented as missing encryption. No new default-encryption warning was added.

## IAM analysis currently understands

- Inline identity policies on roles, users and groups; `AWS::IAM::Policy`;
  and the actual PolicyDocument of `AWS::IAM::ManagedPolicy`.
- Role/User/Group policy attachments through direct references and explicit
  physical names. ManagedPolicyArns referencing a template policy are associated
  with that identity. A policy document is inspected once; finding context lists
  affected identities. Unknown external attachments require review.
- External AWS-managed/customer-managed ARNs and imported values are unresolved
  references. Even AdministratorAccess is not interpreted from its name. Nothing
  is fetched from AWS. Limitations are present even when no IAM finding exists.
- PermissionsBoundary references on roles and users. A local policy document is
  available for inspection; an external or unresolved value is not. Boundary
  documents used only as boundaries are not misreported as identity grants.
  **No intersection is computed**, even for a template-defined boundary.
- Raw Condition and Deny statements are retained in `iamAnalysis.policies`.
  Deny statements never supply grants or required actions. Denies associated with
  an identity or its boundary are attached as evidence to findings and suggestions;
  overlap and precedence are not simulated.
- Conditional, bounded, denied, unresolved, or shared-policy IAM replacements are
  manual-only. A shared execution role cannot be narrowed using just one Lambda's
  uploaded source. A conditional Lambda Role is not resolved to one arbitrary branch.

`AnalysisReport.iamAnalysis.evaluation` is always `partial`. Findings and affected
suggestions have `iamContext`; explanations distinguish statement permissions from
effective access. CLI, JSON, Markdown and the existing report page expose limitations.

## Condition subset

The central helper distinguishes `none`, `understood`, and `unknown`. An unknown
condition can still contain individually recognized restrictions; those are retained.

| Key | Recognized operators and values | Meaning represented |
| --- | --- | --- |
| aws:SourceArn | ArnEquals or StringEquals; literal non-wildcard ARN(s) | Source request ARN must match |
| aws:SourceAccount | StringEquals; literal 12-digit account(s) | Source account must match |
| aws:PrincipalArn | ArnEquals or StringEquals; literal non-wildcard ARN(s) | Request principal ARN must match |
| aws:RequestedRegion | StringEquals; literal region name(s) | Requested endpoint region, not every affected resource's location |
| aws:SecureTransport | Bool; true/false literals or their string forms | Transport requirement; does not restrict actions/resources |

Alternatives within one key are OR; separate keys/operators are AND. This is an
explanation of the request predicate, not evaluation of whether a runtime request
satisfies it. Source keys may be available only in particular service request contexts.
IfExists, negated/set operators, policy variables, wildcard ARN matching, empty or
malformed conditions, intrinsics and other keys remain unknown. Conditions always
require review before replacement, including the understood subset.

The subset follows AWS's [condition operators](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_condition_operators.html)
and [global context keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html).
The policy model deliberately stops short of AWS's [effective permission evaluation](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic_policy-eval-denyallow.html).

## IAM analysis does not implement

Complete IAM evaluation, arbitrary resource-based policies, trust policy evaluation,
SCPs, RCPs, session policies, group membership inheritance, every condition key,
external managed policy contents, KMS key-policy/grant evaluation, or NotAction /
NotResource complement evaluation. Identity policy references and raw documents
are not evidence of effective unrestricted access. Resource policy review is limited
to targeted template rules such as Lambda invocation permissions.

## Least-privilege action/resource audit

`serviceMetadata.ts` centralizes service prefixes, CloudFormation resource types,
resource-level compatibility, ARN constructors, SDK command mappings and conditional
permission notes. All listed concrete actions support resource scope in the modeled
case; `s3:ListAllMyBuckets` is explicitly wildcard-only and has no SDK inference mapping.
Unknown actions and resource forms remain manual-only.

| Prefix / CloudFormation type | Actions and exact SDK commands | Resource and review behavior |
| --- | --- | --- |
| dynamodb / AWS::DynamoDB::Table | GetItem/GetCommand, PutItem/PutCommand, UpdateItem/UpdateCommand, DeleteItem/DeleteCommand in `@aws-sdk/lib-dynamodb`; corresponding GetItemCommand, PutItemCommand, UpdateItemCommand, DeleteItemCommand in `@aws-sdk/client-dynamodb`; QueryCommand and ScanCommand in both | GetAtt Arn for table operations. Query/Scan with a literal input lacking IndexName use the table. A literal IndexName matching a declared GSI/LSI adds that exact `/index/name` ARN. Missing source, dynamic inputs/index names, spreads, and mismatched indexes require review. Never automatically `/index/*`. |
| s3 / AWS::S3::Bucket | GetObjectCommand/GetObject, PutObjectCommand/PutObject, DeleteObjectCommand/DeleteObject, ListObjectsV2Command/ListBucket in `@aws-sdk/client-s3` | ListBucket uses GetAtt Arn; object actions append `/*`. Bucket/object actions are split into separate statements, including patches and copyable previews. VersionId on Get/Delete is not inferred as the unversioned action. ACL/tag/object-lock options require review; KMS may require separate permissions. Object prefixes, access points, directory buckets and version actions are not inferred. |
| sqs / AWS::SQS::Queue | SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand in `@aws-sdk/client-sqs` map to same-named actions | GetAtt Arn, not Ref (which returns the queue URL). KMS/resource policies and runtime queue selection remain outside effective-access evaluation. |
| sns / AWS::SNS::Topic | PublishCommand/Publish in `@aws-sdk/client-sns` | Ref returns topic ARN. Source must explicitly use TopicArn to support exact narrowing; SMS/TargetArn/opaque input is manual. No endpoint ARN is fabricated. Encrypted topics may need KMS. |
| lambda / AWS::Lambda::Function | InvokeCommand/InvokeFunction in `@aws-sdk/client-lambda` | GetAtt Arn is unqualified. Source invocation retains the action but requires review for aliases/versions and runtime FunctionName; no `:*` qualifier wildcard is added. Template-only candidates are also evidence-limited to unqualified functions. |
| events / AWS::Events::EventBus | PutEventsCommand/PutEvents in `@aws-sdk/client-eventbridge` | GetAtt Arn for a bus, never a rule. Multiple buses and external bus resource policies need review. |
| secretsmanager / AWS::SecretsManager::Secret | GetSecretValueCommand/GetSecretValue in `@aws-sdk/client-secrets-manager` | Ref returns the actual full secret ARN with its generated suffix. No guessed six-character suffix/wildcard. KMS decrypt permissions may be needed separately. |
| ssm / AWS::SSM::Parameter | GetParameterCommand, GetParametersCommand, PutParameterCommand in `@aws-sdk/client-ssm` map to same-named actions | Partition/region/account-aware `parameter/path` ARN; handles leading slash without doubling it. Requires literal template Name. Dynamic/multiple names need review; SecureString can require KMS; tags on PutParameter can require AddTagsToResource. |
| kms / AWS::KMS::Key | EncryptCommand, DecryptCommand, GenerateDataKeyCommand in `@aws-sdk/client-kms` map to same-named actions | GetAtt Arn is a candidate only. Always manual because key policies, grants and encryption context affect access. |

The table/index distinction follows the [DynamoDB authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_dynamodb.html).
S3 request options can change permissions as documented in [S3 API permissions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html).
SNS target modes are distinguished by the [Publish API](https://docs.aws.amazon.com/sns/latest/api/API_Publish.html);
SSM conditional permissions are documented in the [SSM authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ssm.html).

Template references remain candidate resources, not a full analysis of command input
data flow. InfraLens cannot prove that runtime values point only to those resources.
Multiple compatible resources, multi-service statements, unsupported actions and
uncertain inputs do not produce an automatic replacement. Multi-service statements
are intentionally manual: identifying a service prefix alone cannot partition
runtime dependencies safely. Suggested current actions retain the full original list.

## Source analysis currently supports

- JS/TS/JSX/TSX/MJS/CJS syntax via the existing TypeScript compiler, now a runtime
  dependency of the analyzer. An in-memory compiler host performs no package or
  filesystem resolution, and never traverses node_modules.
- Named AWS SDK v3 imports, aliases, namespace imports, and literal CommonJS
  namespace/destructured requires, with lexical symbol identity. Imported symbols
  must actually occur in a supported `new` expression.
- Actual command-use line/column, original imported symbol, local alias, SDK
  package, action, file, Lambda mapping, handler root/import chain and confidence.
  Separate uses are retained; duplicate graph paths do not duplicate the same use.
- Relative imports, side effects, literal requires and relative re-exports across
  uploaded files. Shared/transitive/circular imports and normalized duplicate
  basenames retain the previous conservative mapping behavior. Type-only imports,
  comments and strings do not create runtime edges.
- Comments, quoted examples, local classes, shadowed bindings, non-AWS packages
  and commands from the wrong SDK package no longer infer AWS actions.

Dynamic imports, computed command selection, unresolved requires/imports, indirect
SDK bindings, syntax errors and opaque inputs produce limitations. Limitations
propagate across a Lambda's reachable source tree and block exact replacements;
recognized commands can still be shown with reduced confidence. No action is guessed
for an unrecognized dynamic command.

## Source analysis limitations

No Python/boto3, Java, Go, general package analysis, runtime dependency loading,
module alias resolution, generated-code reconstruction, full call graph, data flow,
or dead-code elimination. Constructor aliases routed through wrappers/re-exports
are not followed as SDK symbols. Literal dynamic `import()` is also conservative.
Missing source files and external helper packages can hide behavior. Explicit Lambda
mapping identifies the handler but does not prove the uploaded project is complete.
Source confidence is not a guarantee of complete runtime permission coverage.

The original `order-handler-source.ts` intentionally declares local mock classes;
it now correctly produces **no SDK actions**. Use `examples/analyzer-coverage` or the
existing shared-source/nested-source fixtures for real import-based inference.

## Regression verification and next gaps

Mocha/Chai tests cover each changed rule, condition subset/unknown cases, managed
attachments, external policies, boundaries, Deny, source false positives, aliases,
shared imports, S3 statement splitting/apply/staleness, table/index resource forms,
multi-service safety and the local API analyze/apply workflow. Prior mapping/path
assertions remain; older command-only fixtures now use actual imports where the
test's purpose is mapping. New syntax evidence is asserted independently.

Next correctness priorities: command input-to-resource data flow; safe propagation
through local SDK wrappers; qualifier/version-aware Lambda targets; conditional
resource references; resource-based policy evaluation and group inheritance at a
carefully limited level; more complete request-option/dependent-action semantics.
