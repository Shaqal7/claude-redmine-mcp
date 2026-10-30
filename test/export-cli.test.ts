import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/export/cli.js";

const ENV_KEYS = [
  "REDMINE_BASE_URL",
  "REDMINE_API_KEY",
  "REDMINE_ALLOWED_PROJECTS",
  "REDMINE_DEFAULT_EXTERNAL_PROJECTS"
] as const;

const FAKE_KEY = "fake0123456789abcdef";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function redmineFetch(projectIdentifier = "rossmannmerge") {
  return vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.pathname === "/projects/rossmannmerge.json") {
      return json({ project: { id: 7, name: "Rossmann Merge", identifier: projectIdentifier } });
    }
    if (url.pathname === "/issues.json") {
      const issue = { id: 1, project: { id: 7, name: "Rossmann Merge" }, status: { id: 1, name: "Nowe" }, subject: "fake", updated_on: "2026-10-01T08:00:00Z" };
      return json({ issues: [issue], total_count: 1, limit: 100, offset: 0 });
    }
    if (url.pathname === "/issues/1.json") {
      return json({ issue: { id: 1, project: { id: 7, name: "Rossmann Merge" }, status: { id: 1, name: "Nowe" }, subject: "fake", updated_on: "2026-10-01T08:00:00Z", journals: [] } });
    }
    return new Response("{}", { status: 404 });
  });
}

describe("redmine-export CLI", () => {
  let dir: string;
  let envFile: string;
  let stderr: string[];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "redmine-export-test-"));
    envFile = join(dir, "test.env");
    await writeFile(
      envFile,
      [
        "REDMINE_BASE_URL=https://redmine.example.com",
        `REDMINE_API_KEY=${FAKE_KEY}`,
        "REDMINE_ALLOWED_PROJECTS=rossmannmerge",
        "REDMINE_DEFAULT_EXTERNAL_PROJECTS=rossmannmerge"
      ].join("\n"),
      "utf-8"
    );
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("exit 0: writes JSONL and the proposed state, leaves --state untouched", async () => {
    vi.stubGlobal("fetch", redmineFetch());
    const statePath = join(dir, "state.json");
    const original = JSON.stringify({ projects: { rossmannmerge: { last_updated_on: "2026-09-01T00:00:00Z" } } });
    await writeFile(statePath, original, "utf-8");

    await main(["--projects", "rossmannmerge", "--out", join(dir, "out"), "--state", statePath, "--state-out", join(dir, "next.json"), "--env", envFile]);

    expect(process.exitCode ?? 0).toBe(0);
    const lines = (await readFile(join(dir, "out", "rossmannmerge.jsonl"), "utf-8")).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const next = JSON.parse(await readFile(join(dir, "next.json"), "utf-8"));
    expect(next.projects.rossmannmerge.last_updated_on).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(await readFile(statePath, "utf-8")).toBe(original);
    expect(stderr.join("")).not.toContain(FAKE_KEY);
  });

  it("--reconcile writes ids.json and never writes --state-out", async () => {
    vi.stubGlobal("fetch", redmineFetch());
    const stateOut = join(dir, "next.json");

    await main(["--projects", "rossmannmerge", "--out", join(dir, "out"), "--state-out", stateOut, "--reconcile", "--env", envFile]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(await readFile(join(dir, "out", "rossmannmerge.ids.json"), "utf-8")).ids).toEqual([1]);
    expect(existsSync(stateOut)).toBe(false);
  });

  it("exit 2 for a project outside the allowlist, nothing written", async () => {
    vi.stubGlobal("fetch", redmineFetch("someoneelse"));

    await main(["--projects", "rossmannmerge", "--out", join(dir, "out"), "--env", envFile]);

    expect(process.exitCode).toBe(2);
    expect(existsSync(join(dir, "out"))).toBe(false);
    expect(stderr.join("")).toContain("POLICY_ERROR");
  });

  it("exit 1 when the --env file cannot be read (path only in the message)", async () => {
    vi.stubGlobal("fetch", redmineFetch());
    const missing = join(dir, "missing.env");

    await main(["--projects", "rossmannmerge", "--out", join(dir, "out"), "--env", missing]);

    expect(process.exitCode).toBe(1);
    expect(stderr.join("")).toContain(missing);
  });

  it("values from --env win over shell variables", async () => {
    process.env.REDMINE_ALLOWED_PROJECTS = "shell-only-project";
    vi.stubGlobal("fetch", redmineFetch());

    await main(["--projects", "rossmannmerge", "--out", join(dir, "out"), "--env", envFile]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(existsSync(join(dir, "out", "rossmannmerge.jsonl"))).toBe(true);
  });

  it("exit 1 when --state and --state-out are the same file", async () => {
    vi.stubGlobal("fetch", redmineFetch());
    const same = join(dir, "state.json");

    await main(["--projects", "rossmannmerge", "--out", join(dir, "out"), "--state", same, "--state-out", same, "--env", envFile]);

    expect(process.exitCode).toBe(1);
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("exit 1 on missing required arguments", async () => {
    await main(["--out", join(dir, "out")]);
    expect(process.exitCode).toBe(1);
  });
});
