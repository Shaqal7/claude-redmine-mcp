import { describe, expect, it, vi } from "vitest";

import { RedmineService } from "../src/service.js";
import type { ProjectRef, RedmineIssue } from "../src/types.js";

const rossmannProject: ProjectRef = {
  id: 1,
  name: "Market3 Merge Rossmann",
  identifier: "rossmannmerge"
};

const poligonProject: ProjectRef = {
  id: 2,
  name: "Rossmann Systemy Centralne | Zgłoszenia",
  identifier: "poligon"
};

function issue(overrides: Partial<RedmineIssue> & Pick<RedmineIssue, "id" | "project" | "subject">): RedmineIssue {
  return {
    id: overrides.id,
    project: overrides.project,
    subject: overrides.subject,
    status: overrides.status ?? { id: 2, name: "Przypisany" },
    tracker: overrides.tracker,
    priority: overrides.priority,
    author: overrides.author,
    assigned_to: overrides.assigned_to,
    description: overrides.description,
    created_on: overrides.created_on,
    updated_on: overrides.updated_on ?? "2026-05-15T08:48:51Z",
    custom_fields: overrides.custom_fields,
    journals: overrides.journals,
    relations: overrides.relations,
    allowed_statuses: overrides.allowed_statuses ?? [{ id: 3, name: "Rozwiązany" }]
  };
}

describe("RedmineService", () => {
  it("builds a dry-run chain for resolving related test issues", async () => {
    const issues = new Map<number, RedmineIssue>([
      [
        278929,
        issue({
          id: 278929,
          project: rossmannProject,
          tracker: { id: 1, name: "Test" },
          subject: "TEST: filter issue",
          relations: [{ id: 1, relation_type: "copied_to", issue_id: 272676, issue_to_id: 278929 }]
        })
      ],
      [
        272676,
        issue({
          id: 272676,
          project: rossmannProject,
          tracker: { id: 2, name: "Błąd" },
          subject: "filter issue",
          relations: [
            { id: 1, relation_type: "copied_to", issue_id: 272676, issue_to_id: 278929 },
            { id: 2, relation_type: "copied_to", issue_id: 268038, issue_to_id: 272676 }
          ]
        })
      ],
      [
        268038,
        issue({
          id: 268038,
          project: poligonProject,
          tracker: { id: 2, name: "Błąd" },
          subject: "[M3] filter issue",
          relations: [{ id: 2, relation_type: "copied_to", issue_id: 268038, issue_to_id: 272676 }]
        })
      ]
    ]);
    const client = {
      getBaseUrl: () => "https://redmine.example.com",
      getIssue: vi.fn(async (issueId: number) => issues.get(issueId)),
      getProject: vi.fn(async (projectRef: string) => {
        if (projectRef === "1" || projectRef === "rossmannmerge") {
          return rossmannProject;
        }
        if (projectRef === "2" || projectRef === "poligon") {
          return poligonProject;
        }
        throw new Error(`Unknown project ${projectRef}`);
      }),
      getStatus: vi.fn(),
      updateIssue: vi.fn()
    };
    const service = new RedmineService(client as never, ["rossmannmerge", "poligon"], ["poligon"]);

    const result = await service.resolveRelatedTestChain({
      test_issue_id: 278929,
      note: "Poprawka zweryfikowana",
      dry_run: true
    });

    expect(result.dry_run).toBe(true);
    expect(result.steps.map((step) => [step.role, step.issue.id])).toEqual([
      ["test", 278929],
      ["same_project_issue", 272676],
      ["external_issue", 268038]
    ]);
    expect(result.steps.every((step) => step.action === "would_update")).toBe(true);
    expect(client.updateIssue).not.toHaveBeenCalled();
  });
});
