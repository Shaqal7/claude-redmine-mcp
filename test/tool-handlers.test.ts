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

  const downloadedAttachment = {
    issue_id: 295390,
    id: 296490,
    filename: "clipboard.png",
    filesize: 3,
    content_type: "image/png",
    description: null,
    author: "Tomasz Śmierzchała",
    created_on: "2026-10-28T13:25:45Z",
    url: "https://redmine.example.com/attachments/download/296490/clipboard.png"
  };

  it("returns a downloaded image as MCP image content next to its metadata", async () => {
    const downloadAttachment = vi.fn(async () => ({
      attachment: downloadedAttachment,
      delivered_as: "image",
      saved_to: null,
      image: { data: "AQID", mime_type: "image/png" }
    }));
    const handlers = createToolHandlers({ downloadAttachment } as never);

    const response = await handlers.downloadAttachment({ issue_id: 295390, attachment_id: 296490 });

    expect(downloadAttachment).toHaveBeenCalledWith({ issue_id: 295390, attachment_id: 296490 });
    expect(response.isError).toBeUndefined();
    expect(response.content).toHaveLength(2);
    expect(response.content[0]?.type).toBe("text");
    expect(response.content[0]?.text).toContain('"filename": "clipboard.png"');
    expect(response.content[0]?.text).toContain('"author": "Tomasz Śmierzchała"');
    expect(response.content[0]?.text).not.toContain("AQID");
    expect(response.content[1]).toEqual({ type: "image", data: "AQID", mimeType: "image/png" });
  });

  it("returns a saved file as text only", async () => {
    const downloadAttachment = vi.fn(async () => ({
      attachment: { ...downloadedAttachment, filename: "kasa.log", content_type: "text/plain" },
      delivered_as: "file",
      saved_to: "C:\\Temp\\redmine-mcp-attachments\\296490-kasa.log"
    }));
    const handlers = createToolHandlers({ downloadAttachment } as never);

    const response = await handlers.downloadAttachment({ issue_id: 295390, attachment_id: 296490 });

    expect(response.content).toHaveLength(1);
    expect(response.content[0]?.text).toContain("296490-kasa.log");
  });

  it("formats download_attachment policy errors as structured error payloads", async () => {
    const downloadAttachment = vi.fn(async () => {
      throw new RedmineMcpError("POLICY_ERROR", 'Project "Rossmann - Kasa" is outside the REDMINE_ALLOWED_PROJECTS allowlist.');
    });
    const handlers = createToolHandlers({ downloadAttachment } as never);

    const response = await handlers.downloadAttachment({ issue_id: 1, attachment_id: 2 });

    expect(response.isError).toBe(true);
    expect(response.content).toHaveLength(1);
    expect(response.content[0]?.text).toContain('"code": "POLICY_ERROR"');
  });
});
