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

export type ExportResult = {
  written: Record<string, number>;
  /** Liczba pominiętych zadań (inny projekt, NOT_FOUND, AUTH_ERROR); w logu tylko ID i kod. */
  skipped: number;
  nextState: RedmineState;
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

/**
 * Pominąć wolno tylko zadanie niewidoczne dla klucza: 404 albo 403 (pojedyncze ukryte/prywatne zadanie).
 * 401 (unieważniony klucz) i AUTH_ERROR bez znanego statusu to awaria systemowa i przerywają eksport.
 */
function isSkippable(error: unknown): error is RedmineMcpError {
  if (!(error instanceof RedmineMcpError)) {
    return false;
  }
  if (error.code === "NOT_FOUND") {
    return true;
  }
  const status = (error.details as { status?: number } | undefined)?.status;
  return error.code === "AUTH_ERROR" && status === 403;
}

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

type ListWindow = { updatedOnFrom?: string; updatedOnTo?: string; createdOnTo?: string; include?: string[] };

/** id zadania -> id jego własnego projektu (z listy). */
type ListedIds = { items: Map<number, number | undefined>; complete: boolean };

/**
 * Listuje wszystkie ID zadań projektu (bez podprojektów). Paginacja po offsecie przesuwa się, gdy
 * zadanie wypada z okna między stronami, więc liczba unikalnych ID musi zgadzać się z total_count
 * z pierwszej strony; inaczej listowanie jest powtarzane (maks. 3 razy). `complete: false` oznacza,
 * że po wszystkich próbach luka nadal może istnieć.
 */
async function listAllIds(
  opts: CommonOptions,
  projectId: number,
  slug: string,
  window: ListWindow,
  sort: string
): Promise<ListedIds> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const union = new Map<number, number | undefined>();
  let lastUnique = 0;
  let expected = 0;

  for (let attempt = 1; attempt <= MAX_LIST_ATTEMPTS; attempt += 1) {
    const ids = new Map<number, number | undefined>();
    let offset = 0;
    let total = 0;
    for (;;) {
      const page = await opts.client.listIssues({
        projectId,
        statusId: "*",
        ...window,
        subprojectId: "!*",
        sort,
        limit: pageSize,
        offset
      });
      if (offset === 0) {
        total = page.total_count;
      }
      for (const item of page.issues) {
        ids.set(item.id, item.project?.id);
        union.set(item.id, item.project?.id);
      }
      offset += pageSize;
      if (offset >= total || page.issues.length === 0) {
        break;
      }
    }

    lastUnique = ids.size;
    expected = total;
    if (ids.size === total) {
      return { items: ids, complete: true };
    }
    if (attempt < MAX_LIST_ATTEMPTS) {
      opts.log(`${slug}: ${ids.size} unique ids vs total_count ${total}, relist (attempt ${attempt + 1}/${MAX_LIST_ATTEMPTS})`);
    }
  }

  opts.log(
    `warning: ${slug}: ${lastUnique} unique ids vs total_count ${expected} after ${MAX_LIST_ATTEMPTS} attempts, ` +
      `exporting ${union.size} ids, state not advanced`
  );
  return { items: union, complete: false };
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
    const parsedSince = new Date(opts.since);
    if (Number.isNaN(parsedSince.getTime())) {
      throw new RedmineMcpError("VALIDATION_ERROR", "Invalid since value, expected an ISO 8601 date.");
    }
    return toRedmineDate(parsedSince);
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

export async function exportProjects(opts: ExportOptions): Promise<ExportResult> {
  const startedIso = toRedmineDate(opts.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const resolved = await resolveProjects(opts);

  const written: Record<string, number> = {};
  const nextState: RedmineState = { projects: structuredClone(opts.state.projects) };
  let skipped = 0;

  for (const { slug, ref } of resolved) {
    const listed = await listAllIds(
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
    let fetchSkipped = 0;
    for (const [id, listedProjectId] of listed.items) {
      if (listedProjectId !== undefined && listedProjectId !== ref.id) {
        skipped += 1;
        opts.log(`${slug}: skip issue ${id}: belongs to another project`);
        continue;
      }
      let issue: RedmineIssue;
      try {
        issue = await getIssueWithRetry(opts.client, id, sleep);
      } catch (error) {
        if (isSkippable(error)) {
          skipped += 1;
          fetchSkipped += 1;
          opts.log(`${slug}: skip issue ${id}: ${error.code}`);
          continue;
        }
        throw error;
      }
      if (issue.project?.id !== ref.id) {
        skipped += 1;
        opts.log(`${slug}: skip issue ${id}: belongs to another project`);
        continue;
      }
      lines.push(JSON.stringify({ kind: "issue", project: slug, exported_at: startedIso, issue }));
    }

    if (listed.items.size > 0 && fetchSkipped === listed.items.size) {
      throw new RedmineMcpError(
        "UPSTREAM_ERROR",
        `${slug}: every issue from the listing (${fetchSkipped}) was skipped on getIssue, treating it as a systemic failure.`
      );
    }

    await opts.writeFile(joinPath(opts.outDir, `${slug}.jsonl`), lines.map((l) => `${l}\n`).join(""));
    written[slug] = lines.length;
    // Przy niekompletnym listowaniu stan zostaje poprzedni (albo projekt bez wpisu), żeby następny
    // przebieg objął to samo okno; inaczej luka byłaby trwała.
    if (listed.complete) {
      nextState.projects[slug] = { last_updated_on: startedIso };
    }
    opts.log(`${slug}: exported ${lines.length} issues`);
  }

  if (skipped > 0) {
    opts.log(`skipped ${skipped} issues in total`);
  }
  return { written, skipped, nextState };
}

export async function reconcileProjects(
  opts: ReconcileOptions
): Promise<{ written: Record<string, number>; skipped: number }> {
  const startedIso = toRedmineDate(opts.now());
  const resolved = await resolveProjects(opts);
  const written: Record<string, number> = {};
  let skipped = 0;

  for (const { slug, ref } of resolved) {
    // Górna granica created_on: po starcie nowe zadania nie wchodzą do listy, więc przesunięcie offsetu
    // może wynikać tylko z odejść, a test zgodności liczby z total_count znów coś znaczy.
    const listed = await listAllIds(opts, ref.id, slug, { createdOnTo: startedIso }, "id:asc");
    const ids: number[] = [];
    for (const [id, projectId] of listed.items) {
      if (projectId !== undefined && projectId !== ref.id) {
        skipped += 1;
        continue;
      }
      ids.push(id);
    }
    ids.sort((a, b) => a - b);
    const body = JSON.stringify({ project: slug, exported_at: startedIso, ids });
    await opts.writeFile(joinPath(opts.outDir, `${slug}.ids.json`), `${body}\n`);
    written[slug] = ids.length;
    opts.log(`${slug}: reconciled ${ids.length} ids`);
  }

  if (skipped > 0) {
    opts.log(`skipped ${skipped} ids of other projects`);
  }
  return { written, skipped };
}
