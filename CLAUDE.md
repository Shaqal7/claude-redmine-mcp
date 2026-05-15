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
