# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build              # tsc -p tsconfig.json → dist/
npm run dev                # tsx src/index.ts (stdio server, no build needed)
npm start                  # node dist/index.js (requires prior build)
npm test                   # vitest run (one-shot, no watch)
npx vitest run test/service.test.ts                       # single file
npx vitest run -t "builds a dry-run chain"                # single test by name
npx tsc --noEmit           # type-check without emit (use to verify changes)
```

The MCP server speaks stdio — running it directly from a shell is mostly useful for confirming it starts; real exercise happens via Claude Code with `.mcp.json` pointing at `dist/index.js`. Rebuild (`npm run build`) after every source change before Claude Code reconnects.

## Architecture

The codebase is a deliberately narrow Redmine integration layered as a request pipeline:

```
McpServer (src/index.ts)
  → tool-handlers.ts        (zod-validated input → JSON CallToolResult, error formatting)
    → service.ts            (RedmineService: business logic, policy enforcement, normalization)
      → redmine/client.ts   (HTTP, caching of projects/statuses/current user)
      → redmine/policy.ts   (ProjectPolicy: allowlist gate on every issue read)
      → redmine/normalize.ts (Redmine payload → NormalizedIssueSummary/Detail)
```

Key invariants — preserve these when adding tools or editing the service:

- **Every issue fetched must pass `ProjectPolicy.assertProjectAllowed`.** This is centralized in `RedmineService.getAuthorizedIssue` (in `src/service.ts`). Never call `client.getIssue` directly from a public service method; always go through `getAuthorizedIssue` so allowlist enforcement is uniform.
- **Mutating writes verify persistence.** `updateIssueStatus`, `assignIssue`, and `resolveIssueWithNote` re-fetch the issue after `client.updateIssue` and assert the change took effect, throwing `UPSTREAM_ERROR` otherwise. Redmine silently ignores some patches (e.g. status not in workflow), so the read-after-write is load-bearing.
- **Status and assignee resolution is name-tolerant.** `client.getStatus` and `service.resolveProjectMember` accept ID, name, or `"me"` and do exact + fuzzy matching, throwing `VALIDATION_ERROR` on ambiguity. Don't bypass these helpers.
- **No generic Redmine bridge.** Each tool exposes a narrow shape. Resist the temptation to add a passthrough — the whole point of this server is to constrain what the model can do.

### `search_issues`

Primary path is Redmine's search engine, called **per allowed project** (`/projects/{identifier}/search.json?issues=1`) so the allowlist stays enforceable — the global `/search.json` would leak other projects. Hits are hydrated in one batch via `/issues.json?issue_id=a,b,c` (which also applies status/assignee filters), and every hit is re-checked with `isIssueProjectAllowed` because project search includes subprojects. Result order follows Redmine's search order. Only a `NOT_FOUND` from the search endpoint triggers the legacy `scanRecentIssues` fallback (`mode: "scan"`, 100 most recent issues, subject+description only).

### `update_issue_note` / `delete_issue_note`

Use `PUT /journals/{id}.json` (Redmine 5.0+). The journal must belong to the given issue (checked against `getAuthorizedIssue` journals, so the allowlist applies) and must carry note text. Delete = blank notes; Redmine removes a journal that has no field changes left. Both re-fetch and verify, since Redmine silently ignores edits without the edit-notes permission.

### `resolve_related_test_chain`

This is the most complex tool. It traverses `test → same_project_issue → external_issue` via issue relations:

1. Loads the test issue, finds **exactly one** non-test related issue in the same project.
2. From *that* same-project issue's relations (not the test's), finds **exactly one** related issue in a project listed in `REDMINE_DEFAULT_EXTERNAL_PROJECTS` (or the `external_projects` param if given).
3. Defaults to `dry_run=true`. On `dry_run=false`, updates all three issues sequentially with the same note and status (`"Rozwiązany"` by default).

The updates are **not atomic**. The for-loop in `resolveRelatedTestChain` catches per-step failures and rethrows `UPSTREAM_ERROR` listing which issues were already updated before the failure — surface this state in any new chain-like tool too.

The external issue must be reachable from the same-project issue, **not directly from the test issue**. This is by design — if the topology assumption changes, the description in `src/index.ts` must change too.

### File attachments (`attach_file_to_issue`, `attach_file_to_test_chain`)

Redmine attachments are a two-step flow: `POST /uploads.json` with raw bytes + filename in querystring → token, then `PUT /issues/{id}.json` with `uploads: [{ token, filename, content_type }]`. **Tokens are single-use** — for the chain variant we upload separately for each target.

- `file_path` is read on the MCP server's filesystem via `fs/promises.readFile` (injected as `readFileImpl` for testability). The server has no remote upload — the user must place the file where the server can see it. In Docker, that means a volume mount.
- Content type is detected from extension via `CONTENT_TYPE_BY_EXTENSION` in `src/service.ts`, fallback `application/octet-stream`.
- `attach_file_to_test_chain` reuses the same chain traversal as `resolve_related_test_chain` (test → same-project → external) but **only attaches to test + external**. The same-project issue is required for topology resolution but not modified.
- `resolve_chain_with_attachment` is the combined variant: one PUT per chain issue carrying `{ status_id, notes, uploads }` so each of the three issues gets a single journal entry (status change + note + attachment together). All three chain issues receive the attachment in this variant. The chain traversal is shared via the `findTestChain` helper in `src/service.ts`.

### `download_attachment`

Read-only (nothing is written to Redmine). The issue is loaded through `getAuthorizedIssue` (allowlist → the same `POLICY_ERROR` as `get_issue`), and the attachment id must be in that issue's `attachments` (`NOT_FOUND` otherwise, with the ids that are there) before anything is downloaded. Redmine's `filesize` over `MAX_DOWNLOAD_BYTES` (10 MB) is refused up front; the client also checks `Content-Length` and stops reading a body that grows past the limit. A download gets `max(REDMINE_TIMEOUT_MS, 60 s)`, body included.

- `client.downloadAttachment` sends the API key header only to `REDMINE_BASE_URL`: a `content_url` on another origin, on plain http or outside the base path is replaced by `{base}/attachments/download/{id}`. Redirects are not followed (`redirect: "manual"`; fetch keeps custom headers on a cross-origin redirect); a redirect to `/login` is `AUTH_ERROR`. The key is never in a URL, result or error.
- An image block the API rejects breaks the model's whole conversation, so `inspectImage` decides from the bytes, not from Redmine's label: PNG/JPEG/GIF/WebP magic number, at most `MAX_INLINE_IMAGE_BYTES` (3 750 000 B = 5 000 000 base64 characters, the Bedrock/Vertex limit; the Claude API allows 10 MB), pixel size from the header at most 8000 px per side (the API limit), and the end marker present (PNG `IEND`, GIF trailer, WebP RIFF size; a JPEG is walked segment by segment and through its scan data to `FF D9`, so data appended after the end, e.g. by phones, is ignored). Pixels are not decoded, so damage in the middle of a file is not caught. Anything that fails is saved as a file and `note` says why. A passing image goes back as MCP `image` content next to a JSON text block; the handler (`handleToolContent` in `tool-handlers.ts`) moves `image` out of the JSON.
- Everything else, a larger image, or any image when `save_dir` is given, is written as `<id>-<sanitized name>` (`redmineStoredFilename` + control characters, cut to 200 UTF-8 bytes keeping the extension, no trailing dot or space) under `save_dir` or `os.tmpdir()/redmine-mcp-attachments`, with `flag: "wx"`: an identical existing file is reused, a different one is left untouched (`VALIDATION_ERROR`). File contents never go into the result.
- The name and bytes come from Redmine users and `save_dir` from the model, so `prepareSaveDirectory` only allows an absolute `save_dir` strictly inside `os.tmpdir()`. It compares realpaths (the nearest existing ancestor before `mkdir`, the folder itself after), so `..`, junctions and symlinks cannot escape, and `lstat`s every folder below the temp root (the existing ones before `mkdir`, all of them after): no link, and on POSIX (`/tmp` is shared) owned by this user and not writable by group/others, so a folder shared with other users is refused before `mkdir` and nobody else can swap a checked folder before the write. Residual (KB-25): on a shared POSIX `/tmp`, another user can still race a link in for the first missing folder directly under the root, or retarget a link inside `save_dir`, so `mkdir` may create empty folders outside temp; the post-check then refuses, and no bytes are written. Folders are created `0700`, files `0600`, and the file is written into the verified real path (so `saved_to` is the long, real path). Any folder of this user under temp is accepted (on Windows every one, as TEMP is per-user), including other programs' working folders; narrowing that to a configured root is a separate decision. Do not widen this.

### `create_issue`

`POST /issues.json` into one allowed project, then `POST /issues/{id}/relations.json` when `related_issue_id` is given. Order of checks: project allowlist (`resolveProject`) → related issue through `getAuthorizedIssue` → metadata reads → write, so a policy rejection never leaves a created issue behind.

- Metadata: `GET /projects/{id}.json?include=trackers,issue_custom_fields` (either list may be missing on an old Redmine: trackers then fall back to global `/trackers.json`, custom fields then accept numeric IDs only), `/enumerations/issue_priorities.json`, and `/custom_fields.json` for required fields. The last one is **admin-only** (the live key gets 403), so `required_custom_fields.known` is normally `false` and Redmine's 422 on create is the real check.
- Tracker, priority and custom field names go through `matchNamedRef` (ID or name, case-insensitive, names trimmed — Redmine has `"Ważność "` with a trailing space; exact, then unique substring; ambiguity = `VALIDATION_ERROR`). A numeric reference matches IDs only. Without `tracker` no `tracker_id` is sent: Redmine's default is the first tracker the user's **role** may add issues for, which the API does not expose (the project's tracker list is not filtered by role), so the preview shows `tracker: null` plus a note and the result reports the tracker Redmine chose. An explicit `tracker_id` the role may not use is **silently replaced** by Redmine (`Issue#safe_attributes=`), not rejected — only the read-after-write catches it. The `is_default` priority is sent explicitly.
- `attachments` (KB-14): local file paths read with `readAttachment` **before any Redmine call** (missing, empty or blank path, or two names equal apart from letter case = `VALIDATION_ERROR`). Names go through `redmineStoredFilename` (Redmine's `sanitize_filename`, including its cut at the last `\` or `/`, which matters on a POSIX host), so the preview shows the name Redmine stores. For bmp/gif/jpg/jpe/jpeg/png/webp the preview adds `embed`, the Textile that shows the image in the description: everything but `[A-Za-z0-9-_.~]` is percent-encoded, because Redmine `CGI.unescape`s the src (`+` becomes a space) and Textile ends the src at `(`, `!` or a space. The embed must start a line or follow whitespace (Textile's image regex); glued to `(` or `:` it stays plain text. On `dry_run=false` each file is uploaded (one token per file) **before** the POST and the tokens go into the same `POST /issues.json` as `uploads`. A create opens no journal, so the files are simply on the issue from the start; a bad or used token makes Redmine reject the create with 422. An upload failure keeps its error code and details and says no issue was created.
- After the POST the issue is re-read and project, tracker, priority, subject and every given custom field are compared — Redmine silently drops custom fields not enabled for the tracker. A wrong project, tracker or subject stops before the relation; a dropped priority, custom field or attachment (uploaded filename not on the issue) is reported only after the relation was added (it is fixable in place). With readable field definitions (admin keys) a given field not enabled for the tracker is rejected before the POST. Every such failure throws `UPSTREAM_ERROR` with `details: { issue_id, url, failed_step }`: the issue **exists**, and the message tells the model not to retry (it would duplicate). An `UPSTREAM_ERROR` from the POST itself (timeout, 5xx) is rewrapped as "outcome unknown, check before retrying"; 422/403 pass through unchanged (nothing was created).

## Configuration (required env)

| Var | Notes |
|---|---|
| `REDMINE_BASE_URL` | Base URL including subpath; trailing slashes stripped at load |
| `REDMINE_API_KEY` | Personal API key |
| `REDMINE_ALLOWED_PROJECTS` | CSV of identifiers/IDs — global allowlist enforced on every issue read |
| `REDMINE_DEFAULT_EXTERNAL_PROJECTS` | CSV — defaults for `resolve_related_test_chain`. Every entry must also be in `REDMINE_ALLOWED_PROJECTS` (validated at startup) |
| `REDMINE_TIMEOUT_MS` | Optional, default 15000 |

Config validation is centralized in `src/config.ts` — add new env vars there with explicit error messages, not silent defaults.

## Tests

Vitest with no global setup. Tests construct `RedmineService` directly with a hand-rolled mock client (`vi.fn()` for each method actually exercised). See `test/service.test.ts` for the pattern — mock only what the code path touches; the test fixture for `resolveRelatedTestChain` is a good reference for the expected relation topology.

When adding a new tool, expand `test/tool-handlers.test.ts` to confirm error responses set `isError: true` and serialize via `formatError`.

## Error model

All thrown errors should be `RedmineMcpError` (from `src/errors.ts`) with a `code` of `AUTH_ERROR | NOT_FOUND | VALIDATION_ERROR | POLICY_ERROR | UPSTREAM_ERROR`. `tool-handlers.ts` formats these into structured JSON with `isError: true`. Plain `Error` throws fall through as `UPSTREAM_ERROR` with the raw message — prefer typed errors so the model gets a usable `code`.
