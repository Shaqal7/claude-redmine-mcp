import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { RedmineMcpError } from "../src/errors.js";
import { RedmineService } from "../src/service.js";
import type { ProjectRef, RedmineIssue } from "../src/types.js";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/create-issue/${name}`, import.meta.url), "utf8")) as T;
}

const projectFixture = fixture<{ project: ProjectRef & { trackers: unknown[]; issue_custom_fields: unknown[] } }>(
  "project-rossmannmerge.json"
).project;
const prioritiesFixture = fixture<{ issue_priorities: unknown[] }>("issue-priorities.json").issue_priorities;
const createdFixture = fixture<{ issue: RedmineIssue }>("created-issue.json").issue;
const adminCustomFields = fixture<{ custom_fields: unknown[] }>("custom-fields-admin.json").custom_fields;

const rossmannProject: ProjectRef = { id: 192, name: "Market3 Merge Rossmann", identifier: "rossmannmerge" };
const blockedProject: ProjectRef = { id: 9, name: "Rossmann - Kasa", identifier: "kasa" };
const BASE_URL = "https://redmine.example.com";

const testIssue: RedmineIssue = {
  id: 295394,
  project: { id: 192, name: "Market3 Merge Rossmann" },
  tracker: { id: 12, name: "Test" },
  status: { id: 3, name: "Rozwiązany" },
  subject: "[MKT, Gotówkomat] Wpłaty lub podbioru można dokonać wyłącznie dla zmiany otwartej mniej niż 11 h",
  updated_on: "2026-11-03T13:15:20Z",
  relations: []
};
const blockedIssue: RedmineIssue = {
  id: 500000,
  project: { id: 9, name: "Rossmann - Kasa" },
  status: { id: 1, name: "Nowy" },
  subject: "Spoza allowlisty",
  updated_on: "2026-11-03T13:15:20Z"
};

const SUBJECT = "[MKT, Gotówkomat] Komunikat okna wpłat gubi pełne doby";
const DESCRIPTION = "h3. Opis\n\nKomunikat podaje czas bez dób.";

function makeClient(options: { created?: RedmineIssue; refetched?: RedmineIssue[]; adminFields?: boolean } = {}) {
  const created = options.created ?? createdFixture;
  const refetched = [...(options.refetched ?? [])];
  const issues = new Map<number, RedmineIssue>([
    [testIssue.id, testIssue],
    [blockedIssue.id, blockedIssue]
  ]);
  return {
    getBaseUrl: () => BASE_URL,
    getProject: vi.fn(async (ref: string) => {
      if (ref === "192" || ref === "rossmannmerge") return rossmannProject;
      if (ref === "9" || ref === "kasa") return blockedProject;
      throw new RedmineMcpError("NOT_FOUND", "The requested Redmine resource was not found.");
    }),
    getProjectIssueMetadata: vi.fn(async () => ({
      trackers: projectFixture.trackers,
      issue_custom_fields: projectFixture.issue_custom_fields
    })),
    listTrackers: vi.fn(),
    listIssuePriorities: vi.fn(async () => prioritiesFixture),
    listIssueCustomFieldDefinitions: vi.fn(async () => {
      if (options.adminFields) {
        return adminCustomFields;
      }
      throw new RedmineMcpError("AUTH_ERROR", "Redmine rejected the API key or denied access.", { status: 403 });
    }),
    getIssue: vi.fn(async (issueId: number) => {
      if (issueId === created.id) {
        return refetched.length > 0 ? refetched.shift()! : created;
      }
      const found = issues.get(issueId);
      if (!found) throw new RedmineMcpError("NOT_FOUND", "The requested Redmine resource was not found.");
      return found;
    }),
    createIssue: vi.fn(async () => created),
    createIssueRelation: vi.fn(async (issueId: number, issueToId: number, relationType: string) => ({
      id: 90001,
      issue_id: issueId,
      issue_to_id: issueToId,
      relation_type: relationType
    }))
  };
}

function service(client: ReturnType<typeof makeClient>) {
  return new RedmineService(client as never, ["rossmannmerge", "poligon"], ["poligon"]);
}

const withRelation = (issue: RedmineIssue): RedmineIssue => ({
  ...issue,
  relations: [{ id: 90001, relation_type: "relates", issue_id: issue.id, issue_to_id: testIssue.id }]
});

describe("create_issue", () => {
  it("previews a dry run with names resolved and no write", async () => {
    const client = makeClient();

    const result = await service(client).createIssue({
      project: "rossmannmerge",
      subject: `  ${SUBJECT}  `,
      description: DESCRIPTION,
      tracker: "błąd",
      priority: "Niski",
      custom_fields: { "Ważność": "nie dotyczy", "26": "1.30.26102.4660" },
      related_issue_id: 295394
    });

    expect(result.dry_run).toBe(true);
    expect(result.action).toBe("would_create");
    expect(result.project).toEqual({ id: 192, name: "Market3 Merge Rossmann", identifier: "rossmannmerge" });
    expect(result.tracker).toEqual({ id: 1, name: "Błąd", source: "input" });
    expect(result.priority).toEqual({ id: 3, name: "Niski", source: "input" });
    expect(result.subject).toBe(SUBJECT);
    expect(result.description).toBe(DESCRIPTION);
    expect(result.custom_fields).toEqual([
      { id: 1, name: "Ważność", value: "nie dotyczy" },
      { id: 26, name: "Rozwiązane w wersji", value: "1.30.26102.4660" }
    ]);
    expect(result.relation).toMatchObject({ type: "relates", action: "would_relate", issue: { id: 295394 } });
    expect(result.required_custom_fields.known).toBe(false);
    expect(result.required_custom_fields.note).toMatch(/admin/i);
    expect(result.issue_id).toBeNull();
    expect(result.url).toBeNull();
    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.createIssueRelation).not.toHaveBeenCalled();
  });

  it("falls back to the project's first tracker and Redmine's default priority", async () => {
    const client = makeClient();

    const result = await service(client).createIssue({
      project: "rossmannmerge",
      subject: SUBJECT,
      description: DESCRIPTION
    });

    expect(result.tracker).toEqual({ id: 2, name: "Zadanie", source: "project_default" });
    expect(result.priority).toEqual({ id: 4, name: "Normalny", source: "redmine_default" });
    expect(result.relation).toBeNull();
    expect(result.custom_fields).toEqual([]);
  });

  it("rejects an ambiguous custom field name", async () => {
    const client = makeClient();

    await expect(
      service(client).createIssue({
        project: "rossmannmerge",
        subject: SUBJECT,
        description: DESCRIPTION,
        custom_fields: { wersj: "1.30" }
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringMatching(/ambiguous/) });
  });

  it("rejects an ambiguous priority and an unknown tracker", async () => {
    const client = makeClient();
    const base = { project: "rossmannmerge", subject: SUBJECT, description: DESCRIPTION };

    await expect(service(client).createIssue({ ...base, priority: "n" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
    await expect(service(client).createIssue({ ...base, tracker: "Feature" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Zadanie")
    });
  });

  it("rejects a project outside the allowlist before reading its metadata", async () => {
    const client = makeClient();

    await expect(
      service(client).createIssue({ project: "kasa", subject: SUBJECT, description: DESCRIPTION, dry_run: false })
    ).rejects.toMatchObject({ code: "POLICY_ERROR" });
    expect(client.getProjectIssueMetadata).not.toHaveBeenCalled();
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  it("rejects a related issue outside the allowlist before any write", async () => {
    const client = makeClient();

    await expect(
      service(client).createIssue({
        project: "rossmannmerge",
        subject: SUBJECT,
        description: DESCRIPTION,
        related_issue_id: 500000,
        dry_run: false
      })
    ).rejects.toMatchObject({ code: "POLICY_ERROR" });
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  it("rejects blank subject, blank description, unknown relation type and relation type without an issue", async () => {
    const client = makeClient();
    const base = { project: "rossmannmerge", subject: SUBJECT, description: DESCRIPTION };

    await expect(service(client).createIssue({ ...base, subject: "   " })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
    await expect(service(client).createIssue({ ...base, subject: "x".repeat(256) })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
    await expect(service(client).createIssue({ ...base, description: " \n " })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
    await expect(
      service(client).createIssue({ ...base, related_issue_id: 295394, relation_type: "parent" })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service(client).createIssue({ ...base, relation_type: "blocks" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
  });

  it("creates the issue, verifies it and adds the relation", async () => {
    const client = makeClient({ refetched: [createdFixture, withRelation(createdFixture)] });

    const result = await service(client).createIssue({
      project: "rossmannmerge",
      subject: SUBJECT,
      description: DESCRIPTION,
      tracker: "Błąd",
      priority: "Niski",
      custom_fields: { "Ważność": "nie dotyczy" },
      related_issue_id: 295394,
      dry_run: false
    });

    expect(client.createIssue).toHaveBeenCalledWith({
      project_id: 192,
      tracker_id: 1,
      priority_id: 3,
      subject: SUBJECT,
      description: DESCRIPTION,
      custom_fields: [{ id: 1, value: "nie dotyczy" }]
    });
    expect(client.createIssueRelation).toHaveBeenCalledWith(300001, 295394, "relates");
    expect(result.dry_run).toBe(false);
    expect(result.action).toBe("created");
    expect(result.issue_id).toBe(300001);
    expect(result.url).toBe(`${BASE_URL}/issues/300001`);
    expect(result.issue).toMatchObject({ id: 300001, subject: SUBJECT });
    expect(result.relation).toMatchObject({ type: "relates", action: "related", issue: { id: 295394 } });
  });

  it("warns about an unknown outcome when the create request fails upstream", async () => {
    const client = makeClient();
    client.createIssue.mockRejectedValueOnce(
      new RedmineMcpError("UPSTREAM_ERROR", "Redmine request timed out after 15000ms.")
    );

    await expect(
      service(client).createIssue({ project: "rossmannmerge", subject: SUBJECT, description: DESCRIPTION, dry_run: false })
    ).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      message: expect.stringMatching(/timed out.*duplicate/s)
    });
  });

  it("passes Redmine's validation errors on create through unchanged", async () => {
    const client = makeClient();
    client.createIssue.mockRejectedValueOnce(new RedmineMcpError("VALIDATION_ERROR", "Ważność cannot be blank"));

    await expect(
      service(client).createIssue({ project: "rossmannmerge", subject: SUBJECT, description: DESCRIPTION, dry_run: false })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "Ważność cannot be blank" });
  });

  it("rejects the same custom field given twice", async () => {
    const client = makeClient();

    await expect(
      service(client).createIssue({
        project: "rossmannmerge",
        subject: SUBJECT,
        description: DESCRIPTION,
        custom_fields: { "1": "nie dotyczy", "Ważność": "krytyczna" }
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("more than once") });
  });

  it("reports the created issue when read-after-write shows a different tracker", async () => {
    const client = makeClient({ refetched: [{ ...createdFixture, tracker: { id: 2, name: "Zadanie" } }] });

    const error = await service(client)
      .createIssue({
        project: "rossmannmerge",
        subject: SUBJECT,
        description: DESCRIPTION,
        tracker: "Błąd",
        related_issue_id: 295394,
        dry_run: false
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RedmineMcpError);
    expect(error).toMatchObject({ code: "UPSTREAM_ERROR", details: { issue_id: 300001, url: `${BASE_URL}/issues/300001` } });
    expect((error as Error).message).toContain("#300001");
    expect((error as Error).message).toContain("tracker");
    expect(client.createIssueRelation).not.toHaveBeenCalled();
  });

  it("reports the created issue when a custom field did not persist", async () => {
    const client = makeClient({
      refetched: [{ ...createdFixture, custom_fields: [{ id: 26, name: "Rozwiązane w wersji", value: "" }] }]
    });

    await expect(
      service(client).createIssue({
        project: "rossmannmerge",
        subject: SUBJECT,
        description: DESCRIPTION,
        tracker: "Błąd",
        priority: "Niski",
        custom_fields: { "Ważność": "nie dotyczy" },
        dry_run: false
      })
    ).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      message: expect.stringMatching(/#300001.*Ważność/s),
      details: { issue_id: 300001 }
    });
  });

  it("reports a partial state when the relation step fails", async () => {
    const client = makeClient({ refetched: [createdFixture] });
    client.createIssueRelation.mockRejectedValueOnce(
      new RedmineMcpError("VALIDATION_ERROR", "Related issue doesn't belong to the same project")
    );

    const error = await service(client)
      .createIssue({
        project: "rossmannmerge",
        subject: SUBJECT,
        description: DESCRIPTION,
        tracker: "Błąd",
        priority: "Niski",
        related_issue_id: 295394,
        dry_run: false
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "UPSTREAM_ERROR",
      details: { issue_id: 300001, url: `${BASE_URL}/issues/300001`, failed_step: "relation" }
    });
    const message = (error as Error).message;
    expect(message).toContain("#300001 was created");
    expect(message).toContain(`${BASE_URL}/issues/300001`);
    expect(message).toContain("Related issue doesn't belong to the same project");
  });

  it("reports a partial state when the relation does not show up after creation", async () => {
    const client = makeClient({ refetched: [createdFixture, createdFixture] });

    await expect(
      service(client).createIssue({
        project: "rossmannmerge",
        subject: SUBJECT,
        description: DESCRIPTION,
        tracker: "Błąd",
        priority: "Niski",
        related_issue_id: 295394,
        dry_run: false
      })
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR", details: { issue_id: 300001, failed_step: "relation" } });
  });

  it("lists missing required custom fields when the definitions are readable", async () => {
    const client = makeClient({ adminFields: true });

    const result = await service(client).createIssue({
      project: "rossmannmerge",
      subject: SUBJECT,
      description: DESCRIPTION,
      tracker: "Błąd"
    });

    // 1 is required for Błąd without a default; 7 has a default; 42 is for Zadanie only; 99 is a user field.
    expect(result.required_custom_fields).toEqual({ known: true, missing: [{ id: 1, name: "Ważność" }] });
  });

  it("degrades when the project does not expose trackers or issue custom fields", async () => {
    const client = makeClient();
    client.getProjectIssueMetadata.mockResolvedValue({ trackers: undefined, issue_custom_fields: undefined } as never);
    client.listTrackers.mockResolvedValue([
      { id: 2, name: "Zadanie" },
      { id: 1, name: "Błąd" }
    ]);
    const base = { project: "rossmannmerge", subject: SUBJECT, description: DESCRIPTION, tracker: "Błąd" };

    const result = await service(client).createIssue({ ...base, custom_fields: { "26": "1.30" } });

    expect(result.tracker).toEqual({ id: 1, name: "Błąd", source: "input" });
    expect(result.custom_fields).toEqual([{ id: 26, name: "#26", value: "1.30" }]);
    await expect(service(client).createIssue({ ...base, custom_fields: { Wersja: "1.30" } })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("numeric ID")
    });
  });
});
