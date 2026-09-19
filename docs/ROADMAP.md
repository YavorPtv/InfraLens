# InfraLens Production Roadmap

This document tracks recommended development order, not a fixed release commitment. Update it as
features land and priorities change.

Last refreshed: September 19, 2026. Verified against local `main` at `9c156f9`:
source project paths (#50), template validation (#51), and deeper analyzer coverage (#52) are merged.
This is implementation status, not confirmation of deployment or current CI results.

## Completed Foundation: Protect The Hosted API

The first production release uses invited Cognito access, restricted CORS, request and concurrency
limits, REST API throttling, structured logs, alarms, and optional budget notifications. See the
[protected deployment guide](PRODUCTION_DEPLOYMENT.md).

## Completed Foundation: Workflow Integration Tests

- Added 25 integration tests using real Express, Lambda adapter, analyzer, fix, diff, and export code.
- Covered Analyze -> Review -> Apply -> Compare -> Export, including selected fixes, original-template
  preservation, unrelated properties, resolved findings, and remaining findings.
- Covered source upload, explicit and automatic Lambda mapping, mapping confidence, shared and
  transitive imports, cycles, duplicate paths, and isolation between Lambda roles.
- Covered request validation and structured errors through both API adapters.
- Added opt-in deployed HTTP smoke tests and a manual GitHub Actions workflow. Smoke tests validate
  an existing deployment; CI does not deploy InfraLens.

Run `npm run test:integration` for the local workflow suite; it also runs under `npm test`.
See [Workflow testing](TESTING.md) for fixtures, commands, smoke configuration, and coverage limits.

## Completed Foundation: Preserve Source Project Structure

- Folder upload preserves relative directory paths through web helpers, API validation and analyzer.
- Duplicate basenames stay distinct; exact-path re-uploads visibly replace content and keep mappings.
- Shared path normalization rejects unsafe paths and API collisions while preserving request limits.
- Non-browser integration tests cover nested/transitive imports, shared helpers and full-path exports.

Ordinary file selection can still expose only basenames. See [Source project uploads](SOURCE_UPLOADS.md)
for supported behavior and remaining browser limitations.

## Completed Foundation: Template Validation

- Separate parsing, local structure checks, analyzer completion and optional AWS ValidateTemplate.
- Re-parse and validate generated artifacts; block invalid downloads while preserving inspectable output.
- Display original/generated results and explicit AWS unavailable states in UI and exports.
- Keep AWS SDK v3 in the API, with only ValidateTemplate permission in hosted Lambda IAM.
- Cover adapter mappings and generated regressions offline; no live AWS calls or deployment in tests.

See [Template validation](TEMPLATE_VALIDATION.md). Manual UI checks and hosted validation
verification remain; passing any validation does not guarantee deployment.

## Completed Foundation: Deeper Analyzer Coverage

- Track IAM conditions, template-defined policy attachments, managed policies, boundaries and
  relevant explicit-deny evidence. External policies remain unresolved; boundary intersection and
  complete effective-permission evaluation are not implemented.
- Use TypeScript syntax and lexical symbols for SDK commands, aliases and literal CommonJS imports;
  ignore comments, strings, local mock classes, shadowed bindings and wrong-package commands.
- Preserve command-use locations, import symbols, SDK packages, confidence and source limitations.
- Split S3 bucket/object permissions and require specific evidence for DynamoDB index ARNs.
- Add unscoped Lambda service-invocation detection and improve Lambda/SQS failure-target handling.
- Add realistic examples, regression tests, and report-level IAM/source limitations.

See [Analyzer coverage and evidence limits](ANALYZER_COVERAGE.md) and
[coverage examples](../examples/analyzer-coverage/README.md). The implementation task recorded
435 passing local tests, typecheck, build and production synthesis with no lookups. It did not
perform browser/E2E testing, live AWS calls or deployment; the PR was merged without waiting for CI.

## Priority 1: Make Source Evidence Easier To Review

- Display the existing `importedSymbol`, `localSymbol`, `sdkPackage`, `useLocation`, `indexAccess`
  and per-action `limitations` fields in the Source Inference panel. They are in report data but
  are not directly rendered there today; handler roots/import chains already are.
- Explain why a suggestion requires manual review using the associated uncertainty and evidence.
- Keep statement-level findings distinct from effective-access claims, and distinguish command
  confidence from source-to-Lambda mapping confidence.
- Verify the UI against `examples/analyzer-coverage`, including split statements and uncertain input.

## Priority 2: Extend Analyzer Accuracy From Concrete Use Cases

- Add bounded command-input-to-resource analysis and safe local SDK-wrapper propagation.
- Improve qualifier/version-aware Lambda targets and conditional resource references.
- Expand request-option/dependent-action coverage only with action/resource-specific tests.
- Consider limited resource-policy and group-inheritance support with explicit scope and evidence;
  a full IAM simulator is not implied by the current policy model.
- Prioritize real templates and false-positive reduction over rule count or broad language support.

## Priority 3: Add Product Persistence When Needed

- Add saved reports and projects only when users need history or collaboration.
- Design data retention and source-code handling before storing uploaded content.
- Add team and ownership concepts after the single-user workflow is stable.

## Ongoing Verification And Remaining Gaps

- Extend the existing unit and integration suites as product behavior changes. Keep normal CI
  running tests, typecheck, and builds without requiring a deployed environment.
- Configure `INFRALENS_SMOKE_API_BASE_URL` for an existing deployment and run the manual smoke
  workflow after hosted changes. A valid `INFRALENS_SMOKE_ACCESS_TOKEN` optionally enables a minimal
  authenticated analyze check; adding the suite alone does not verify a deployment.
- Browser upload controls, navigation, selection rendering, clipboard, and actual download clicks
  still need manual checks. Export content is covered by the automated workflow tests.
- Cognito sign-in, PKCE, token refresh, and browser sessions remain outside the new integration suite.
  The smoke suite checks public health and unauthenticated route rejection, with authenticated
  analysis optional; authenticated hosted apply/diff workflows remain a coverage gap.
- Compare still accepts templates only, without separate old/new source trees. Full CloudFormation
  deployment validation and runtime IAM completeness are not established by passing local tests.

## Not Near-Term Priorities

- PDF export
- Live AWS account scanning
- Direct CDK, Terraform, or multi-language infrastructure parsing
- Attempting a perfect graph layout for every template

These may become useful later, but they should not delay API safety, workflow correctness, source
path handling, and analyzer reliability.
