# Partial IAM and real source coverage fixture

Analyze `template.json` with these uploaded files and explicit mappings:

- `files.ts` -> `FilesFunction`
- `query.ts` -> `QueryFunction`
- `fileService.ts`, `sharedStorage.ts`, `notAws.ts` -> Shared / not a Lambda handler

These are static-analysis fixtures, not deployment or runnable application examples.
`client` is intentionally supplied by the hypothetical application. Do not deploy
the template: it intentionally includes broad policies and an unscoped permission.

Expected behavior:

- FilesRole narrows `s3:*` to ListBucket on the bucket and GetObject on `bucket/*`
  in separate statements. Evidence follows files -> fileService -> sharedStorage;
  `ReadObject` is traced to the imported GetObjectCommand.
- QueryRole uses Query on OrdersTable plus `/index/ByCustomer`, never `/index/*`.
- ConditionRole retains its wildcard finding with understood condition evidence.
- FilesManagedPolicy is inspected and associated with ManagedRole.
- ExternalRole's AdministratorAccess ARN stays unresolved; its contents are not guessed.
- BoundedRole preserves its template boundary and attached explicit Deny evidence.
- The worker's existing function DLQ satisfies current `$LATEST` failure handling.
  FailedEvents is not required to have a second DLQ.
- UnscopedSnsPermission is reported; ScopedApiPermission is not.
- `notAws.ts` contributes no IAM actions despite its comment, string and local class.

See [analyzer coverage](../../docs/ANALYZER_COVERAGE.md) for exact semantics and limits.
