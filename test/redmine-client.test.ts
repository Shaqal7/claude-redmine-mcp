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