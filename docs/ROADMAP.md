# InfraLens Production Roadmap

This document tracks recommended development order, not a fixed release commitment. Update it as
features land and priorities change.

## Completed Foundation: Protect The Hosted API

The first production release uses invited Cognito access, restricted CORS, request and concurrency
limits, REST API throttling, structured logs, alarms, and optional budget notifications. See the
[protected deployment guide](PRODUCTION_DEPLOYMENT.md).

## Priority 1: Test Complete User Workflows

- Cover Analyze -> Review -> Apply -> Compare as one integration workflow.
- Test source upload, explicit Lambda mapping, shared imports, report downloads, and API failures.
- Add deployed-route smoke tests without deploying from CI.

This should happen before large feature expansion so the current product behavior remains stable.

## Priority 2: Preserve Source Project Structure

- Preserve relative directory paths in the web upload flow.
- Handle duplicate file names safely.
- Make re-uploaded and replaced files obvious in the UI.
- Verify nested and transitive imports through the complete web/API workflow.

This removes a practical correctness gap in source-to-Lambda and shared-import inference.

## Priority 3: Validate Generated Templates

- Add stronger CloudFormation validation for analyzed and modified templates.
- Clearly separate parse success, analyzer success, and deployment validity.
- Validate generated templates before presenting them as ready to download.

## Priority 4: Deepen Analyzer Coverage Carefully

- Prioritize new rules from real example templates and user needs rather than rule count alone.
- Expand least-privilege metadata only when action/resource behavior can be represented safely.
- Improve awareness of IAM conditions, managed policies, and permissions boundaries.
- Reduce source-matching false positives before attempting broad language or package analysis.

## Priority 5: Add Product Persistence When Needed

- Add saved reports and projects only when users need history or collaboration.
- Design data retention and source-code handling before storing uploaded content.
- Add team and ownership concepts after the single-user workflow is stable.

## Not Near-Term Priorities

- PDF export
- Live AWS account scanning or AWS SDK integration
- Direct CDK, Terraform, or multi-language infrastructure parsing
- Attempting a perfect graph layout for every template

These may become useful later, but they should not delay API safety, workflow correctness, source
path handling, and analyzer reliability.
