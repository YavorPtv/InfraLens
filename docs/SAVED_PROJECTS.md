# Saved projects and analysis history

Saved projects are optional backend persistence. `POST /analyze`, `/diff`, `/apply`, and the CLI
remain stateless. The analyzer has no AWS dependencies. Use Projects in the web app to create a
project, open its history, and choose Analyze and save. Saved report URLs load from the API after
a fresh app session. Uploaded inputs go to the server; the browser cannot supply report JSON.

## Identity and API

REST API Gateway validates Cognito access tokens. The Lambda reads only
`requestContext.authorizer.claims.sub`, passes it as a transport-owned identity to the history
router, and builds every metadata key from that identity. Tokens are never decoded to manufacture
an identity in the handler. Body/query identities, report JSON, and object keys are rejected.
Missing claims fail with 401. Both explicit AWS targets require their own Cognito authorizer for
all history and analysis routes. There is no unauthenticated development stack. The persistent test
stack supports local React and deployed React, both using test Cognito. Local Express is not a
hosted authentication adapter. See [deployment separation](PRODUCTION_DEPLOYMENT.md).

| Method | Route | Behavior |
| --- | --- | --- |
| POST / GET | `/projects` | Create with `{name}` / list owner projects |
| PATCH / DELETE | `/projects/:projectId` | Rename with `{name}` / delete project and revoke children |
| POST / GET | `/projects/:projectId/runs` | Analyze and save / chronological history |
| GET / DELETE | `/projects/:projectId/runs/:runId` | Reopen report / revoke run and clean artifacts |
| GET | `/projects/:projectId/runs/:runId/artifacts/:artifact` | Authorized `report`, `markdown`, or retained `input` download |
| POST | `/projects/compare` | Compare `{oldRun: {projectId, runId}, newRun: {projectId, runId}}` |
| POST | `/projects/cleanup` | Retry owner-scoped physical deletion and discard expired pending saves |

Lists and cleanup accept `limit` (1–50, default 20) and `cursor`. Follow `nextCursor` even if a page
is empty: pending/deleted records do not appear, but still advance the underlying query. Runs sort
oldest first by server timestamp, then UUID. Each comparison reference is independently authorized;
the existing template-only diff engine is used. Expired inputs return 410 and require reupload on
Compare. API responses use `Cache-Control: no-store`; structured errors never include storage keys,
signed URLs, template contents or source contents.

Save body:

```json
{
  "input": {"template": "{\"Resources\":{\"Bucket\":{\"Type\":\"AWS::S3::Bucket\"}}}"},
  "idempotencyKey": "client-generated-retry-key",
  "retainSource": false
}
```

`input` also accepts the existing source files, mappings and exclusions. Save returns the server
report, public run metadata and the retained template. No owner or storage keys are returned.
The web client keeps only a request fingerprint and retry key in sessionStorage during a save,
not the submitted inputs. Successful saves clear that retry key. Fresh-session restoration fetches
the report by project/run URL and does not depend on surviving React state.

## DynamoDB keys and access patterns

Exactly two tables, on-demand capacity, encrypted, no GSIs. Strongly consistent GetItem/Query and
transactional conditional PutItem are the only backend metadata operations. No user-facing Scan.

| Table | Partition key `pk` | Sort key `sk` | Named access pattern |
| --- | --- | --- | --- |
| Projects | `OWNER#<sub>` | `OWNER` | Get/update owner quotas and private cursor encryption secret |
| Projects | `OWNER#<sub>` | `PROJECT#<server UUID>` | Query projects; get/rename/tombstone project |
| Projects | `OWNER#<sub>` | `IDEMPOTENCY#<SHA256(client key)>` | Get/conditionally reserve owner-wide retry key |
| Runs | `OWNER#<sub>#PROJECT#<project UUID>` | `RUN#<13-digit epoch ms>-<UUID>` | Chronological query and exact run lookup |

The public run ID includes the timestamp and UUID, so lookup needs no secondary index. Every item
has a version. Transactions compare the versions read, or require absence for new records. Save
reservation updates project and owner counters with the run and idempotency item atomically.
Publication conditionally updates the project as well as the run, serializing against deletion.
Conflict retries are bounded. Owner counters include pending saves and are released on logical
deletion. Deleted project cleanup releases remaining child counters as it progresses.

Cursors are AES-256-GCM encrypted/authenticated using a random 256-bit owner secret stored in the
owner record. Authenticated additional data binds the Cognito sub and project (or list purpose).
They expire after one hour. Neither plain JSON nor base64 DynamoDB keys are exposed. No cursor
table/index or externally configured signing secret is needed; the secret survives Lambda restarts.

## Saves, retries and failures

1. Validate/normalize input and compute SHA-256 over canonical input, project and source-retention
   preference. Object property order is irrelevant; template/source text changes are significant.
2. A completed matching retry returns the same run. A reused key with different input or project
   returns 409. Users can independently reuse identical keys. A deleted run's key returns 410.
3. Analyze on the server, then transactionally reserve a pending run, its artifact manifest and
   owner-scoped idempotency item. Pending runs never appear in normal history or artifact APIs.
4. Write report JSON, Markdown and retained input to private S3 using server-generated keys.
5. Publish completed metadata in a conditional transaction; only then return success.

The two-minute pending lease exceeds the hosted Lambda's hard 30-second lifetime. Concurrent
duplicate requests may receive 409 while one save is pending; retry the same key and input. After
the lease, a retry cleans the previous manifest and uses a fresh attempt prefix for the same run.
Publication checks the attempt, lease and project state. Do not increase the Lambda timeout beyond
this lease without updating the recovery protocol. Local memory mode is for development, not a
multi-process durable server with unbounded invocation lifetimes.

A failed S3 write or unpublished metadata write leaves no visible successful run. The manifest is
committed before the first object, including objects whose write response may have been lost. If
a publication response is lost, artifacts are **not** removed: publication may have committed.
A retry reads the completed run. Failed or timed-out pending attempts are cleaned on retry or by
explicit cleanup. Cleanup is resumable and bounded (one page of 25 run records per project per call).
Each project's cleanup checkpoint is persisted, including across pages of already-cleaned tombstones.
Follow cleanup pagination and repeat while `cleanupPending` is true; wait for pending leases first.
There is no automatic background janitor in this milestone. An inactive owner with an abandoned
save can retain orphan artifacts until maintenance is invoked. Operators can use the same service
cleanup method with an explicitly known owner; do not remove manifests before artifact deletion.

Idempotency records remain as small tombstones, bounded by a separate lifetime key quota, so a very
late retry cannot silently create a second run. Cleaned run tombstones receive DynamoDB TTL after
30 days. Active reports have no TTL. Project tombstones remain available for cleanup discovery.

## S3, retention and deletion

Keys: `owners/<encoded-sub>/projects/<project>/runs/<timestamp-UUID>/<attempt-UUID>/report.json`,
`report.md`, and `input.json`. No key is accepted from the client. The bucket blocks public access,
uses SSE-S3 encryption and requires TLS. Input objects have `retention=input` tags and a seven-day
lifecycle; report objects have `retention=report` and remain until deletion.

Raw template input is retained for seven days. Uploaded source files, mappings and exclusions are
retained only with `retainSource: true`. The returned metadata and UI show source retention, input
expiry and byte count. Reports themselves retain derived evidence/resource properties; input expiry
does not redact already produced reports. Reanalysis/source inference requires reupload if source
was not retained. At expiry, API input access and comparison are denied regardless of eventual S3
lifecycle cleanup. Lifecycle and DynamoDB TTL are storage cleanup mechanisms, never authorization.

Deletion first tombstones metadata transactionally, immediately blocking subsequent API reads,
new download links and new runs under a deleted project. Artifact removal is retried using the
manifest. Uploads already in flight are allowed to reach the invocation boundary before cleanup,
preventing a late upload from recreating a deleted object after cleanup. Repeating DELETE is safe.
Use Retry cleanup in Projects to resume failures, including deleted projects no longer in lists.

Download links last at most 60 seconds (shortened to input expiry). They are never public object
URLs and are not logged. Previously issued links are bearer capabilities and cannot be instantly
revoked by a metadata tombstone; physical deletion or the short signature expiry closes them.
Similarly, a read already in flight can finish before deletion. The API rechecks ownership/state
after reading artifacts or signing. Local memory mode returns contents through the same authorized
endpoint instead of inventing an S3 URL.

## Quotas and configuration

| CDK context / service quota | Default | Environment variable |
| --- | ---: | --- |
| `projectsPerUser` | 20 | `INFRALENS_QUOTA_PROJECTS_PER_USER` |
| `runsPerProject` | 100 | `INFRALENS_QUOTA_RUNS_PER_PROJECT` |
| `runsPerUser` | 500 | `INFRALENS_QUOTA_RUNS_PER_USER` |
| `retainedInputBytes` | 3 MiB per run | `INFRALENS_QUOTA_RETAINED_INPUT_BYTES` |
| `saveKeysPerUser` | 10,000 lifetime reservations | `INFRALENS_QUOTA_SAVE_KEYS_PER_USER` |

Existing template/source/request limits still apply. Quotas reject explicitly; they never silently
evict reports. Integer quotas must be 1–100,000; the input byte quota must be 1 byte–4 MiB. The lifetime
idempotency quota does not reset on deletion; an operator can raise it within the bounded maximum.

Test and production tables/buckets use RETAIN; production tables have point-in-time recovery.
Keep the test stack deployed between runs. Retained resources require separate intentional cleanup,
and S3 requires emptying before bucket deletion (no privileged auto-delete custom resource).
No broad DynamoDB/S3 permissions are granted to the application Lambda. Lambda can GetItem,
Query and transactional PutItem on the two tables, and GetObject/PutObject/PutObjectTagging/
DeleteObject under the bucket's `owners/*` prefix. The bucket is separate from frontend hosting.

## Local development and verification

The credential-free memory adapter persists across browser sessions while the API process lives;
it intentionally resets when that process restarts. Explicit local configuration in PowerShell:

```powershell
$env:INFRALENS_ENVIRONMENT = 'development'
$env:NODE_ENV = 'development'
$env:INFRALENS_HISTORY_ADAPTER = 'memory'
$env:INFRALENS_LOCAL_OWNER = 'local-developer'
$env:INFRALENS_CLOUDFORMATION_VALIDATION = 'false'
npm.cmd run build
npm.cmd start --workspace @infralens/api
```

That configuration binds Express to loopback. Neither headers nor body fields choose the fake
identity. Production/Lambda rejects local identity/memory configuration. AWS mode requires
`INFRALENS_HISTORY_ADAPTER=aws`, `INFRALENS_PROJECTS_TABLE`, `INFRALENS_RUNS_TABLE` and
`INFRALENS_ARTIFACT_BUCKET`; CDK wires these automatically. Do not mix local fake identity with AWS
storage. Tests inject a service/identity explicitly and run without AWS credentials.

```powershell
npm.cmd run typecheck
npm.cmd run test
npm.cmd run build
npm.cmd run test:integration
npm.cmd run synth --workspace @infralens/cdk -- --target test
npm.cmd run synth --workspace @infralens/cdk -- --target production
```

No browser/frontend server is needed for these checks. The non-browser workflow suite uses the
actual shared frontend client/restoration helper against the Lambda API contract with empty state.

### Persistent AWS test checks

The user reports successful deployment of InfraLensTestStack in account 230944684535, eu-central-1.
The ignored infra/cdk/cdk-outputs.test.json contains its resource identifiers and Cognito configuration.
The stack stays deployed between runs; tests use temporary data and never create/destroy infrastructure.

The live suites now use the guarded root commands documented in [Testing](TESTING.md#persistent-aws-test-workflows).
They derive API URL/table/bucket names from validated outputs. Data-writing modes require a named profile,
matching region/stack, --allow-test-data true, verified STS account and fresh CloudFormation outputs.
The old INFRALENS_DISPOSABLE_AWS and manual resource variables are no longer accepted.

Hosted tests are separate from direct storage tests. They need two distinct dedicated Cognito users'
current access tokens through INFRALENS_TEST_USER_A_TOKEN and INFRALENS_TEST_USER_B_TOKEN. API Gateway
verifies authentication; local token checks only validate configuration. Project deletion is limited to
the project created by the test and preserves pending cleanup metadata. Tombstones may remain.

Direct SDK tests require a later scoped storage-test identity, including test-table DeleteItem for
metadata cleanup and artifact access limited to the test bucket/owner namespaces. The deployment profile
does not grant those rights; the Lambda role must not be broadened to satisfy tests. Independent fixtures
make tests individually runnable. Failed artifact cleanup must preserve its manifests and metadata.

Current verification is offline code/configuration testing plus the user's reported deployment.
No live suite or browser test ran during this refactor. Actual storage permissions, both frontend
logins and hosted cross-user isolation require a later explicitly authorized run after user/profile setup.
