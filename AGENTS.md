# InfraLens

## Project goal

InfraLens is a developer-focused AWS architecture analyzer.

It will parse CloudFormation/CDK templates, detect AWS security and reliability risks, build a resource graph, and generate evidence-based least-privilege IAM suggestions.

## Tech stack

- TypeScript
- React + Vite
- Node.js
- Mocha and Chai
- AWS CDK with TypeScript
- AWS Lambda/API Gateway later
- No Bootstrap unless explicitly requested

## Repository rules

- Use npm workspaces.
- Keep analyzer logic independent from React and AWS SDK.
- Core analyzer code belongs in packages/analyzer.
- Shared types belong in packages/shared.
- Frontend belongs in apps/web.
- CLI belongs in apps/cli.
- AWS infrastructure belongs in infra/cdk.
- Every analyzer rule must have unit tests.
- Every finding must include:
  - ruleId
  - title
  - severity
  - resourceId
  - explanation
  - evidencePath
  - suggestion

## Coding style

- Prefer small pure functions.
- Prefer readable code over clever abstractions.
- Do not add unnecessary dependencies.
- Do not make unrelated changes.
- Ask before changing the project structure.

## Testing

- Use Mocha and Chai for unit tests.
- Analyzer rules must have unit tests.
- Prefer simple, readable tests.
- Test files should be close to the code they test or inside a test folder.