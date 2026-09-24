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
      titles_only?: boolean;
      all_words?: boolean;
    }): Promise<ToolResponse> => handleTool(async () => service.searchIssues(input)),
    updateIssueNote: async (input: { issue_id: number; journal_id: number; note: string }): Promise<ToolResponse> =>
      handleTool(async () => service.updateIssueNote(input)),
    deleteIssueNote: async (input: { issue_id: number; journal_id: number }): Promise<ToolResponse> =>
      handleTool(async () => service.deleteIssueNote(input)),
    getIssue: async (input: { issue_id: number }): Promise<ToolResponse> =>
      handleTool(async () => service.getIssue(input.issue_id)),
    addIssueNote: async (input: { issue_id: number; note: string }): Promise<ToolResponse> =>
      handleTool(async () => service.addIssueNote(input.issue_id, input.note)),
    updateIssueStatus: async (input: { issue_id: number; status: string }): Promise<ToolResponse> =>
      handleTool(async () => service.updateIssueStatus(input.issue_id, input.status)),
    assignIssue: async (input: { issue_id: number; assignee: string }): Promise<ToolResponse> =>
      handleTool(async () => service.assignIssue(input.issue_id, input.assignee)),
    resolveRelatedTestChain: async (input: {
      test_issue_id: number;
      note: string;
      status?: string;
      external_projects?: string[];
      dry_run?: boolean;
    }): Promise<ToolResponse> => handleTool(async () => service.resolveRelatedTestChain(input)),
    attachFileToIssue: async (input: {
      issue_id: number;
      file_path: string;
      note?: string;
    }): Promise<ToolResponse> => handleTool(async () => service.attachFileToIssue(input)),
    attachFileToTestChain: async (input: {
      test_issue_id: number;
      file_path: string;
      note: string;
      external_projects?: string[];
      dry_run?: boolean;
    }): Promise<ToolResponse> => handleTool(async () => service.attachFileToTestChain(input)),
    resolveChainWithAttachment: async (input: {
      test_issue_id: number;
      file_path: string;
      note: string;
      status?: string;
      external_projects?: string[];
      dry_run?: boolean;
    }): Promise<ToolResponse> => handleTool(async () => service.resolveChainWithAttachment(input))
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
