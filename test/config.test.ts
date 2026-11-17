import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

  const baseEnv = {
    REDMINE_BASE_URL: "https://redmine.example.com",
    REDMINE_API_KEY: "secret",
    REDMINE_ALLOWED_PROJECTS: "backend",
    REDMINE_DEFAULT_EXTERNAL_PROJECTS: "backend"
  };

  it("defaults the download folder to <temp>/redmine-mcp-attachments", () => {
    expect(loadConfig(baseEnv).downloadDir).toBe(join(tmpdir(), "redmine-mcp-attachments"));
    expect(loadConfig({ ...baseEnv, REDMINE_DOWNLOAD_DIR: "  " }).downloadDir).toBe(
      join(tmpdir(), "redmine-mcp-attachments")
    );
  });

  it("takes an absolute REDMINE_DOWNLOAD_DIR, normalized", () => {
    const folder = join(tmpdir(), "elsewhere", "..", "redmine-downloads");

    expect(loadConfig({ ...baseEnv, REDMINE_DOWNLOAD_DIR: ` ${folder} ` }).downloadDir).toBe(
      resolve(tmpdir(), "redmine-downloads")
    );
  });

  it("rejects a relative REDMINE_DOWNLOAD_DIR", () => {
    expect(() => loadConfig({ ...baseEnv, REDMINE_DOWNLOAD_DIR: "~/redmine" })).toThrowError(/REDMINE_DOWNLOAD_DIR/);
  });
});