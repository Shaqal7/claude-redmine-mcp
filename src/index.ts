#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { RedmineClient } from "./redmine/client.js";
import { RedmineService } from "./service.js";
import { createToolHandlers } from "./tool-handlers.js";

const config = loadConfig();
const client = new RedmineClient(config);
const service = new RedmineService(client, config.allowedProjects, config.defaultExternalProjects);
const handlers = createToolHandlers(service);

const server = new McpServer({
  name: "redmine-mcp",
  version: "0.1.0"
});

server.registerTool("list_issues", {
  description: "List issues for one allowed Redmine project.",
  inputSchema: {
    project: z.string().min(1),
    status: z.string().optional(),
    assignee: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    sort: z.string().optional()
  }
}, handlers.listIssues);

server.registerTool("search_issues", {
  description:
    "Full-text search over the WHOLE history of allowed Redmine projects — subjects, descriptions and journal notes (Redmine's own search engine). By default all words must match (all_words=true); set all_words=false for any-word matching, titles_only=true to match subjects only. Each hit carries match_excerpt. Result mode='scan' means the server fell back to scanning only the 100 most recently updated issues (search disabled on this Redmine).",
  inputSchema: {
    query: z.string().min(1),
    project: z.string().optional(),
    status: z.string().optional(),
    assignee: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    titles_only: z.boolean().optional(),
    all_words: z.boolean().optional()
  }
}, handlers.searchIssues);

server.registerTool("get_issue", {
  description:
    "Fetch normalized detail for one issue, including journals (with journal ids), relations, attachments, parent and child issues.",
  inputSchema: {
    issue_id: z.number().int().positive()
  }
}, handlers.getIssue);

server.registerTool("update_issue_note", {
  description:
    "Replace the text of an existing note (journal) on a Redmine issue. Get journal_id from get_issue. Requires Redmine 5.0+ and edit-notes permission. Only call this after explicit user confirmation.",
  inputSchema: {
    issue_id: z.number().int().positive(),
    journal_id: z.number().int().positive(),
    note: z.string().min(1)
  }
}, handlers.updateIssueNote);

server.registerTool("delete_issue_note", {
  description:
    "Remove the text of an existing note (journal) on a Redmine issue; a journal without field changes disappears entirely. Irreversible. Get journal_id from get_issue. Requires Redmine 5.0+ and edit-notes permission. Only call this after explicit user confirmation.",
  inputSchema: {
    issue_id: z.number().int().positive(),
    journal_id: z.number().int().positive()
  }
}, handlers.deleteIssueNote);

server.registerTool("add_issue_note", {
  description: "Add a note to a Redmine issue. Only call this after explicit user confirmation.",
  inputSchema: {
    issue_id: z.number().int().positive(),
    note: z.string().min(1)
  }
}, handlers.addIssueNote);

server.registerTool("update_issue_status", {
  description: "Update the status of a Redmine issue. Only call this after explicit user confirmation.",
  inputSchema: {
    issue_id: z.number().int().positive(),
    status: z.string().min(1)
  }
}, handlers.updateIssueStatus);

server.registerTool("assign_issue", {
  description: "Assign a Redmine issue to a project member. Only call this after explicit user confirmation.",
  inputSchema: {
    issue_id: z.number().int().positive(),
    assignee: z.string().min(1)
  }
}, handlers.assignIssue);

server.registerTool("resolve_related_test_chain", {
  description:
    "Resolve a test issue, its related same-project non-test issue, and one external issue related to that same-project issue (not to the test directly) — applying the same note and status to all three. The chain shape is required: test -> same_project_issue -> external_issue. Defaults to dry_run=true; use dry_run=false only after explicit user confirmation. Updates are not atomic: if a later step fails, earlier steps remain applied and the partial state is reported in the error.",
  inputSchema: {
    test_issue_id: z.number().int().positive(),
    note: z.string().min(1),
    status: z.string().min(1).optional(),
    external_projects: z.array(z.string().min(1)).min(1).optional(),
    dry_run: z.boolean().optional()
  }
}, handlers.resolveRelatedTestChain);

server.registerTool("attach_file_to_issue", {
  description:
    "Attach a local file to a Redmine issue, optionally with a note. The file_path is read from the MCP server's filesystem (absolute path or relative to the server's working directory). Only call this after explicit user confirmation.",
  inputSchema: {
    issue_id: z.number().int().positive(),
    file_path: z.string().min(1),
    note: z.string().min(1).optional()
  }
}, handlers.attachFileToIssue);

server.registerTool("resolve_chain_with_attachment", {
  description:
    "Resolve the full test chain (test -> same_project_issue -> external_issue) with the same note and status while attaching a file to ALL THREE issues in a single PUT per issue — producing one combined journal entry per issue (status change + comment + attachment). Use this instead of pairing resolve_related_test_chain with attach_file_to_test_chain when you want a clean history. The file is uploaded once per target (Redmine tokens are single-use). Defaults to dry_run=true; use dry_run=false only after explicit user confirmation. Not atomic: if a later step fails, earlier steps remain applied and the partial state is reported in the error.",
  inputSchema: {
    test_issue_id: z.number().int().positive(),
    file_path: z.string().min(1),
    note: z.string().min(1),
    status: z.string().min(1).optional(),
    external_projects: z.array(z.string().min(1)).min(1).optional(),
    dry_run: z.boolean().optional()
  }
}, handlers.resolveChainWithAttachment);

server.registerTool("attach_file_to_test_chain", {
  description:
    "Attach a local file to a test issue and to its related external issue (reached via test -> same_project_issue -> external_issue), with the same note on both. The same-project issue itself is NOT touched. The file is uploaded once per target (Redmine upload tokens are single-use). Defaults to dry_run=true; use dry_run=false only after explicit user confirmation. Not atomic: if the second attach fails, the first remains and the partial state is reported in the error.",
  inputSchema: {
    test_issue_id: z.number().int().positive(),
    file_path: z.string().min(1),
    note: z.string().min(1),
    external_projects: z.array(z.string().min(1)).min(1).optional(),
    dry_run: z.boolean().optional()
  }
}, handlers.attachFileToTestChain);

const transport = new StdioServerTransport();

try {
  await server.connect(transport);
} catch (error) {
  console.error(error);
  process.exit(1);
}
