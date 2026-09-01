# Shared Source Import Graph UI Example

This fixture demonstrates how AWS SDK actions in shared imported files contribute to the correct
Lambda least-privilege suggestions. The source files use realistic AWS SDK v3 imports so InfraLens
can verify command-package evidence. InfraLens reads these files as source input; the SDK packages
do not need to be installed unless the examples are executed independently.

## Test in the web UI

1. Open the Analyze page.
2. Upload `template.json` as the CloudFormation template.
3. Choose **Upload Source Files** and select all seven `.ts` files in this folder at once.
4. Select explicit Lambda mappings for the handler files:
   - `ordersHandler.ts` -> `OrdersFunction`
   - `auditHandler.ts` -> `AuditFunction`
   - `queueHandler.ts` -> `QueueFunction`
5. Select **Shared / not a Lambda handler** for:
   - `orderService.ts`
   - `sharedDb.ts`
   - `queueClient.ts`
6. Leave `unrelated.ts` on **Auto-detect** to verify that an unimported file is not assigned to a
   Lambda.
7. Click **Analyze** and inspect the least-privilege suggestions.

The files are flat because the current UI keeps each selected file's name rather than its directory
path. Their relative imports therefore resolve exactly as uploaded.

## Expected results

- `OrdersFunction` narrows `dynamodb:*` to `dynamodb:PutItem`.
- Its policy suggestion, SDK command, and Lambda mapping evidence are high confidence.
- Its evidence chain is `ordersHandler.ts -> orderService.ts -> sharedDb.ts`.
- `AuditFunction` also narrows `dynamodb:*` to `dynamodb:PutItem` because it directly imports the
  same shared database file.
- Its evidence chain is `auditHandler.ts -> sharedDb.ts`.
- `QueueFunction` narrows `sqs:*` to `sqs:SendMessage`.
- Its evidence chain is `queueHandler.ts -> queueClient.ts`.
- `dynamodb:DeleteItem` from `unrelated.ts` does not appear in any Lambda suggestion because no
  mapped handler can reach that file.
- `sharedDb.ts` and `queueClient.ts` do not receive IAM roles of their own.
