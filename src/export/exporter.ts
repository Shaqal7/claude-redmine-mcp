import { RedmineMcpError } from "../errors.js";
import type { ProjectPolicy } from "../redmine/policy.js";
import type { RedmineClient } from "../redmine/client.js";
import type { ProjectRef, RedmineIssue } from "../types.js";

export type RedmineClientLike = Pick<RedmineClient, "getProject" | "listIssues" | "getIssue">;

/** Proponowany stan eksportu; trwały zapis robi `kb` po udanym indeksowaniu. */
export type RedmineState = { projects: Record<string, { last_updated_on: string }> };

type CommonOptions = {
  client: RedmineClientLike;
  policy: ProjectPolicy;
  projects: string[];
  outDir: string;
  now: () => Date;
  pageSize?: number;
  log: (msg: string) => void;
  writeFile: (path: string, content: string) => Promise<void>;
};

export type ExportOptions = CommonOptions & {
  state: RedmineState;
  ignoreState?: boolean;
  since?: string;
  /** Pauza między próbami getIssue (wstrzykiwana w testach). */
  sleep?: (ms: number) => Promise<void>;
};

export type ReconcileOptions = CommonOptions;

const DEFAULT_PAGE_SIZE = 100;
const WINDOW_MARGIN_MS = 10 * 60 * 1000;
const MAX_LIST_ATTEMPTS = 3;
const MAX_GET_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

/** ISO 8601 bez ułamków sekund (`YYYY-MM-DDTHH:MM:SSZ`), format akceptowany przez filtr Redmine. */
export function toRedmineDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

type ResolvedProject = { slug: string; ref: ProjectRef };

/** Sprawdza allowlistę dla wszystkich projektów, zanim cokolwiek zostanie zapisane. */
async function resolveProjects(opts: CommonOptions): Promise<ResolvedProject[]> {
  const resolved: ResolvedProject[] = [];
  for (const requested of opts.projects) {
    const ref = await opts.client.getProject(requested);
    opts.policy.assertProjectAllowed(ref);
    resolved.push({ slug: (ref.identifier ?? requested).toLowerCase(), ref });
  }
  return resolved;
}

type ListWindow = { updatedOnFrom?: string; updatedOnTo?: string; include?: string[] };

/**
 * Listuje wszystkie ID zadań projektu. Paginacja po offsecie przesuwa się, gdy zadanie
 * wypada z okna między stronami, więc liczba unikalnych ID musi zgadzać się z total_count
 * z pierwszej strony; inaczej listowanie jest powtarzane (maks. 3 razy).
 */
async function listAllIds(
  opts: CommonOptions,
  projectId: number,
  slug: string,
  window: ListWindow,
  sort: string
): Promise<number[]> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const union = new Set<number>();
  let last = new Set<number>();
  let expected = 0;

  for (let attempt = 1; attempt <= MAX_LIST_ATTEMPTS; attempt += 1) {
    const ids = new Set<number>();
    let offset = 0;
    let total = 0;
    for (;;) {
      const page = await opts.client.listIssues({
        projectId,
        statusId: "*",
        ...window,
        sort,
        limit: pageSize,
        offset
      });
      if (offset === 0) {
        total = page.total_count;
      }
      for (const item of page.issues) {
        ids.add(item.id);
        union.add(item.id);
      }
      offset += pageSize;
      if (offset >= total || page.issues.length === 0) {
        break;
      }
    }

    last = ids;
    expected = total;
    if (ids.size === total) {
      return [...ids];
    }
    if (attempt < MAX_LIST_ATTEMPTS) {
      opts.log(`${slug}: ${ids.size} unique ids vs total_count ${total}, relist (attempt ${attempt + 1}/${MAX_LIST_ATTEMPTS})`);
    }
  }

  opts.log(`warning: ${slug}: ${last.size} unique ids vs total_count ${expected} after ${MAX_LIST_ATTEMPTS} attempts, exporting ${union.size} ids`);
  return [...union];
}

async function getIssueWithRetry(
  client: RedmineClientLike,
  id: number,
  sleep: (ms: number) => Promise<void>
): Promise<RedmineIssue> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await client.getIssue(id, ["journals", "relations", "attachments"]);
    } catch (error) {
      const retryable = error instanceof RedmineMcpError && error.code === "UPSTREAM_ERROR";
      if (!retryable || attempt >= MAX_GET_ATTEMPTS) {
        throw error;
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
}

function windowStart(opts: ExportOptions, slug: string): string | undefined {
  if (opts.since) {
    return opts.since;
  }
  if (opts.ignoreState) {
    return undefined;
  }
  const last = opts.state.projects[slug]?.last_updated_on;
  if (!last) {
    return undefined;
  }
  const parsed = new Date(last);
  if (Number.isNaN(parsed.getTime())) {
    throw new RedmineMcpError("VALIDATION_ERROR", `Invalid last_updated_on in state for project ${slug}.`);
  }
  return toRedmineDate(new Date(parsed.getTime() - WINDOW_MARGIN_MS));
}

export async function exportProjects(
  opts: ExportOptions
): Promise<{ written: Record<string, number>; nextState: RedmineState }> {
  const startedAt = opts.now();
  const startedIso = toRedmineDate(startedAt);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const resolved = await resolveProjects(opts);

  const written: Record<string, number> = {};
  const nextState: RedmineState = { projects: structuredClone(opts.state.projects) };

  for (const { slug, ref } of resolved) {
    const ids = await listAllIds(
      opts,
      ref.id,
      slug,
      {
        updatedOnFrom: windowStart(opts, slug),
        updatedOnTo: startedIso,
        include: ["relations", "attachments"]
      },
      "updated_on:asc"
    );

    const lines: string[] = [];
    for (const id of ids) {
      const issue = await getIssueWithRetry(opts.client, id, sleep);
      lines.push(JSON.stringify({ kind: "issue", project: slug, exported_at: startedIso, issue }));
    }

    await opts.writeFile(joinPath(opts.outDir, `${slug}.jsonl`), lines.map((l) => `${l}\n`).join(""));
    written[slug] = lines.length;
    nextState.projects[slug] = { last_updated_on: startedIso };
    opts.log(`${slug}: exported ${lines.length} issues`);
  }

  return { written, nextState: { projects: nextState.projects } };
}

export async function reconcileProjects(opts: ReconcileOptions): Promise<{ written: Record<string, number> }> {
  const startedIso = toRedmineDate(opts.now());
  const resolved = await resolveProjects(opts);
  const written: Record<string, number> = {};

  for (const { slug, ref } of resolved) {
    const ids = (await listAllIds(opts, ref.id, slug, {}, "id:asc")).sort((a, b) => a - b);
    const body = JSON.stringify({ project: slug, exported_at: startedIso, ids });
    await opts.writeFile(joinPath(opts.outDir, `${slug}.ids.json`), `${body}\n`);
    written[slug] = ids.length;
    opts.log(`${slug}: reconciled ${ids.length} ids`);
  }

  return { written };
}
