# Compare Templates Fixture

Use these templates to test the Compare Templates UI, `POST /diff` API, or CLI diff flow.

## Files

- `old-order-service-template.json` is the baseline order service template.
- `new-order-service-template.json` represents a later revision with both fixes and regressions.

## Expected Diff

Added resources:

- `OrderDeadLetterQueue`
- `OrdersApi`
- `OrdersResource`
- `PublicOrdersMethod`
- `ReportRole`
- `UploadBucket`

Removed resources:

- `LegacyTopic`

Changed resources:

- `OrdersTable`, because PITR was enabled.
- `OrderQueue`, because a dead-letter queue redrive policy was added.
- `OrderLogGroup`, because log retention was added.

Resolved findings:

- `DYNAMODB_MISSING_PITR` on `OrdersTable`
- `SQS_MISSING_DLQ` on `OrderQueue`
- `LOG_GROUP_MISSING_RETENTION` on `OrderLogGroup`

Introduced findings:

- `IAM_WILDCARD_PERMISSIONS` on `ReportRole`
- `S3_PUBLIC_ACCESS_BLOCK_MISSING` on `UploadBucket`
- `API_GATEWAY_METHOD_NO_AUTH` on `PublicOrdersMethod`

## How To Try It

In the web app, open Compare Templates and paste the old template into the old template field and the new template into the new template field.

From the CLI:

```powershell
npm.cmd run diff -- examples\compare\old-order-service-template.json examples\compare\new-order-service-template.json
npm.cmd run diff -- --json examples\compare\old-order-service-template.json examples\compare\new-order-service-template.json
npm.cmd run diff -- --markdown examples\compare\old-order-service-template.json examples\compare\new-order-service-template.json
```
