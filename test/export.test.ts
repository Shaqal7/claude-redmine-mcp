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

  it("does not retry non-upstream errors and still fails on them", async () => {
    const getIssue = vi.fn(async (): Promise<RedmineIssue> => {
      throw new RedmineMcpError("VALIDATION_ERROR", "bad");
    });
    const { client } = makeClient([issue(1)], { getIssue });
    const { opts } = makeOpts(client);

    await expect(exportProjects(opts)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(getIssue).toHaveBeenCalledTimes(1);
  });

  it("skips an issue with NOT_FOUND or AUTH_ERROR, logs id and code, and counts it", async () => {
    const base = [issue(1), issue(2), issue(3)];
    const getIssue = vi.fn(async (id: number): Promise<RedmineIssue> => {
      if (id === 2) throw new RedmineMcpError("NOT_FOUND", "gone");
      if (id === 3) throw new RedmineMcpError("AUTH_ERROR", "denied", { status: 403 });
      return { ...base[0]!, journals: [] };
    });
    const { client } = makeClient(base, { getIssue });
    const { opts, writes, logs } = makeOpts(client);

    const result = await exportProjects(opts);

    expect(idsOf(writes)).toEqual([1]);
    expect(result.skipped).toBe(2);
    expect(logs.some((l) => l.includes("2") && l.includes("NOT_FOUND"))).toBe(true);
    expect(logs.some((l) => l.includes("3") && l.includes("AUTH_ERROR"))).toBe(true);
    expect(getIssue).toHaveBeenCalledTimes(3);
  });

  it("N1: HTTP 401 aborts the run and proposes no state", async () => {
    const base = [issue(1), issue(2), issue(3)];
    const getIssue = vi.fn(async (id: number): Promise<RedmineIssue> => {
      if (id === 1) return { ...base[0]!, journals: [] };
      throw new RedmineMcpError("AUTH_ERROR", "revoked", { status: 401 });
    });
    const { client } = makeClient(base, { getIssue });
    const { opts } = makeOpts(client);

    await expect(exportProjects(opts)).rejects.toMatchObject({ code: "AUTH_ERROR" });
    expect(getIssue).toHaveBeenCalledTimes(2);
  });

  it("N1: an AUTH_ERROR without a known 403 status is not skipped", async () => {
    const getIssue = vi.fn(async (): Promise<RedmineIssue> => {
      throw new RedmineMcpError("AUTH_ERROR", "unknown");
    });
    const { client } = makeClient([issue(1), issue(2)], { getIssue });
    const { opts } = makeOpts(client);
    await expect(exportProjects(opts)).rejects.toMatchObject({ code: "AUTH_ERROR" });
  });

  it("N1: fails when every getIssue of a project was skipped although the listing had issues", async () => {
    const getIssue = vi.fn(async (): Promise<RedmineIssue> => {
      throw new RedmineMcpError("NOT_FOUND", "gone");
    });
    const { client } = makeClient([issue(1), issue(2)], { getIssue });
    const { opts, writes } = makeOpts(client);

    await expect(exportProjects(opts)).rejects.toThrow(/every issue|all issues/i);
    expect(Object.keys(writes)).toHaveLength(0);
  });

  it("N1: does not fail when only some getIssue calls were skipped", async () => {
    const base = [issue(1), issue(2)];
    const getIssue = vi.fn(async (id: number): Promise<RedmineIssue> => {
      if (id === 2) throw new RedmineMcpError("NOT_FOUND", "gone");
      return { ...base[0]!, journals: [] };
    });
    const { client } = makeClient(base, { getIssue });
    const { opts } = makeOpts(client);
    const result = await exportProjects(opts);
    expect(result.skipped).toBe(1);
  });

  it("I1: never writes an issue whose own project differs from the requested one (listed subproject issue)", async () => {
    const child: RedmineIssue = { ...issue(2), project: { id: 99, name: "SecretChild" } };
    const { client } = makeClient([issue(1), child]);
    const { opts, writes, logs } = makeOpts(client);

    const result = await exportProjects(opts);

    expect(idsOf(writes)).toEqual([1]);
    expect(client.getIssue).not.toHaveBeenCalledWith(2, expect.anything());
    expect(result.skipped).toBe(1);
    expect(logs.some((l) => l.includes("2"))).toBe(true);
    expect(logs.join(" | ")).not.toContain("SecretChild");
  });

  it("I1: skips an issue that was moved to another project between listing and getIssue", async () => {
    const base = [issue(1), issue(2)];
    const getIssue = vi.fn(async (id: number): Promise<RedmineIssue> => {
      const found = base.find((i) => i.id === id)!;
      return id === 2 ? { ...found, project: { id: 99, name: "Elsewhere" }, journals: [] } : { ...found, journals: [] };
    });
    const { client } = makeClient(base, { getIssue });
    const { opts, writes } = makeOpts(client);

    const result = await exportProjects(opts);

    expect(idsOf(writes)).toEqual([1]);
    expect(result.skipped).toBe(1);
  });

  it("I1: asks Redmine to exclude subprojects", async () => {
    const { client, listCalls } = makeClient([issue(1)]);
    const { opts } = makeOpts(client);
    await exportProjects(opts);
    expect(listCalls[0]!.subprojectId).toBe("!*");
  });

  it("I2: after 3 incomplete listings keeps the previous last_updated_on (or omits the project)", async () => {
    const issues = Array.from({ length: 5 }, (_, i) => issue(i + 1));
    const listIssues = vi.fn(async (params: ListParams) => ({
      issues: issues.slice(0, 4),
      total_count: 5,
      limit: params.limit,
      offset: params.offset ?? 0
    }));
    const prev: RedmineState = { projects: { rossmannmerge: { last_updated_on: "2026-10-20T12:00:00Z" } } };

    const a = makeOpts(makeClient(issues, { listIssues }).client, { state: prev });
    const withPrev = await exportProjects(a.opts);
    expect(withPrev.written.rossmannmerge).toBe(4);
    expect(withPrev.nextState.projects.rossmannmerge).toEqual({ last_updated_on: "2026-10-20T12:00:00Z" });

    const b = makeOpts(makeClient(issues, { listIssues }).client);
    const noPrev = await exportProjects(b.opts);
    expect(noPrev.nextState.projects.rossmannmerge).toBeUndefined();
  });

  it("M1: normalizes --since to seconds precision UTC", async () => {
    const { client, listCalls } = makeClient([issue(1)]);
    const { opts } = makeOpts(client, { since: "2026-10-01T00:00:00.000+02:00" });
    await exportProjects(opts);
    expect(listCalls[0]!.updatedOnFrom).toBe("2026-09-30T22:00:00Z");
  });

  it("M1: rejects an unparsable --since with VALIDATION_ERROR", async () => {
    const { client } = makeClient([issue(1)]);
    const { opts } = makeOpts(client, { since: "yesterday" });
    await expect(exportProjects(opts)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
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
    expect(result).toEqual({ written: { rossmannmerge: 3 }, skipped: 0 });
  });

  it("I1: leaves ids of other projects out of ids.json", async () => {
    const child: RedmineIssue = { ...issue(2), project: { id: 99, name: "SecretChild" } };
    const { client, listCalls } = makeClient([issue(1), child]);
    const { opts, writes } = makeOpts(client);
    const { state: _state, ...reconcileOpts } = opts;

    await reconcileProjects(reconcileOpts);

    expect(JSON.parse(writes["/out/rossmannmerge.ids.json"]!).ids).toEqual([1]);
    expect(listCalls[0]!.subprojectId).toBe("!*");
  });

  it("I3: bounds the listing by created_on so a delete plus a create cannot hide a live id", async () => {
    let live = Array.from({ length: 10 }, (_, i) => ({ ...issue(i + 1), created_on: "2026-10-01T00:00:00Z" }));
    let pagesServed = 0;
    const { client } = makeClient([], {
      listIssues: vi.fn(async (params: ListParams) => {
        const offset = params.offset ?? 0;
        let view = live;
        if (params.createdOnTo) {
          view = view.filter((i) => (i.created_on ?? "") <= params.createdOnTo!);
        }
        const out = { issues: view.slice(offset, offset + params.limit), total_count: view.length, limit: params.limit, offset };
        pagesServed += 1;
        if (pagesServed === 1) {
          // po pierwszej stronie: id 1 usunięte, id 11 utworzone (po starcie reconcile)
          live = [...live.filter((i) => i.id !== 1), { ...issue(11), created_on: "2026-10-29T10:00:01Z" }];
        }
        return out;
      })
    });
    const { opts, writes } = makeOpts(client, { pageSize: 5 });
    const { state: _state, ...reconcileOpts } = opts;

    await reconcileProjects(reconcileOpts);

    const ids = JSON.parse(writes["/out/rossmannmerge.ids.json"]!).ids as number[];
    expect(ids).toContain(6);
    expect(ids).not.toContain(11);
    expect(ids).toEqual(expect.arrayContaining([2, 3, 4, 5, 6, 7, 8, 9, 10]));
  });
});
