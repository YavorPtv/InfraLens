# Source-aware comparison

Milestone 1.5 adds independent source context to `POST /diff`, Compare uploads,
Apply navigation, saved-run comparisons and Markdown export. The CLI remains template-only.
The analyzer uses the same source inference implementation as ordinary analysis.

## Contract and limits

Existing `{ oldTemplate, newTemplate }` requests keep working. Optional `oldSource`
and `newSource` each contain `sourceFiles`, `sourceFileMappings` and
`sourceFileExclusions`, using the same project-relative path format as `/analyze`.
Identical paths on different sides are independent identities. Nothing is copied
from the opposite side. See [the request fixture](../examples/compare/source-action-change.json).

Default budgets (UTF-8 bytes, checked before analysis):

| Input | Limit |
| --- | --- |
| Each template / both templates together | 1 MiB / 2 MiB |
| Source files per side / both sides | 100 / 200 |
| Each source file | 256 KiB |
| Source bytes per side and both sides together | 2 MiB |
| Mappings / exclusions per side | 100 / 100 |
| Whole serialized request, including paths and metadata | 4 MiB |

Existing `INFRALENS_MAX_*` API settings apply. The combined source budget uses
`INFRALENS_MAX_COMBINED_SOURCE_BYTES`; the combined file-count budget is twice
`INFRALENS_MAX_SOURCE_FILES`. JSON escaping and metadata consume the request budget.
Two individually valid saved inputs can exceed the comparison budget together;
comparison returns 413 without truncating either tree.

## Comparison semantics and decision

Resource and finding deltas keep their existing template-based meaning. Additive
`source` and `suggestions` sections explain changes that do not alter those lists.
These fields and `AnalysisReport.sourceAnalysis` are optional in the shared types
so existing stored reports and clients remain readable. Current analysis emits them.

Source availability is `missing` when `sourceFiles` was omitted, and `provided`
when an object was supplied, including `{}`. Provided describes the input, not a
claim of complete code coverage. Reports carry inferred actions even if there is
no wildcard policy eligible for a least-privilege suggestion.

An action identity is Lambda ID (or unresolved), IAM action, file path and handler
root. A new identity is newly inferred; a disappearing identity is **no longer
observed**. Changes to confidence, command location, import evidence or limitations
are reported as changed evidence for the same identity. Unchanged evidence is
reported separately. Confidence distinguishes Lambda mapping from action inference.

Suggestion identities use Lambda, role, service and policy statement evidence path.
Comparison keeps complete before/after snapshots, including current and suggested
actions, resource candidates, partitioned statements, confidence, manual-review
reasons and source evidence. Added/removed suggestions refer to recommendations.

Preserving observations and snapshots avoids deriving effective permissions from
source. Static inference is incomplete. Missing source, unresolved attribution,
source warnings and IAM limitations are displayed with side labels. An action no
longer observed cannot prove a permission unused or a risk resolved. Comparison
never changes deployed permissions. Moving a statement to another evidence path
appears as removal/addition, rather than guessing its identity.

## UI and retention

Compare supports folder/files upload on each side using existing path normalization
and upload helpers. Each file has Auto detect, Explicit Lambda logical ID and Shared
helper choices. Shared excludes a file as a handler root; imported helper actions
can still contribute. Exact-path replacement keeps that side's mapping. Include
source tree distinguishes an empty uploaded tree from missing source.

Analyze stores its source context only in memory for Apply -> Compare. Applying a
template fix passes the same source context to both template sides. It does not
opt in to storage retention.

Saved comparison recomputes with the current analyzer from authorized retained
inputs. Source retention stays opt-in, including empty trees. Opening a saved run
returns its retained `input` only while unexpired; older `template` consumers still
work. Unretained runs expose only their template. Source is never reconstructed
from report evidence. History offers comparison of available inputs with missing
source labeled template-only, or a link to reupload on Compare. Results and Markdown
export show availability and warnings.

Seven-day expiry, ownership and deletion checks apply to each side and are rechecked
after artifact reads. Expired inputs return `INPUT_EXPIRED` and need reupload, while
the saved report stays readable. No new storage or infrastructure is required.

## Verification

The fixture changes GetCommand to PutCommand with an unchanged template. Mocha/Chai
suites cover action/suggestion/evidence deltas, missing/empty source, independent
mappings/exclusions, partial inference, shared export, Express/Lambda parity,
byte/count/path failures, Apply serialization and retained/absent/expired/deleted/
cross-owner history inputs. Ordinary tests require no AWS credentials. Manual browser
and hosted-test deployment verification remain separate authorized checks.
