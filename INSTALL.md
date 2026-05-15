# Installing Claude Redmine MCP locally

This guide walks a teammate through cloning the repo, building it, and registering the server with Claude Code so the Redmine tools are usable in their own sessions.

> The server runs locally on your machine and speaks **stdio** to Claude Code. There is no remote endpoint and nothing is sent to a third party other than your own Redmine instance.

## 1. Prerequisites

- **Node.js 18 or newer** — check with `node --version`. Install from [nodejs.org](https://nodejs.org/) if missing.
- **Claude Code CLI** installed and logged in — check with `claude --version`.
- A **personal Redmine API key**. To find it:
  1. Log in to Redmine in a browser.
  2. Go to *My account* (top-right).
  3. In the right column there is *API access key* → click **Show**.
  4. Copy the 40-character hex string.
- The **project identifiers** (slugs) you want the MCP to be allowed to touch. The identifier is the last segment of the project's Redmine URL, e.g. `https://redmine.example.com/redmine/projects/myproject` → `myproject`.

## 2. Clone and build

```bash
git clone <repo-url> claude-redmine-mcp
cd claude-redmine-mcp
npm install
npm run build
```

`npm run build` produces `dist/index.js` — that's the script Claude Code will spawn. Re-run `npm run build` every time you `git pull` changes.

## 3. Configure environment variables

The server reads its config from environment variables. You have two ways to provide them; **pick one** based on how you want to use the server.

### Option A — Local `.env` (project-scope only)

Use this if you only want the MCP available **inside this project's directory**.

```bash
cp .env.example .env
```

Edit `.env`:

```bash
REDMINE_BASE_URL=https://redmine.example.com/redmine
REDMINE_API_KEY=your-40-char-api-key
REDMINE_ALLOWED_PROJECTS=myproject,otherproject
REDMINE_DEFAULT_EXTERNAL_PROJECTS=otherproject
REDMINE_TIMEOUT_MS=15000
```

Then copy the MCP config template:

```bash
cp .mcp.json.example .mcp.json
```

`.mcp.json.example` uses `${VAR}` placeholders that Claude Code expands from environment variables at server start. The server itself also loads `.env` automatically via `dotenv`, so the local `.env` is enough.

Both `.env` and `.mcp.json` are gitignored — only the `.example` templates are tracked.

**Result:** when you run `claude` inside this directory, Claude Code will auto-detect `.mcp.json` and ask you once to trust it. From other directories the server will not be visible.

### Option B — User-scope registration (recommended for daily use)

Use this if you want the MCP available from **any directory** on your machine.

```bash
claude mcp add redmine --scope user \
  -e REDMINE_BASE_URL=https://redmine.example.com/redmine \
  -e REDMINE_API_KEY=your-40-char-api-key \
  -e REDMINE_ALLOWED_PROJECTS=myproject,otherproject \
  -e REDMINE_DEFAULT_EXTERNAL_PROJECTS=otherproject \
  -e REDMINE_TIMEOUT_MS=15000 \
  -- node /absolute/path/to/claude-redmine-mcp/dist/index.js
```

Substitute the **absolute path** to `dist/index.js` (e.g. `E:/PROJECTS/mcp/claude-redmine-mcp/dist/index.js` on Windows, `/home/you/claude-redmine-mcp/dist/index.js` on Linux/macOS). Relative paths don't work for user-scope — Claude Code spawns the server with an arbitrary `cwd`.

On Windows PowerShell, use backticks for line continuation instead of `\`, or put everything on one line.

**Result:** the server is now registered in `~/.claude.json` and will be reachable from any Claude Code session. Project-scope `.mcp.json` (Option A) is not needed.

> You **can** combine both: Option A wins inside the project directory, Option B everywhere else. They don't conflict, but you'll have two places to update credentials.

## 4. Verify the installation

From any directory:

```bash
claude mcp list
```

You should see a line like:

```
redmine: node /absolute/path/to/dist/index.js - ✓ Connected
```

If you see `✗ Failed to connect`, see [Troubleshooting](#troubleshooting) below.

Inside a Claude Code session, type `/mcp` — `redmine` should appear with all 9 tools:

- `list_issues`
- `search_issues`
- `get_issue`
- `add_issue_note`
- `update_issue_status`
- `assign_issue`
- `resolve_related_test_chain`
- `attach_file_to_issue`
- `attach_file_to_test_chain`

Quick smoke test in Claude Code:

> List the 5 most recently updated issues in `<your-project-slug>`.

If that returns issues, you're done.

## 5. Updating after a pull

```bash
git pull
npm install        # only if package.json changed
npm run build
```

Restart Claude Code (or reconnect the server via `/mcp`) so it picks up the rebuilt `dist/index.js`.

If env vars were added or renamed (check the diff to [.env.example](.env.example)), update your `.env` (Option A) or re-run `claude mcp add` (Option B).

## 6. Updating credentials

### Option A
Just edit `.env`. Restart Claude Code to reconnect the server.

### Option B
The simplest path is to remove and re-add:

```bash
claude mcp remove redmine -s user
claude mcp add redmine --scope user -e ... -- node /absolute/path/to/dist/index.js
```

Alternatively, edit `~/.claude.json` directly — the `mcpServers.redmine.env` object holds the values.

## Troubleshooting

### `✗ Failed to connect`

Inspect the actual config:

```bash
claude mcp get redmine
```

Common causes:

| Symptom | Likely cause | Fix |
|---|---|---|
| `Environment:` block is empty | Registered without `-e` flags and no shell-level env | Re-register with `-e` flags, or set shell-level env vars |
| `Missing REDMINE_BASE_URL` (or any other var) in server output | Required env var not provided | Add it via `-e` flag or `.env` |
| `REDMINE_DEFAULT_EXTERNAL_PROJECTS contains projects not present in REDMINE_ALLOWED_PROJECTS: foo` | Default external project is not in the allowlist | Either add `foo` to `REDMINE_ALLOWED_PROJECTS`, or remove it from `REDMINE_DEFAULT_EXTERNAL_PROJECTS` |
| Server starts but `POLICY_ERROR: "Project X is outside the REDMINE_ALLOWED_PROJECTS allowlist."` | The project you tried to access is not in your allowlist | Add the project slug to `REDMINE_ALLOWED_PROJECTS` and reconnect |
| `Redmine rejected the API key or denied access` | Wrong key, expired key, or your Redmine user lacks permission on the requested project | Verify the key in *My account*; verify project membership |
| `Redmine request failed with 404` for a project that exists | Used project **name** with spaces/diacritics instead of the **identifier** slug | Use the slug (last segment of the project URL) |

To see raw server stderr, run it manually:

```bash
cd claude-redmine-mcp
npm start
```

The server speaks stdio JSON-RPC, so it will just sit there waiting for input — but startup errors (missing env, invalid config) print to stderr immediately.

### `dist/index.js` not found

You forgot `npm run build`, or you're using `npm run dev` (which uses `tsx` and doesn't produce `dist/`). For Claude Code registration, you need the built `dist/index.js`.

### Server connects but tools don't appear in `/mcp`

The MCP server is connected to a stale Claude Code session. Quit Claude Code fully and restart.

## Security notes

- **Option A:** the API key sits in `.env`, which is gitignored. Don't commit it.
- **Option B:** the API key is stored in plaintext inside `~/.claude.json`. The file is per-user and not committed, but it is a regular text file on disk. If you back up your home directory, the key goes with it. If you're on a shared machine, consider Option A or set the key via shell-level env vars instead of `-e` flags.
- The MCP server enforces the **`REDMINE_ALLOWED_PROJECTS` allowlist on every issue read** — even if a related issue exists in some other project, the server refuses to fetch it. Keep the allowlist tight.
- All write operations (notes, status changes, assignments, attachments, chain resolution) require an explicit Claude Code confirmation prompt before being executed; `resolve_related_test_chain` and `attach_file_to_test_chain` additionally default to `dry_run=true`.

## Uninstall

```bash
claude mcp remove redmine -s user      # if Option B
claude mcp remove redmine -s project   # if Option A
rm -rf claude-redmine-mcp              # the cloned repo
```
