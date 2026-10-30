import { describe, expect, it, vi } from "vitest";

import { exportProjects, reconcileProjects, type RedmineClientLike, type RedmineState } from "../src/export/exporter.js";
import { RedmineMcpError } from "../src/errors.js";
import { ProjectPolicy } from "../src/redmine/policy.js";
import type { RedmineIssue } from "../src/types.js";

type ListParams = Parameters<RedmineClientLike["listIssues"]>[0];

const project = { id: 7, name: "Rossmann Merge", identifier: "rossmannmerge" };
const NOW = new Date("2026-10-29T10:00:00.123Z");

function issue(id: number, updatedOn = "2026-10-01T08:00:00Z"): RedmineIssue {
  return {
    id,
    project: { id: 7, name: "Rossmann Merge" },
    status: { id: 1, name: "Nowe" },
    subject: `fake subject ${id}`,
    updated_on: updatedOn
  };
}

function makeClient(issues: RedmineIssue[], overrides: Partial<RedmineClientLike> = {}) {
  const listCalls: ListParams[] = [];
  const client: RedmineClientLike = {
    getProject: vi.fn(async () => project),
    listIssues: vi.fn(async (params: ListParams) => {
      listCalls.push(params);
      const offset = params.offset ?? 0;
      return { issues: issues.slice(offset, offset + params.limit), total_count: issues.length, limit: params.limit, offset };
    }),
    getIssue: vi.fn(async (id: number) => ({
      ...(issues.find((i) => i.id === id) as RedmineIssue),
      journals: [{ id: id * 10, notes: "fake note", created_on: "2026-10-02T08:00:00Z", private_notes: false }]
    })),
    ...overrides
  };
  return { client, listCalls };
}

function makeOpts(client: RedmineClientLike, extra: Record<string, unknown> = {}) {
  const writes: Record<string, string> = {};
  const logs: string[] = [];
  return {
    writes,
    logs,
    opts: {
      client,
      policy: new ProjectPolicy(["rossmannmerge"]),
      projects: ["rossmannmerge"],
      state: { projects: {} } as RedmineState,
      outDir: "/out",
      now: () => NOW,
      log: (m: string) => void logs.push(m),
      sleep: async () => {},
      writeFile: async (path: string, content: string) => {
        writes[path] = content;
      },
      ...extra
    }
  };
}

function idsOf(writes: Record<string, string>): number[] {
  return writes["/out/rossmannmerge.jsonl"]!
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l).issue.id);
}

describe("exportProjects", () => {
  it("writes one JSONL line per issue with journals and proposes next state", async () => {
    const { client } = makeClient([issue(1, "2026-10-01T08:00:00Z"), issue(2, "2026-10-05T08:00:00Z")]);
    const state: RedmineState = { projects: { rossmannmerge: { last_updated_on: "2026-09-01T00:00:00Z" } } };
    const snapshot = structuredClone(state);
    const { opts, writes } = makeOpts(client, { state });

    const result = await exportProjects(opts);

    const lines = writes["/out/rossmannmerge.jsonl"]!.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: "issue", project: "rossmannmerge", exported_at: "2026-10-29T10:00:00Z" });
    expect(lines[0].issue.id).toBe(1);
    expect(lines[0].issue.journals[0].private_notes).toBe(false);
    expect(result.written).toEqual({ rossmannmerge: 2 });
    expect(result.nextState.projects.rossmannmerge!.last_updated_on).toBe("2026-10-29T10:00:00Z");
    expect(state).toEqual(snapshot);
  });

  it("uses state minus 10 minutes as window start and now as window end, both without fractional seconds", async () => {
    const { client, listCalls } = makeClient([issue(1)]);
    const state: RedmineState = { projects: { rossmannmerge: { last_updated_on: "2026-10-20T12:00:00Z" } } };
    const { opts } = makeOpts(client, { state });

    await exportProjects(opts);

    expect(listCalls[0]).toMatchObject({
      projectId: 7,
      statusId: "*",
      updatedOnFrom: "2026-10-20T11:50:00Z",
      updatedOnTo: "2026-10-29T10:00:00Z",
      sort: "updated_on:asc",
      include: ["relations", "attachments"]
    });
    expect(client.getIssue).toHaveBeenCalledWith(1, ["journals", "relations", "attachments"]);
  });

  it("ignoreState exports everything (no updatedOnFrom)", async () => {
    const { client, listCalls } = makeClient([issue(1)]);
    const state: RedmineState = { projects: { rossmannmerge: { last_updated_on: "2026-10-20T12:00:00Z" } } };
    const { opts } = makeOpts(client, { state, ignoreState: true });

    await exportProjects(opts);

    expect(listCalls[0]!.updatedOnFrom).toBeUndefined();
    expect(listCalls[0]!.updatedOnTo).toBe("2026-10-29T10:00:00Z");
  });

  it("exports everything when the project has no state yet", async () => {
    const { client, listCalls } = makeClient([issue(1)]);
    const { opts } = makeOpts(client);
    await exportProjects(opts);
    expect(listCalls[0]!.updatedOnFrom).toBeUndefined();
  });

  it("since overrides state window start", async () => {
    const { client, listCalls } = makeClient([issue(1)]);
    const state: RedmineState = { projects: { rossmannmerge: { last_updated_on: "2026-10-20T12:00:00Z" } } };
    const { opts } = makeOpts(client, { state, since: "2026-10-02T03:04:05Z" });

    await exportProjects(opts);

    expect(listCalls[0]!.updatedOnFrom).toBe("2026-10-02T03:04:05Z");
  });

  it("paginates until total_count is reached and dedupes ids", async () => {
    const issues = Array.from({ length: 250 }, (_, i) => issue(i + 1));
    const { client, listCalls } = makeClient(issues);
    const { opts, writes } = makeOpts(client, { pageSize: 100 });

    await exportProjects(opts);

    expect(listCalls.map((c) => c.offset)).toEqual([0, 100, 200]);
    const ids = idsOf(writes);
    expect(ids).toHaveLength(250);
    expect(new Set(ids).size).toBe(250);
  });

  it("writes a single line for an issue repeated on two pages", async () => {
    const issues = Array.from({ length: 250 }, (_, i) => issue(i + 1));
    const withDup = [...issues.slice(0, 100), issues[0]!, ...issues.slice(101)];
    const { client } = makeClient(withDup);
    const { opts, writes } = makeOpts(client, { pageSize: 100 });

    await exportProjects(opts);

    const ids = idsOf(writes);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === 1)).toHaveLength(1);
  });

  it("relists when unique id count differs from total_count", async () => {
    const issues = Array.from({ length: 250 }, (_, i) => issue(i + 1));
    let listing = 0;
    const { client } = makeClient(issues, {
      listIssues: vi.fn(async (params: ListParams) => {
        const offset = params.offset ?? 0;
        if (offset === 0) listing += 1;
        // pierwsze listowanie: zadanie znika z okna między stronami, więc strona 2 startuje o 1 dalej (id 101 przepada)
        const shifted = listing === 1 && offset > 0 ? offset + 1 : offset;
        return { issues: issues.slice(shifted, shifted + params.limit), total_count: 250, limit: params.limit, offset };
      })
    });
    const { opts, writes, logs } = makeOpts(client, { pageSize: 100 });

    await exportProjects(opts);

    expect(listing).toBe(2);
    expect(logs.some((l) => l.includes("relist"))).toBe(true);
    expect(idsOf(writes)).toHaveLength(250);
  });

  it("warns after 3 listing attempts and still exports what it has", async () => {
    const issues = Array.from({ length: 5 }, (_, i) => issue(i + 1));
    let listing = 0;
    const { client } = makeClient(issues, {
      listIssues: vi.fn(async (params: ListParams) => {
        if ((params.offset ?? 0) === 0) listing += 1;
        return { issues: issues.slice(0, 4), total_count: 5, limit: params.limit, offset: params.offset ?? 0 };
      })
    });
    const { opts, writes, logs } = makeOpts(client, { pageSize: 100 });

    const result = await exportProjects(opts);

    expect(listing).toBe(3);
    expect(logs.some((l) => l.toLowerCase().includes("warning"))).toBe(true);
    expect(result.written.rossmannmerge).toBe(4);
    expect(writes["/out/rossmannmerge.jsonl"]).toBeDefined();
  });

  it("rejects project outside allowlist with POLICY_ERROR before writing", async () => {
    const { client } = makeClient([issue(1)]);
    const { opts, writes } = makeOpts(client, { policy: new ProjectPolicy(["other"]) });

    await expect(exportProjects(opts)).rejects.toMatchObject({ code: "POLICY_ERROR" });
    expect(Object.keys(writes)).toHaveLength(0);
    expect(client.listIssues).not.toHaveBeenCalled();
  });

  it("propagates writeFile error and does not return nextState", async () => {
    const { client } = makeClient([issue(1)]);
    const { opts } = makeOpts(client, {
      writeFile: async () => {
        throw new Error("disk full");
      }
    });

    await expect(exportProjects(opts)).rejects.toThrow("disk full");
  });

  it("retries getIssue up to 3 times on UPSTREAM_ERROR then fails", async () => {
    const getIssue = vi.fn(async (): Promise<RedmineIssue> => {
      throw new RedmineMcpError("UPSTREAM_ERROR", "boom");
    });
    const { client } = makeClient([issue(1)], { getIssue });
    const { opts } = makeOpts(client);

    await expect(exportProjects(opts)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(getIssue).toHaveBeenCalledTimes(3);
  });

  it("succeeds when getIssue recovers on a retry", async () => {
    let n = 0;
    const base = issue(1);
    const getIssue = vi.fn(async (): Promise<RedmineIssue> => {
      n += 1;
      if (n < 3) throw new RedmineMcpError("UPSTREAM_ERROR", "boom");
      return { ...base, journals: [] };
    });
    const { client } = makeClient([base], { getIssue });
    const { opts, writes } = makeOpts(client);

    await exportProjects(opts);

    expect(getIssue).toHaveBeenCalledTimes(3);
    expect(idsOf(writes)).toEqual([1]);
  });

  it("does not retry non-upstream errors", async () => {
    const getIssue = vi.fn(async (): Promise<RedmineIssue> => {
      throw new RedmineMcpError("AUTH_ERROR", "denied");
    });
    const { client } = makeClient([issue(1)], { getIssue });
    const { opts } = makeOpts(client);

    await expect(exportProjects(opts)).rejects.toMatchObject({ code: "AUTH_ERROR" });
    expect(getIssue).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileProjects", () => {
  it("writes ids.json with sorted ids, no include and no state file", async () => {
    const { client, listCalls } = makeClient([issue(30), issue(5), issue(12)]);
    const { opts, writes } = makeOpts(client);
    const { state: _state, ...reconcileOpts } = opts;

    const result = await reconcileProjects(reconcileOpts);

    expect(Object.keys(writes)).toEqual(["/out/rossmannmerge.ids.json"]);
    expect(JSON.parse(writes["/out/rossmannmerge.ids.json"]!)).toEqual({
      project: "rossmannmerge",
      exported_at: "2026-10-29T10:00:00Z",
      ids: [5, 12, 30]
    });
    expect(listCalls[0]!.include).toBeUndefined();
    expect(listCalls[0]!.updatedOnFrom).toBeUndefined();
    expect(client.getIssue).not.toHaveBeenCalled();
    expect(result).toEqual({ written: { rossmannmerge: 3 } });
  });
});
