# InfraLens Production Roadmap

This document tracks recommended development order, not a fixed release commitment. Update it as
features land and priorities change.

Last refreshed: September 9, 2026, with source-project path preservation implemented.

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

## Priority 1: Validate Generated Templates

- Add stronger CloudFormation validation for analyzed and modified templates.
- Clearly separate parse success, analyzer success, and deployment validity.
- Validate generated templates before presenting them as ready to download.

## Priority 2: Deepen Analyzer Coverage Carefully

- Prioritize new rules from real example templates and user needs rather than rule count alone.
- Expand least-privilege metadata only when action/resource behavior can be represented safely.
- Improve awareness of IAM conditions, managed policies, and permissions boundaries.
- Reduce source-matching false positives before attempting broad language or package analysis.

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
- Live AWS account scanning or AWS SDK integration
- Direct CDK, Terraform, or multi-language infrastructure parsing
- Attempting a perfect graph layout for every template

These may become useful later, but they should not delay API safety, workflow correctness, source
path handling, and analyzer reliability.
