import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { isRedmineMcpError } from "./errors.js";
import type { ErrorCode } from "./types.js";
import { RedmineService } from "./service.js";

type ToolResponse = CallToolResult;

export function createToolHandlers(service: RedmineService) {
  return {
    listIssues: async (input: {
      project: string;
      status?: string;
      assignee?: string;
      limit?: number;
      sort?: string;
    }): Promise<ToolResponse> => handleTool(async () => service.listIssues(input)),
    searchIssues: async (input: {
      query: string;
      project?: string;
      status?: string;
      assignee?: string;
      limit?: number;
    }): Promise<ToolResponse> => handleTool(async () => service.searchIssues(input)),
    getIssue: async (input: { issue_id: number }): Promise<ToolResponse> =>
      handleTool(async () => service.getIssue(input.issue_id)),
    addIssueNote: async (input: { issue_id: number; note: string }): Promise<ToolResponse> =>
      handleTool(async () => service.addIssueNote(input.issue_id, input.note)),
    updateIssueStatus: async (input: { issue_id: number; status: string }): Promise<ToolResponse> =>
      handleTool(async () => service.updateIssueStatus(input.issue_id, input.status)),
    assignIssue: async (input: { issue_id: number; assignee: string }): Promise<ToolResponse> =>
      handleTool(async () => service.assignIssue(input.issue_id, input.assignee))
  };
}

async function handleTool(fn: () => Promise<unknown>): Promise<ToolResponse> {
  try {
    const result = await fn();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(formatError(error), null, 2)
        }
      ],
      isError: true
    };
  }
}

function formatError(error: unknown): { code: ErrorCode | "UPSTREAM_ERROR"; message: string; details?: unknown } {
  if (isRedmineMcpError(error)) {
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  }

  return {
    code: "UPSTREAM_ERROR",
    message: error instanceof Error ? error.message : "Unexpected error."
  };
}