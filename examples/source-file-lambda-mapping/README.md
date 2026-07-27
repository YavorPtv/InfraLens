# Source File Lambda Mapping Example

This fixture demonstrates two Lambda functions with separate source files:

- `OrdersFunction` uses `handlers/orders.ts` and infers `dynamodb:GetItem`.
- `QueuePublisherFunction` uses `handlers/publisher.ts` and infers `sqs:SendMessage`.

The template `Handler` values match the source file stems, so InfraLens can map files automatically.

To test through the API, start the API:

```powershell
npm.cmd run build --workspace @infralens/api
npm.cmd run start --workspace @infralens/api
```

Then send the template and source files:

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/analyze" -Method Post -ContentType "application/json" -InFile "examples\source-file-lambda-mapping\request.json" |
  ConvertTo-Json -Depth 30
```

Or build the request body from the individual files:

```powershell
$body = @{
  template = Get-Content -Raw examples\source-file-lambda-mapping\template.json
  sourceFiles = @{
    "handlers/orders.ts" = Get-Content -Raw examples\source-file-lambda-mapping\handlers\orders.ts
    "handlers/publisher.ts" = Get-Content -Raw examples\source-file-lambda-mapping\handlers\publisher.ts
  }
} | ConvertTo-Json -Depth 30

Invoke-RestMethod -Uri "http://localhost:3000/analyze" -Method Post -ContentType "application/json" -Body $body |
  ConvertTo-Json -Depth 30
```

If automatic matching is not possible, include explicit mappings from `source-file-mappings.json`:

```json
{
  "sourceFileMappings": {
    "handlers/orders.ts": "OrdersFunction",
    "handlers/publisher.ts": "QueuePublisherFunction"
  }
}
```

PowerShell example with explicit mappings:

```powershell
$body = @{
  template = Get-Content -Raw examples\source-file-lambda-mapping\template.json
  sourceFiles = @{
    "handlers/orders.ts" = Get-Content -Raw examples\source-file-lambda-mapping\handlers\orders.ts
    "handlers/publisher.ts" = Get-Content -Raw examples\source-file-lambda-mapping\handlers\publisher.ts
  }
  sourceFileMappings = Get-Content -Raw examples\source-file-lambda-mapping\source-file-mappings.json | ConvertFrom-Json
} | ConvertTo-Json -Depth 30

Invoke-RestMethod -Uri "http://localhost:3000/analyze" -Method Post -ContentType "application/json" -Body $body |
  ConvertTo-Json -Depth 30
```

Expected result:

- The Orders suggestion should narrow actions to `dynamodb:GetItem`.
- The QueuePublisher suggestion should narrow actions to `sqs:SendMessage`.
- The two suggestions should not mix actions from the other Lambda.
