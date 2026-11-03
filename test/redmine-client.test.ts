import { describe, expect, it, vi } from "vitest";

import { RedmineClient } from "../src/redmine/client.js";
import type { AppConfig } from "../src/types.js";

const config: AppConfig = {
  redmineBaseUrl: "https://redmine.example.com",
  redmineApiKey: "secret",
  allowedProjects: ["backend"],
  timeoutMs: 5_000
};

describe("RedmineClient", () => {
  it("sends the API key header and query params", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      expect(String(input)).toContain("/issues.json");
      expect(String(input)).toContain("project_id=1");
      return new Response(
        JSON.stringify({
          issues: [],
          total_count: 0,
          limit: 10,
          offset: 0
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });

    const client = new RedmineClient(config, fetchMock as typeof fetch);
    await client.listIssues({ projectId: 1, limit: 10, sort: "updated_on:desc" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({
      "X-Redmine-API-Key": "secret"
    });
  });

  it("passes updated_on window and include", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("updated_on")).toBe("><2026-10-01T00:00:00Z|2026-10-29T10:00:00Z");
      expect(url.searchParams.get("include")).toBe("relations,attachments");
      expect(url.searchParams.get("sort")).toBe("updated_on:asc");
      return new Response(JSON.stringify({ issues: [], total_count: 0, limit: 100, offset: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = new RedmineClient(config, fetchMock as typeof fetch);
    await client.listIssues({
      projectId: 1,
      limit: 100,
      updatedOnFrom: "2026-10-01T00:00:00Z",
      updatedOnTo: "2026-10-29T10:00:00Z",
      include: ["relations", "attachments"],
      sort: "updated_on:asc"
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("passes open-ended updated_on when only from is given and omits empty include", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("updated_on")).toBe(">=2026-10-01T00:00:00Z");
      expect(url.searchParams.has("include")).toBe(false);
      return new Response(JSON.stringify({ issues: [], total_count: 0, limit: 100, offset: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = new RedmineClient(config, fetchMock as typeof fetch);
    await client.listIssues({ projectId: 1, limit: 100, updatedOnFrom: "2026-10-01T00:00:00Z", include: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("passes subproject_id, created_on upper bound and open-start updated_on", async () => {
    const urls: URL[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify({ issues: [], total_count: 0, limit: 100, offset: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = new RedmineClient(config, fetchMock as typeof fetch);
    await client.listIssues({ projectId: 1, limit: 100, subprojectId: "!*", createdOnTo: "2026-10-29T10:00:00Z", updatedOnTo: "2026-10-29T10:00:00Z" });
    expect(urls[0]!.searchParams.get("subproject_id")).toBe("!*");
    expect(urls[0]!.searchParams.get("created_on")).toBe("<=2026-10-29T10:00:00Z");
    expect(urls[0]!.searchParams.get("updated_on")).toBe("<=2026-10-29T10:00:00Z");
  });

  it("builds project-scoped search URLs with Redmine's all_words semantics", async () => {
    const urls: URL[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify({ results: [], total_count: 0, offset: 0, limit: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = new RedmineClient(config, fetchMock as typeof fetch);

    await client.searchProjectIssues({ projectRef: "rossmannmerge", query: "automatyczna fiskalizacja", limit: 100 });
    await client.searchProjectIssues({
      projectRef: "rossmannmerge",
      query: "eParagon",
      limit: 100,
      allWords: false,
      titlesOnly: true
    });

    expect(urls[0]?.pathname).toBe("/projects/rossmannmerge/search.json");
    expect(urls[0]?.searchParams.get("q")).toBe("automatyczna fiskalizacja");
    expect(urls[0]?.searchParams.get("issues")).toBe("1");
    expect(urls[0]?.searchParams.get("all_words")).toBe("1");
    expect(urls[0]?.searchParams.has("titles_only")).toBe(false);
    // Redmine treats a present-but-blank all_words as "any word".
    expect(urls[1]?.searchParams.get("all_words")).toBe("");
    expect(urls[1]?.searchParams.get("titles_only")).toBe("1");
  });

  it("sends journal note edits as PUT /journals/{id}.json", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new RedmineClient(config, fetchMock as typeof fetch);

    await client.updateJournalNotes(1632168, "poprawiona treść");

    const [input, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(input)).toBe("https://redmine.example.com/journals/1632168.json");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ journal: { notes: "poprawiona treść" } });
  });

  it("creates issues with POST /issues.json and returns the created issue", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ issue: { id: 300001, subject: "x" } }), {
        status: 201,
        headers: { "content-type": "application/json" }
      })
    );
    const client = new RedmineClient(config, fetchMock as typeof fetch);

    const created = await client.createIssue({ project_id: 192, subject: "x", description: "y" });

    const [input, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(input)).toBe("https://redmine.example.com/issues.json");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ issue: { project_id: 192, subject: "x", description: "y" } });
    expect(created.id).toBe(300001);
  });

  it("rejects a create response without an issue id", async () => {
    const client = new RedmineClient(
      config,
      vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch
    );

    await expect(client.createIssue({ project_id: 192 })).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("creates relations with POST /issues/{id}/relations.json", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ relation: { id: 1, issue_id: 300001, issue_to_id: 295394, relation_type: "relates" } }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    );
    const client = new RedmineClient(config, fetchMock as typeof fetch);

    const relation = await client.createIssueRelation(300001, 295394, "relates");

    const [input, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(input)).toBe("https://redmine.example.com/issues/300001/relations.json");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ relation: { issue_to_id: 295394, relation_type: "relates" } });
    expect(relation.issue_to_id).toBe(295394);
  });

  it("reads project trackers and issue custom fields, priorities, trackers and issue custom field definitions", async () => {
    const urls: URL[] = [];
    const bodies: Record<string, unknown> = {
      "/projects/rossmannmerge.json": {
        project: { id: 192, name: "M", identifier: "rossmannmerge", trackers: [{ id: 1, name: "Błąd" }], issue_custom_fields: [{ id: 1, name: "Ważność " }] }
      },
      "/enumerations/issue_priorities.json": { issue_priorities: [{ id: 3, name: "Niski", is_default: false, active: true }] },
      "/trackers.json": { trackers: [{ id: 1, name: "Błąd", default_status: { id: 1, name: "Nowy" } }] },
      "/custom_fields.json": {
        custom_fields: [
          { id: 1, name: "Ważność ", customized_type: "issue", is_required: true },
          { id: 99, name: "Dział", customized_type: "user", is_required: true }
        ]
      }
    };
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      urls.push(url);
      return new Response(JSON.stringify(bodies[url.pathname]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = new RedmineClient(config, fetchMock as typeof fetch);

    const metadata = await client.getProjectIssueMetadata("rossmannmerge");
    const priorities = await client.listIssuePriorities();
    const trackers = await client.listTrackers();
    const definitions = await client.listIssueCustomFieldDefinitions();

    expect(urls[0]?.searchParams.get("include")).toBe("trackers,issue_custom_fields");
    expect(metadata).toEqual({ trackers: [{ id: 1, name: "Błąd" }], issue_custom_fields: [{ id: 1, name: "Ważność " }] });
    expect(priorities).toEqual([{ id: 3, name: "Niski", is_default: false, active: true }]);
    expect(trackers).toEqual([{ id: 1, name: "Błąd" }]);
    expect(definitions.map((definition) => definition.id)).toEqual([1]);
  });

  it("maps 422 responses to validation errors", async () => {
    const client = new RedmineClient(
      config,
      vi.fn(async () =>
        new Response(JSON.stringify({ errors: ["Status is invalid"] }), {
          status: 422,
          headers: { "content-type": "application/json" }
        })
      ) as typeof fetch
    );

    await expect(client.updateIssue(1, { status_id: 9 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
  });
});