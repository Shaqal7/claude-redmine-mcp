import { describe, expect, it, vi } from "vitest";

import { RedmineMcpError } from "../src/errors.js";
import { RedmineService } from "../src/service.js";
import type { ProjectRef, RedmineIssue, RedmineJournal } from "../src/types.js";

const rossmannProject: ProjectRef = { id: 1, name: "Market3 Merge Rossmann", identifier: "rossmannmerge" };
const blockedProject: ProjectRef = { id: 9, name: "Rossmann - Kasa", identifier: "kasa" };

function issue(id: number, project: ProjectRef, subject: string, journals?: RedmineJournal[]): RedmineIssue {
  return {
    id,
    project: { id: project.id, name: project.name },
    subject,
    status: { id: 3, name: "Rozwiązany" },
    updated_on: "2026-02-17T07:03:35Z",
    journals
  };
}

function getProject(projectRef: string): ProjectRef {
  if (projectRef === "1" || projectRef === "rossmannmerge") return rossmannProject;
  if (projectRef === "9" || projectRef === "kasa") return blockedProject;
  throw new Error(`Unknown project ${projectRef}`);
}

describe("search_issues (full-text)", () => {
  it("uses Redmine search, keeps its ordering, adds excerpts and drops hits outside the allowlist", async () => {
    const records = new Map<number, RedmineIssue>([
      [145975, issue(145975, rossmannProject, "Kolejka do automatycznej fiskalizacji")],
      [138975, issue(138975, rossmannProject, "Automatyczna fiskalizacja Scan&Go")],
      [500000, issue(500000, blockedProject, "Subproject hit")]
    ]);
    const client = {
      getBaseUrl: () => "https://redmine.example.com",
      getProject: vi.fn(async (ref: string) => getProject(ref)),
      searchProjectIssues: vi.fn(async () => ({
        total_count: 4,
        offset: 0,
        limit: 100,
        results: [
          { id: 145975, title: "Zadanie #145975", type: "issue-closed", url: "", description: "...OrdersFiscalizationExecutor..." },
          { id: 1, title: "Wiki", type: "wiki-page", url: "" },
          { id: 500000, title: "Zadanie #500000", type: "issue", url: "" },
          { id: 138975, title: "Zadanie #138975", type: "issue", url: "", description: "" }
        ]
      })),
      listIssuesByIds: vi.fn(async ({ issueIds }: { issueIds: number[] }) =>
        issueIds.map((id) => records.get(id)).filter(Boolean)
      ),
      listIssues: vi.fn()
    };
    const service = new RedmineService(client as never, ["rossmannmerge"], ["rossmannmerge"]);

    const result = await service.searchIssues({ query: "OrdersFiscalizationExecutor" });

    expect(result.mode).toBe("fulltext");
    expect(result.total_hits).toBe(4);
    expect(result.issues.map((hit) => hit.id)).toEqual([145975, 138975]);
    expect(result.issues[0]?.match_excerpt).toContain("OrdersFiscalizationExecutor");
    expect(result.issues[1]?.match_excerpt).toBeNull();
    expect(client.listIssuesByIds).toHaveBeenCalledWith(
      expect.objectContaining({ issueIds: [145975, 500000, 138975], statusId: "*" })
    );
    expect(client.searchProjectIssues).toHaveBeenCalledWith(
      expect.objectContaining({ projectRef: "rossmannmerge", allWords: true, titlesOnly: false })
    );
    expect(client.listIssues).not.toHaveBeenCalled();
  });

  it("falls back to scanning recent issues when the search endpoint is missing", async () => {
    const client = {
      getBaseUrl: () => "https://redmine.example.com",
      getProject: vi.fn(async (ref: string) => getProject(ref)),
      searchProjectIssues: vi.fn(async () => {
        throw new RedmineMcpError("NOT_FOUND", "The requested Redmine resource was not found.");
      }),
      listIssues: vi.fn(async () => ({
        total_count: 2,
        offset: 0,
        limit: 10,
        issues: [
          { ...issue(1, rossmannProject, "eParagon wdrożenie"), description: "" },
          { ...issue(2, rossmannProject, "Inne"), description: "nic" }
        ]
      })),
      getIssue: vi.fn()
    };
    const service = new RedmineService(client as never, ["rossmannmerge"], ["rossmannmerge"]);

    const result = await service.searchIssues({ query: "eparagon" });

    expect(result.mode).toBe("scan");
    expect(result.issues.map((hit) => hit.id)).toEqual([1]);
    expect(client.getIssue).not.toHaveBeenCalled();
  });
});

describe("update_issue_note / delete_issue_note", () => {
  function clientWithJournals(journalsBefore: RedmineJournal[], journalsAfter: RedmineJournal[]) {
    let written = false;
    return {
      getBaseUrl: () => "https://redmine.example.com",
      getProject: vi.fn(async (ref: string) => getProject(ref)),
      getIssue: vi.fn(async () => issue(269101, rossmannProject, "3003", written ? journalsAfter : journalsBefore)),
      updateJournalNotes: vi.fn(async () => {
        written = true;
      })
    };
  }

  it("rejects a journal that belongs to another issue", async () => {
    const client = clientWithJournals([{ id: 1, created_on: "", notes: "x" }], []);
    const service = new RedmineService(client as never, ["rossmannmerge"], ["rossmannmerge"]);

    await expect(service.updateIssueNote({ issue_id: 269101, journal_id: 999, note: "y" })).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    expect(client.updateJournalNotes).not.toHaveBeenCalled();
  });

  it("updates note text and verifies it was persisted", async () => {
    const client = clientWithJournals(
      [{ id: 1632168, created_on: "", notes: "Poprawka w wersji M3 1.30.26021.4561." }],
      [{ id: 1632168, created_on: "", notes: "Poprawka w wersji M3 1.30.26021.4562." }]
    );
    const service = new RedmineService(client as never, ["rossmannmerge"], ["rossmannmerge"]);

    const result = await service.updateIssueNote({
      issue_id: 269101,
      journal_id: 1632168,
      note: "  Poprawka w wersji M3 1.30.26021.4562.  "
    });

    expect(client.updateJournalNotes).toHaveBeenCalledWith(1632168, "Poprawka w wersji M3 1.30.26021.4562.");
    expect(result.action).toBe("updated");
  });

  it("reports when Redmine silently ignores the edit", async () => {
    const before = [{ id: 5, created_on: "", notes: "stara" }];
    const client = clientWithJournals(before, before);
    const service = new RedmineService(client as never, ["rossmannmerge"], ["rossmannmerge"]);

    await expect(service.updateIssueNote({ issue_id: 269101, journal_id: 5, note: "nowa" })).rejects.toMatchObject({
      code: "UPSTREAM_ERROR"
    });
  });

  it("deletes a note (journal disappears)", async () => {
    const client = clientWithJournals([{ id: 5, created_on: "", notes: "do usunięcia" }], []);
    const service = new RedmineService(client as never, ["rossmannmerge"], ["rossmannmerge"]);

    const result = await service.deleteIssueNote({ issue_id: 269101, journal_id: 5 });

    expect(client.updateJournalNotes).toHaveBeenCalledWith(5, "");
    expect(result.action).toBe("deleted");
  });

  it("explains missing journals API on older Redmine", async () => {
    const client = {
      ...clientWithJournals([{ id: 5, created_on: "", notes: "a" }], []),
      updateJournalNotes: vi.fn(async () => {
        throw new RedmineMcpError("NOT_FOUND", "The requested Redmine resource was not found.");
      })
    };
    const service = new RedmineService(client as never, ["rossmannmerge"], ["rossmannmerge"]);

    await expect(service.updateIssueNote({ issue_id: 269101, journal_id: 5, note: "b" })).rejects.toThrow(
      /Redmine 5\.0\+/
    );
  });
});
