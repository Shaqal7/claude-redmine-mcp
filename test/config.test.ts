import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { RedmineMcpError } from "../src/errors.js";

describe("loadConfig", () => {
  it("parses environment variables", () => {
    const config = loadConfig({
      REDMINE_BASE_URL: "https://redmine.example.com/",
      REDMINE_API_KEY: "secret",
      REDMINE_ALLOWED_PROJECTS: "backend, frontend ",
      REDMINE_TIMEOUT_MS: "20000"
    });

    expect(config.redmineBaseUrl).toBe("https://redmine.example.com");
    expect(config.allowedProjects).toEqual(["backend", "frontend"]);
    expect(config.timeoutMs).toBe(20000);
  });

  it("rejects missing allowlist", () => {
    expect(() =>
      loadConfig({
        REDMINE_BASE_URL: "https://redmine.example.com",
        REDMINE_API_KEY: "secret"
      })
    ).toThrowError(RedmineMcpError);
  });
});