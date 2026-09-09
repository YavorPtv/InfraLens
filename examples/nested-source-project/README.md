# Nested source project fixture

Analyze `template.json`, then upload this directory with **Upload Source Folder**. The browser keeps
the selected `nested-source-project/` prefix. Handler inference accepts the unique suffixes declared
in the template. To enable high-confidence action narrowing, explicitly map:

| Source path (relative to this directory) | Lambda |
| --- | --- |
| `src/orders/handler.ts` | `OrdersFunction` |
| `src/payments/handler.ts` | `PaymentsFunction` |
| `src/audit/handler.ts` | `AuditFunction` |

Expected source actions:

- Orders: `dynamodb:PutItem` through `services/orderService.ts` and `shared/aws/dynamo.ts`, plus
  `dynamodb:UpdateItem` from `orders/service.ts`, scoped to `OrdersTable`.
- Audit: `dynamodb:PutItem` through the shared DynamoDB helper, scoped to `OrdersTable`.
- Payments: `sqs:SendMessage` from `payments/service.ts`, scoped to `PaymentsQueue`.
- `unrelated/cleanup.ts` has a delete command but no handler imports it, so it contributes no
  Lambda policy evidence.

The repeated `handler.ts` and `service.ts` basenames must remain distinct. The shared DynamoDB helper
deliberately imports `orderService.ts` to form a cycle; Orders also reaches that service by two paths.
Each Lambda/action/file combination should still have one evidence entry. Automatic handler mapping
retains medium confidence and leaves action narrowing for manual review.

The API integration suite runs the real web transformation/serialization helpers with browser-like
file objects, then calls Express and the Lambda adapter. The fixture is never executed or deployed;
SDK clients in its source are illustrative and SDK packages need not be installed.
