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
const service = new RedmineService(client, config.allowedProjects);
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
  description: "Search issue subjects and descriptions across allowed Redmine projects.",
  inputSchema: {
    query: z.string().min(1),
    project: z.string().optional(),
    status: z.string().optional(),
    assignee: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional()
  }
}, handlers.searchIssues);

server.registerTool("get_issue", {
  description: "Fetch normalized detail for one issue, including journals and relations.",
  inputSchema: {
    issue_id: z.number().int().positive()
  }
}, handlers.getIssue);

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

const transport = new StdioServerTransport();

try {
  await server.connect(transport);
} catch (error) {
  console.error(error);
  process.exit(1);
}