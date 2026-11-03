import { describe, expect, it, vi } from "vitest";

import { RedmineMcpError } from "../src/errors.js";
import { createToolHandlers } from "../src/tool-handlers.js";

describe("tool handlers", () => {
  it("returns formatted JSON for successful calls", async () => {
    const handlers = createToolHandlers({
      listIssues: vi.fn(async () => ({ count: 1, total_count: 1, project: "Backend", issues: [] })),
      searchIssues: vi.fn(),
      getIssue: vi.fn(),
      addIssueNote: vi.fn(),
      updateIssueStatus: vi.fn(),
      assignIssue: vi.fn(),
      resolveRelatedTestChain: vi.fn()
    } as never);

    const response = await handlers.listIssues({ project: "backend" });

    expect(response.isError).toBeUndefined();
    expect(response.content[0]?.text).toContain('"project": "Backend"');
  });

  it("returns structured error payloads", async () => {
    const handlers = createToolHandlers({
      listIssues: vi.fn(async () => {
        throw new Error("boom");
      }),
      searchIssues: vi.fn(),
      getIssue: vi.fn(),
      addIssueNote: vi.fn(),
      updateIssueStatus: vi.fn(),
      assignIssue: vi.fn(),
      resolveRelatedTestChain: vi.fn()
    } as never);

    const response = await handlers.listIssues({ project: "backend" });

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain('"code": "UPSTREAM_ERROR"');
  });

  it("formats create_issue policy errors as structured error payloads", async () => {
    const createIssue = vi.fn(async () => {
      throw new RedmineMcpError("POLICY_ERROR", 'Project "Rossmann - Kasa" is outside the REDMINE_ALLOWED_PROJECTS allowlist.');
    });
    const handlers = createToolHandlers({ createIssue } as never);

    const response = await handlers.createIssue({ project: "kasa", subject: "x", description: "y" });

    expect(createIssue).toHaveBeenCalledWith({ project: "kasa", subject: "x", description: "y" });
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain('"code": "POLICY_ERROR"');
  });
});
