import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { RedmineMcpError } from "../src/errors.js";
import { RedmineService, redmineStoredFilename } from "../src/service.js";
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
const poligonProject: ProjectRef = { id: 2, name: "Rossmann Systemy Centralne | Zgłoszenia", identifier: "poligon" };
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
const poligonIssue: RedmineIssue = {
  id: 268038,
  project: { id: 2, name: "Rossmann Systemy Centralne | Zgłoszenia" },
  status: { id: 1, name: "Nowy" },
  subject: "[M3] Zgłoszenie klienta",
  updated_on: "2026-11-03T13:15:20Z"
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

function makeClient(
  options: { created?: RedmineIssue; refetched?: Array<RedmineIssue | Error>; adminFields?: boolean } = {}
) {
  const created = options.created ?? createdFixture;
  const refetched = [...(options.refetched ?? [])];
  const issues = new Map<number, RedmineIssue>([
    [testIssue.id, testIssue],
    [poligonIssue.id, poligonIssue],
    [blockedIssue.id, blockedIssue]
  ]);
  return {
    getBaseUrl: () => BASE_URL,
    getProject: vi.fn(async (ref: string) => {
      if (ref === "192" || ref === "rossmannmerge") return rossmannProject;
      if (ref === "2" || ref === "poligon") return poligonProject;
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
        const next = refetched.length > 0 ? refetched.shift()! : created;
        if (next instanceof Error) throw next;
        return next;
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
    })),
    uploadAttachment: vi.fn(async (filename: string) => `token-${filename}`)
  };
}

function service(client: ReturnType<typeof makeClient>, files: Map<string, Uint8Array> = new Map()) {
  const readFile = async (filePath: string) => {
    const bytes = files.get(filePath);
    if (!bytes) throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    return bytes;
  };
  return new RedmineService(client as never, ["rossmannmerge", "poligon"], ["poligon"], readFile);
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

  it("leaves the tracker to Redmine when none is given and uses Redmine's default priority", async () => {
    const client = makeClient({ created: { ...createdFixture, priority: { id: 4, name: "Normalny" } } });
    const input = { project: "rossmannmerge", subject: SUBJECT, description: DESCRIPTION };

    const preview = await service(client).createIssue(input);

    // Redmine's default is the first tracker the user's role may add, which the API does not expose.
    expect(preview.tracker).toBeNull();
    expect(preview.notes.join(" ")).toMatch(/role/);
    expect(preview.priority).toEqual({ id: 4, name: "Normalny", source: "redmine_default" });
    expect(preview.relation).toBeNull();
    expect(preview.custom_fields).toEqual([]);

    const created = await service(client).createIssue({ ...input, dry_run: false });

    expect(client.createIssue).toHaveBeenCalledWith({
      project_id: 192,
      priority_id: 4,
      subject: SUBJECT,
      description: DESCRIPTION
    });
    expect(created.tracker).toEqual({ id: 1, name: "Błąd", source: "redmine_default" });
  });

  it("rejects a blank tracker or priority instead of falling back to defaults", async () => {
    const client = makeClient();
    const base = { project: "rossmannmerge", subject: SUBJECT, description: DESCRIPTION };

    await expect(service(client).createIssue({ ...base, tracker: "   " })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
    await expect(service(client).createIssue({ ...base, priority: " " })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
    await expect(service(client).createIssue({ ...base, custom_fields: { " ": "x" } })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
  });

  it("matches a numeric reference only as an ID, never as part of a name", async () => {
    const client = makeClient();
    client.getProjectIssueMetadata.mockResolvedValue({
      trackers: projectFixture.trackers,
      issue_custom_fields: [...projectFixture.issue_custom_fields, { id: 60, name: "Etap 2" }]
    } as never);

    await expect(
      service(client).createIssue({
        project: "rossmannmerge",
        subject: SUBJECT,
        description: DESCRIPTION,
        custom_fields: { "2": "x" }
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("ignores inactive priorities", async () => {
    const client = makeClient();
    client.listIssuePriorities.mockResolvedValue([
      ...prioritiesFixture,
      { id: 9, name: "Stary niski", is_default: false, active: false }
    ] as never);

    await expect(
      service(client).createIssue({ project: "rossmannmerge", subject: SUBJECT, description: DESCRIPTION, priority: "Stary" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a custom field that is not enabled for the tracker when definitions are readable", async () => {
    const client = makeClient({ adminFields: true });

    await expect(
      service(client).createIssue({
        project: "rossmannmerge",
        subject: SUBJECT,
        description: DESCRIPTION,
        tracker: "Błąd",
        custom_fields: { "Analiza zadania": "x" }
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("Błąd") });
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  it("warns in the preview about a relation to another project", async () => {
    const client = makeClient();

    const result = await service(client).createIssue({
      project: "rossmannmerge",
      subject: SUBJECT,
      description: DESCRIPTION,
      tracker: "Błąd",
      related_issue_id: 268038
    });

    expect(result.relation).toMatchObject({ issue: { id: 268038 } });
    expect(result.notes.join(" ")).toMatch(/cross-project/i);
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

  it("still adds the relation, then reports a custom field that did not persist", async () => {
    const dropped = { ...createdFixture, custom_fields: [{ id: 26, name: "Rozwiązane w wersji", value: "" }] };
    const client = makeClient({ refetched: [dropped, withRelation(dropped)] });

    const error = await service(client)
      .createIssue({
        project: "rossmannmerge",
        subject: SUBJECT,
        description: DESCRIPTION,
        tracker: "Błąd",
        priority: "Niski",
        custom_fields: { "Ważność": "nie dotyczy" },
        related_issue_id: 295394,
        dry_run: false
      })
      .catch((caught: unknown) => caught);

    expect(client.createIssueRelation).toHaveBeenCalledWith(300001, 295394, "relates");
    expect(error).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: expect.stringMatching(/#300001.*Ważność/s),
      details: { issue_id: 300001, failed_step: "verification" }
    });
    expect((error as Error).message).toMatch(/relation .*was created/);
  });

  it("still adds the relation, then reports a priority that did not persist", async () => {
    const lowered = { ...createdFixture, priority: { id: 4, name: "Normalny" } };
    const client = makeClient({ refetched: [lowered, withRelation(lowered)] });

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
    ).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      message: expect.stringContaining("priority"),
      details: { issue_id: 300001, failed_step: "verification" }
    });
    expect(client.createIssueRelation).toHaveBeenCalledOnce();
  });

  it.each([
    ["project", { project: { id: 2, name: "Rossmann Systemy Centralne | Zgłoszenia" } }],
    ["subject", { subject: "Inny temat" }]
  ])("reports the created issue and skips the relation when the %s did not persist", async (label, change) => {
    const client = makeClient({ refetched: [{ ...createdFixture, ...change }] });

    await expect(
      service(client).createIssue({
        project: "rossmannmerge",
        subject: SUBJECT,
        description: DESCRIPTION,
        tracker: "Błąd",
        related_issue_id: 295394,
        dry_run: false
      })
    ).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      message: expect.stringContaining(label),
      details: { issue_id: 300001, failed_step: "verification" }
    });
    expect(client.createIssueRelation).not.toHaveBeenCalled();
  });

  it("accepts a multi-value field that Redmine de-duplicated", async () => {
    const deduplicated = {
      ...createdFixture,
      custom_fields: [{ id: 43, name: "Dotyczy", value: ["a"] }]
    };
    const client = makeClient({ refetched: [deduplicated] });

    const result = await service(client).createIssue({
      project: "rossmannmerge",
      subject: SUBJECT,
      description: DESCRIPTION,
      tracker: "Błąd",
      priority: "Niski",
      custom_fields: { Dotyczy: ["a", "a"] },
      dry_run: false
    });

    expect(result.action).toBe("created");
  });

  it("accepts a relation that Redmine stored in the reverse direction", async () => {
    const reversed: RedmineIssue = {
      ...createdFixture,
      relations: [{ id: 90001, relation_type: "blocks", issue_id: testIssue.id, issue_to_id: createdFixture.id }]
    };
    const client = makeClient({ refetched: [createdFixture, reversed] });

    const result = await service(client).createIssue({
      project: "rossmannmerge",
      subject: SUBJECT,
      description: DESCRIPTION,
      tracker: "Błąd",
      priority: "Niski",
      related_issue_id: 295394,
      relation_type: "blocked",
      dry_run: false
    });

    expect(client.createIssueRelation).toHaveBeenCalledWith(300001, 295394, "blocked");
    expect(result.relation).toMatchObject({ type: "blocked", action: "related" });
  });

  it("says the relation was created when only the re-read after it fails", async () => {
    const client = makeClient({
      refetched: [createdFixture, new RedmineMcpError("UPSTREAM_ERROR", "Redmine request timed out after 15000ms.")]
    });

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

    expect(error).toMatchObject({ code: "UPSTREAM_ERROR", details: { issue_id: 300001, failed_step: "relation" } });
    expect((error as Error).message).toMatch(/relation to #295394 was created/);
    expect((error as Error).message).not.toMatch(/relation to #295394 failed/);
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

describe("create_issue attachments", () => {
  const SCREENSHOT_NAME = "Zrzut ekranu 2026-11-03 141516.png";
  const SCREENSHOT = `C:/Users/tsmierzchala/Pictures/Screenshots/${SCREENSHOT_NAME}`;
  const LOG = "C:/logs/pos.log";
  const files = new Map<string, Uint8Array>([
    [SCREENSHOT, new Uint8Array([137, 80, 78, 71])],
    [LOG, new Uint8Array([79, 75])],
    ["C:/logs/empty.log", new Uint8Array()]
  ]);
  const screenshotEntry = {
    filename: SCREENSHOT_NAME,
    content_type: "image/png",
    size: 4,
    embed: "!Zrzut%20ekranu%202026-11-03%20141516.png!"
  };
  const logEntry = { filename: "pos.log", content_type: "text/plain", size: 2, embed: null };
  const base = { project: "rossmannmerge", subject: SUBJECT, description: DESCRIPTION, tracker: "Błąd", priority: "Niski" };
  const withAttachments = (issue: RedmineIssue, filenames: string[]): RedmineIssue => ({
    ...issue,
    attachments: filenames.map((filename, index) => ({ id: 7000 + index, filename }))
  });

  it("lists every attachment in a dry-run preview without uploading", async () => {
    const client = makeClient();

    const result = await service(client, files).createIssue({ ...base, attachments: [SCREENSHOT, ` ${LOG} `] });

    expect(result.attachments).toEqual([screenshotEntry, logEntry]);
    expect(client.uploadAttachment).not.toHaveBeenCalled();
    expect(client.createIssue).not.toHaveBeenCalled();
    expect((await service(client, files).createIssue(base)).attachments).toEqual([]);
  });

  it.each([
    ["a missing file", "C:/logs/missing.log", /Unable to read file "C:\/logs\/missing.log"/],
    ["an empty file", "C:/logs/empty.log", /empty/],
    ["a blank path", "   ", /must not be blank/]
  ])("rejects %s before any write", async (_label, path, message) => {
    const client = makeClient();

    await expect(
      service(client, files).createIssue({ ...base, attachments: [SCREENSHOT, path], dry_run: false })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringMatching(message) });
    expect(client.getProject).not.toHaveBeenCalled();
    expect(client.uploadAttachment).not.toHaveBeenCalled();
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  it("rejects two attachments with the same file name", async () => {
    const client = makeClient();
    const twins = new Map([...files, ["C:/old/POS.log", new Uint8Array([1])]]);

    await expect(
      service(client, twins).createIssue({ ...base, attachments: [LOG, "C:/old/POS.log"] })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("pos.log") });
  });

  it("uploads every file first and sends the tokens in the create request", async () => {
    const client = makeClient({ refetched: [withAttachments(createdFixture, [SCREENSHOT_NAME, "pos.log"])] });

    const result = await service(client, files).createIssue({
      ...base,
      description: `${DESCRIPTION}\n\n!Zrzut%20ekranu%202026-11-03%20141516.png!`,
      attachments: [SCREENSHOT, LOG],
      dry_run: false
    });

    expect(client.uploadAttachment.mock.calls).toEqual([
      [SCREENSHOT_NAME, files.get(SCREENSHOT)],
      ["pos.log", files.get(LOG)]
    ]);
    expect(client.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        uploads: [
          { token: `token-${SCREENSHOT_NAME}`, filename: SCREENSHOT_NAME, content_type: "image/png" },
          { token: "token-pos.log", filename: "pos.log", content_type: "text/plain" }
        ]
      })
    );
    expect(client.uploadAttachment.mock.invocationCallOrder[1]).toBeLessThan(
      client.createIssue.mock.invocationCallOrder[0]!
    );
    expect(result.action).toBe("created");
    expect(result.attachments).toEqual([screenshotEntry, logEntry]);
  });

  it("names an attachment the way Redmine stores it", async () => {
    const quoted = "C:/logs/kasa 'A' 50%.log";
    const client = makeClient({ refetched: [withAttachments(createdFixture, ["kasa _A_ 50_.log"])] });

    const preview = await service(client, new Map([[quoted, new Uint8Array([1])]])).createIssue({
      ...base,
      attachments: [quoted]
    });
    expect(preview.attachments).toEqual([
      { filename: "kasa _A_ 50_.log", content_type: "text/plain", size: 1, embed: null }
    ]);

    await service(client, new Map([[quoted, new Uint8Array([1])]])).createIssue({
      ...base,
      attachments: [quoted],
      dry_run: false
    });
    expect(client.uploadAttachment).toHaveBeenCalledWith("kasa _A_ 50_.log", expect.any(Uint8Array));
  });

  it("drops everything up to the last backslash, as Redmine does on any host", () => {
    expect(redmineStoredFilename("a\\b.png")).toBe("b.png");
    expect(redmineStoredFilename("kasa 'A' 50%.log")).toBe("kasa _A_ 50_.log");
  });

  it("gives an image an embed string that survives Textile and Redmine's unescaping", async () => {
    const odd = "C:/logs/C++ log (2)!.PNG";
    const client = makeClient();

    const preview = await service(client, new Map([[odd, new Uint8Array([1])]])).createIssue({
      ...base,
      attachments: [odd]
    });

    // CGI.unescape turns "+" into a space; "(" and "!" end the Textile image src.
    expect(preview.attachments[0]?.embed).toBe("!C%2B%2B%20log%20%282%29%21.PNG!");
  });

  it.each([
    ["UPSTREAM_ERROR", "Redmine request timed out after 15000ms."],
    ["VALIDATION_ERROR", "Redmine rejected the request: Plik jest za duży"]
  ] as const)("creates nothing when an upload fails with %s", async (code, reason) => {
    const client = makeClient();
    client.uploadAttachment
      .mockResolvedValueOnce("token-1")
      .mockRejectedValueOnce(new RedmineMcpError(code, reason, { status: 422, errors: ["Plik jest za duży"] }));

    await expect(
      service(client, files).createIssue({ ...base, attachments: [SCREENSHOT, LOG], dry_run: false })
    ).rejects.toMatchObject({
      code,
      message: expect.stringMatching(/pos\.log.*No issue was created/s),
      details: { status: 422, errors: ["Plik jest za duży"] }
    });
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  it("still adds the relation, then reports an attachment missing after create", async () => {
    const partial = withAttachments(createdFixture, [SCREENSHOT_NAME]);
    const client = makeClient({ refetched: [partial, withRelation(partial)] });

    const error = await service(client, files)
      .createIssue({ ...base, attachments: [SCREENSHOT, LOG], related_issue_id: 295394, dry_run: false })
      .catch((caught: unknown) => caught);

    expect(client.createIssueRelation).toHaveBeenCalledWith(300001, 295394, "relates");
    expect(error).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: expect.stringMatching(/#300001.*attachment "pos\.log"/s),
      details: { issue_id: 300001, url: `${BASE_URL}/issues/300001`, failed_step: "verification" }
    });
    expect((error as Error).message).not.toContain(SCREENSHOT_NAME);
    expect((error as Error).message).toMatch(/relation .*was created/);
  });
});
