# Source project uploads

InfraLens uses a source file's normalized, case-sensitive project-relative path as its identity.
The web upload state stores `{ path, content }` plus mapping and upload-status fields. The existing
API format remains a map from paths to source text, with mappings and exclusions keyed by the same
paths. These shared types and normalization functions live in `packages/shared/src/sourceFiles.ts`.

## Files And Folders

On Analyze, **Upload Source Folder** lets the browser provide each file's `webkitRelativePath`.
InfraLens preserves this path, including the selected directory's name. Selecting a directory named
`project` containing `src/orders/handler.ts` produces `project/src/orders/handler.ts`. Select a common
ancestor directory containing all relevant handlers and shared helpers so their imports stay connected.

Folder upload reads supported `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` files. It skips other file
types and any `node_modules` or `.git` directories, and reports the skipped count. Source is analyzed
as text; uploaded code and its dependencies are not executed.

**Upload Source Files** remains available. If the browser supplies only `File.name`, InfraLens uses
that name and cannot recover the original parent directory. It never invents missing directories
or reads a machine-specific absolute path. Folder selection support depends on the browser; if it
does not supply relative paths, use the API with explicit relative paths for nested projects.

## Duplicate Names, Replacement, And Removal

- `src/orders/service.ts` and `src/payments/service.ts` are separate files, displayed with full paths.
- Re-uploading an exact normalized path replaces its content and displays **Replaced (mapping kept)**.
  The last file in an upload batch wins if the same path occurs twice. New paths display **Added**.
- Existing explicit/manual mappings and shared-file selections stay with an exact-path replacement.
  A different path starts with Auto-detect; mappings are never transferred by basename.
- Removing a file removes its mapping/shared selection with it. Re-uploading after removal adds a
  fresh entry with Auto-detect. Clear Files removes all files and their mapping state.
- When ordinary file selection exposes only identical basenames, the files have the same available
  identity and replacement applies. Use folder upload to distinguish their directories.
- Keep the same selected folder root when replacing files. Uploading an individual `handler.ts`
  does not replace `project/src/orders/handler.ts` because those are different paths.

## API Paths And Validation

`POST /analyze` keeps its existing request format; no array migration is required:

```json
{
  "template": "{ \"Resources\": {} }",
  "sourceFiles": {
    "src/orders/handler.ts": "import './service';",
    "src/orders/service.ts": "source text",
    "src/payments/service.ts": "different source text"
  },
  "sourceFileMappings": {
    "src/orders/handler.ts": "OrdersFunction"
  },
  "sourceFileExclusions": ["src/orders/service.ts", "src/payments/service.ts"]
}
```

Use actual Lambda logical IDs from your template. Shared exclusions mean “not a handler root”; an
excluded file can still contribute actions when a handler imports it.

All callers use the same identity rules: `\` becomes `/`, redundant separators and `.` segments are
removed, and internal `..` segments are resolved only within the project. Absolute paths, drive/URI
prefixes, control characters and traversal outside the project are rejected. Path case is preserved.
Invalid-path messages do not echo private machine prefixes.

API objects must contain unique path keys. Distinct keys that normalize to the same path (for
example `src\\handler.ts` and `./src/handler.ts`) are rejected with `400 INVALID_TEMPLATE`, as are
collisions in mappings or exclusions. The web helper performs visible replacement before serializing
one entry per path; the API does not guess which colliding request entry the user intended to keep.
Do not send repeated identical JSON property names: the JSON parser retains only the last value.

Source-file count, per-file byte size, combined source size, mapping/exclusion counts and total
request size limits remain enforced by the shared Express/Lambda request parser. Direct analyzer
source inference also normalizes paths and rejects unsafe/colliding identities.

## Mapping, Imports, And Evidence

Explicit mappings use the full normalized path and retain high mapping confidence. Automatic
Handler matches remain medium confidence; filename guesses remain low confidence. Paths do not
raise confidence by themselves. Full matches take precedence over a unique suffix match, which
allows a selected folder prefix such as `project/`. Ambiguous path or basename matches stay
unresolved; a known conflicting directory is not discarded to force a basename match.

Relative imports resolve against the importing file's directory. For example:

```text
src/orders/handler.ts
  -> ./services/orderService
src/orders/services/orderService.ts
  -> ../../shared/aws/dynamo
src/shared/aws/dynamo.ts
  -> PutCommand -> dynamodb:PutItem
```

The existing resolver supports source extensions and index files, transitive/shared imports,
cycle protection and evidence deduplication. Ambiguous extension matches, missing files, package
imports and paths escaping the project are not followed. It does not resolve TypeScript path aliases
or inspect `node_modules`. Only Lambdas whose uploaded import graphs reach a helper inherit its
actions; the helper gets no execution role of its own.

Reports, JSON/Markdown exports, and displayed source evidence retain full paths and import chains.
Separately uploaded source bodies are not included in reports or operation logs. Template properties,
including inline `Code.ZipFile`, remain part of analysis reports. Action inference still depends on
the completeness of uploaded files and the lightweight supported import/SDK patterns. Explicit
mapping associates a handler; it cannot restore missing import paths or missing helper files.

`POST /diff` still accepts templates only; it has no separate old/new source-project input.

See [the nested project fixture](../examples/nested-source-project/README.md) and
[Workflow testing](TESTING.md) for non-browser verification.
