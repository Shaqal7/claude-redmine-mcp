import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { RedmineMcpError } from "../src/errors.js";

describe("loadConfig", () => {
  it("parses environment variables", () => {
    const config = loadConfig({
      REDMINE_BASE_URL: "https://redmine.example.com/",
      REDMINE_API_KEY: "secret",
      REDMINE_ALLOWED_PROJECTS: "backend, frontend ",
      REDMINE_DEFAULT_EXTERNAL_PROJECTS: "frontend, ",
      REDMINE_TIMEOUT_MS: "20000"
    });

    expect(config.redmineBaseUrl).toBe("https://redmine.example.com");
    expect(config.allowedProjects).toEqual(["backend", "frontend"]);
    expect(config.defaultExternalProjects).toEqual(["frontend"]);
    expect(config.timeoutMs).toBe(20000);
  });

  it("rejects missing default external projects", () => {
    expect(() =>
      loadConfig({
        REDMINE_BASE_URL: "https://redmine.example.com",
        REDMINE_API_KEY: "secret",
        REDMINE_ALLOWED_PROJECTS: "backend"
      })
    ).toThrowError(RedmineMcpError);
  });

  it("rejects default external projects outside the allowlist", () => {
    expect(() =>
      loadConfig({
        REDMINE_BASE_URL: "https://redmine.example.com",
        REDMINE_API_KEY: "secret",
        REDMINE_ALLOWED_PROJECTS: "backend",
        REDMINE_DEFAULT_EXTERNAL_PROJECTS: "frontend"
      })
    ).toThrowError(RedmineMcpError);
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