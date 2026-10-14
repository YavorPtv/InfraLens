# Compare Templates Fixture

Use these templates to test the Compare Templates UI, `POST /diff` API, or CLI diff flow.

`source-action-change.json` is a complete `POST /diff` request with an unchanged template and
independent old/new source trees at the same `src/handler.ts` path. GetCommand becomes PutCommand:
expect no resource/finding delta, a newly inferred `dynamodb:PutItem`, a `dynamodb:GetItem` no longer
observed, and a changed AppFunction/AppRole suggestion targeting OrdersTable. These are static
inferences, not changes to actual IAM permissions. See [source comparison](../../docs/SOURCE_COMPARISON.md).

## Files

- `old-order-service-template.json` is the baseline order service template.
- `new-order-service-template.json` represents a later revision with both fixes and regressions.

## Tiny Source Folders For Browser Upload

Each source folder contains one tiny file: a `// @ts-nocheck` directive and two lines of source,
matching the automated read-to-write example.
These snippets are analyzer inputs; they do not need to be run or have dependencies installed.

1. Open Compare Templates. Upload `source-action-template.json` as **both** Old Template and New Template.
2. Under **Old source context**, click **Upload source folder** and select `before/project`.
3. Under **New source context**, click **Upload source folder** and select `after/project`.
4. For high-confidence suggestions, set each file's mapping to **Explicit Lambda logical ID** and
   enter `AppFunction`. **Auto detect** also identifies this example's Lambda and shows the change,
   but its suggestions require manual review.
5. Click **Compare Templates**.

Select the inner `project` folders, so both uploaded paths are `project/src/handler.ts`:

```text
before/project/src/handler.ts   GetCommand (read)
after/project/src/handler.ts    PutCommand (write)
```

Expect zero resource changes and zero introduced/resolved findings. The source comparison shows
`dynamodb:GetItem` no longer observed and newly inferred `dynamodb:PutItem`. The AppFunction/AppRole
suggestion changes from GetItem to PutItem, targeting OrdersTable. Existing template findings remain
unchanged. The downloaded Markdown includes the same source/IAM delta.

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
- `SNS_TOPIC_ENCRYPTION_MISSING` on the removed `LegacyTopic`

Introduced findings:

- `IAM_WILDCARD_PERMISSIONS` on `ReportRole`
- `S3_PUBLIC_ACCESS_BLOCK_MISSING` on `UploadBucket`
- `S3_VERSIONING_DISABLED` on `UploadBucket`
- `API_GATEWAY_METHOD_NO_AUTH` on `PublicOrdersMethod`

## How To Try It

In the web app, open Compare Templates and paste the old template into the old template field and the new template into the new template field.

From the CLI:

```powershell
npm.cmd run diff -- examples\compare\old-order-service-template.json examples\compare\new-order-service-template.json
npm.cmd run diff -- --json examples\compare\old-order-service-template.json examples\compare\new-order-service-template.json
npm.cmd run diff -- --markdown examples\compare\old-order-service-template.json examples\compare\new-order-service-template.json
```
