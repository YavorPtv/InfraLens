# InfraLens Order Service Demo Report

`examples/order-service-risky-template.json` is a deliberately risky CloudFormation template for CLI and UI demos. It models a small public order service with API Gateway, Lambda, IAM, DynamoDB, SQS, and CloudWatch Logs resources.

## Expected Findings

- `API_GATEWAY_METHOD_NO_AUTH` on `OrderPostMethod`: the API Gateway method explicitly sets `AuthorizationType` to `NONE`.
- `IAM_WILDCARD_PERMISSIONS` on `OrderHandlerRole`: the Lambda execution role allows `dynamodb:*` on `Resource: "*"`. When public reachability connects the API to the Lambda and role, this finding should be adjusted to `critical`.
- `SQS_MISSING_DLQ` on `OrderEventsQueue`: the queue has no `RedrivePolicy`.
- `DYNAMODB_MISSING_PITR` on `OrdersTable`: point-in-time recovery is not enabled.
- `LOG_GROUP_MISSING_RETENTION` on `OrderHandlerLogGroup`: the log group does not set `RetentionInDays`.

## Expected Graph Signals

- `OrderApi` should be detected as a public entry point because it is an `AWS::ApiGateway::RestApi`.
- Runtime architecture edges should include `OrderPostMethod` invoking `OrderHandler` and `OrderHandler` using `OrderHandlerRole`.
- Raw reference edges should show the Lambda referencing `OrdersTable` and `OrderEventsQueue` through environment variables.
- Public reachability should include the API, Lambda function, execution role, and resources referenced by the Lambda.

## Expected Least-Privilege Suggestion

The analyzer should produce a high-confidence suggestion for the broad DynamoDB policy on `OrderHandlerRole` because:

- `OrderHandler` uses `OrderHandlerRole`.
- The role policy allows `dynamodb:*` on `Resource: "*"`.
- `OrderHandler` references exactly one DynamoDB table: `OrdersTable`.

The suggested replacement resource should be:

```json
{
  "Fn::GetAtt": [
    "OrdersTable",
    "Arn"
  ]
}
```

## Demo Commands

```powershell
npm.cmd run analyze -- examples\order-service-risky-template.json
npm.cmd run analyze -- --json examples\order-service-risky-template.json
```
