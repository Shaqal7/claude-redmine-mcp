# Claude Redmine MCP

Local MCP server for Claude Code that exposes a narrow, issue-focused Redmine integration over stdio.

## Features

- `list_issues` — compact issue summaries for one allowed project
- `search_issues` — full-text search across subjects and descriptions
- `get_issue` — normalized detail with journals, relations, and custom fields
- `add_issue_note` — append a note (requires user confirmation)
- `update_issue_status` — change issue status with validation
- `assign_issue` — reassign to a project member
- `resolve_related_test_chain` — resolve a test issue plus its same-project related issue and one external related issue with the same note (defaults to `dry_run=true`; not atomic — partial failures are surfaced)
- `attach_file_to_issue` — upload a local file to one issue, optionally with a note (file is read from the MCP server's filesystem)
- `attach_file_to_test_chain` — upload the same file to the test issue and its related external issue, with the same note on both (same-project issue is not touched; defaults to `dry_run=true`; not atomic — partial failures are surfaced)

The server is intentionally opinionated:

- only works against projects listed in `REDMINE_ALLOWED_PROJECTS`
- returns normalized issue context instead of raw Redmine payloads
- validates status and assignee updates before mutating
- never exposes a generic `redmine_request` bridge

## Requirements

- Node.js 18+ (or Docker)
- Redmine instance with REST API enabled
- A personal Redmine API key
- Claude Code with local MCP support

## Quick start

```bash
git clone <repo-url> && cd claude-redmine-mcp
npm install
cp .env.example .env        # edit with your Redmine credentials
cp .mcp.json.example .mcp.json  # edit with your Redmine credentials
npm run build
```

## Docker

Build the image:

```bash
docker build -t redmine-mcp .
```

Run via stdio (pass your Redmine credentials as environment variables):

```bash
docker run -i --rm \
  -e REDMINE_BASE_URL=https://redmine.example.com/redmine \
  -e REDMINE_API_KEY=your-api-key \
  -e REDMINE_ALLOWED_PROJECTS=project1,project2 \
  -e REDMINE_DEFAULT_EXTERNAL_PROJECTS=project2 \
  redmine-mcp
```

### Docker MCP Toolkit

This server is available in the [Docker MCP Catalog](https://hub.docker.com/mcp). To use it with Docker Desktop:

```bash
docker mcp server enable redmine-mcp
docker mcp gateway run
```

## Environment variables

| Variable                            | Required | Description                                                                                                                                                                          |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `REDMINE_BASE_URL`                  | yes      | Full base URL of your Redmine instance, including subpath if any (e.g. `https://redmine.example.com/redmine`)                                                                        |
| `REDMINE_API_KEY`                   | yes      | API key for the Redmine user running the integration                                                                                                                                 |
| `REDMINE_ALLOWED_PROJECTS`          | yes      | Comma-separated project **identifiers** (slugs) or numeric IDs — global allowlist enforced on every read                                                                              |
| `REDMINE_DEFAULT_EXTERNAL_PROJECTS` | yes      | Comma-separated project identifiers used as defaults for `resolve_related_test_chain` when its `external_projects` arg is omitted. Every entry must also appear in the allowlist     |
| `REDMINE_TIMEOUT_MS`                | no       | HTTP timeout in milliseconds (default: `15000`)                                                                                                                                      |

**Finding the project identifier:** open the project in Redmine — the identifier is the last segment of the URL. For example, `https://redmine.example.com/redmine/projects/myproject` has identifier `myproject`.

## Claude Code configuration

Copy the example and fill in your credentials:

```bash
cp .mcp.json.example .mcp.json
```

Edit `.mcp.json` with hardcoded values:

```json
{
  "mcpServers": {
    "redmine": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "REDMINE_BASE_URL": "https://redmine.example.com/redmine",
        "REDMINE_API_KEY": "your-api-key",
        "REDMINE_ALLOWED_PROJECTS": "myproject,otherproject",
        "REDMINE_DEFAULT_EXTERNAL_PROJECTS": "otherproject",
        "REDMINE_TIMEOUT_MS": "15000"
      }
    }
  }
}
```

Alternatively, if you have the environment variables set at system level, `.mcp.json.example` uses `${VAR}` interpolation — Claude Code will expand them at server start.

Both `.env` and `.mcp.json` are gitignored. Only the `.example` templates are tracked.

### Manual registration (alternative)

If you prefer not to use `.mcp.json`, export the environment variables in your shell and run:

```bash
claude mcp add redmine --scope local -- node dist/index.js
```

## Project structure

```text
.env.example          # env template (tracked)
.mcp.json.example     # MCP config template (tracked)
.env                  # your credentials (gitignored)
.mcp.json             # your MCP config (gitignored)
src/                  # TypeScript source
dist/                 # compiled output (gitignored)
test/                 # unit tests
```

## Development

Run the server in dev mode:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

## License

MIT
