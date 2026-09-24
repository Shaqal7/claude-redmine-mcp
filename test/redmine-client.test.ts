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