import { RedmineMcpError } from "../errors.js";
import type {
  AppConfig,
  NamedRef,
  ProjectRef,
  RedmineCurrentUserResponse,
  RedmineIssue,
  RedmineIssueListResponse,
  RedmineIssueResponse,
  RedmineMembership,
  RedmineMembershipsResponse,
  RedmineProjectResponse,
  RedmineStatusesResponse,
  RedmineUploadResponse
} from "../types.js";

interface RequestOptions {
  method?: "GET" | "PUT" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  rawBody?: Uint8Array;
  contentType?: string;
}

type FetchLike = typeof fetch;

export class RedmineClient {
  private readonly projectCache = new Map<string, ProjectRef>();
  private readonly statusCache = new Map<string, NamedRef>();
  private currentUserCache?: NamedRef;

  public constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  public getBaseUrl(): string {
    return this.config.redmineBaseUrl;
  }

  public async getProject(projectRef: string): Promise<ProjectRef> {
    const cacheKey = projectRef.trim().toLowerCase();
    const cached = this.projectCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await this.request<RedmineProjectResponse>(`/projects/${encodeURIComponent(projectRef)}.json`);
    const project = response.project;

    this.projectCache.set(String(project.id).toLowerCase(), project);
    this.projectCache.set(project.name.toLowerCase(), project);
    if (project.identifier) {
      this.projectCache.set(project.identifier.toLowerCase(), project);
    }

    return project;
  }

  public async listIssues(params: {
    projectId: number;
    statusId?: string | number;
    assignedToId?: string | number;
    limit: number;
    offset?: number;
    sort?: string;
  }): Promise<RedmineIssueListResponse> {
    return this.request<RedmineIssueListResponse>("/issues.json", {
      query: {
        project_id: params.projectId,
        status_id: params.statusId === undefined ? "*" : String(params.statusId),
        assigned_to_id: params.assignedToId === undefined ? undefined : String(params.assignedToId),
        limit: params.limit,
        offset: params.offset ?? 0,
        sort: params.sort
      }
    });
  }

  public async getIssue(issueId: number, include: string[] = []): Promise<RedmineIssue> {
    const response = await this.request<RedmineIssueResponse>(`/issues/${issueId}.json`, {
      query: {
        include: include.length > 0 ? include.join(",") : undefined
      }
    });

    return response.issue;
  }

  public async updateIssue(issueId: number, issuePatch: Record<string, unknown>): Promise<void> {
    await this.request<void>(`/issues/${issueId}.json`, {
      method: "PUT",
      body: {
        issue: issuePatch
      }
    });
  }

  public async uploadAttachment(filename: string, bytes: Uint8Array): Promise<string> {
    const response = await this.request<RedmineUploadResponse>("/uploads.json", {
      method: "POST",
      query: { filename },
      rawBody: bytes,
      contentType: "application/octet-stream"
    });

    if (!response?.upload?.token) {
      throw new RedmineMcpError("UPSTREAM_ERROR", "Redmine upload response did not contain a token.");
    }

    return response.upload.token;
  }

  public async listStatuses(): Promise<NamedRef[]> {
    if (this.statusCache.size > 0) {
      return dedupeRefs([...this.statusCache.values()]);
    }

    const response = await this.request<RedmineStatusesResponse>("/issue_statuses.json");
    for (const status of response.issue_statuses) {
      const normalized = { id: status.id, name: status.name };
      this.statusCache.set(String(status.id).toLowerCase(), normalized);
      this.statusCache.set(status.name.toLowerCase(), normalized);
    }

    return dedupeRefs([...this.statusCache.values()]);
  }

  public async getStatus(statusRef: string, allowedStatuses?: NamedRef[]): Promise<NamedRef> {
    const normalized = statusRef.trim().toLowerCase();

    if (allowedStatuses && allowedStatuses.length > 0) {
      const match = allowedStatuses.find(
        (status) => String(status.id).toLowerCase() === normalized || status.name.toLowerCase() === normalized
      );

      if (match) {
        return match;
      }

      throw new RedmineMcpError(
        "VALIDATION_ERROR",
        `Status "${statusRef}" is not allowed for this issue.`
      );
    }

    const statuses = await this.listStatuses();
    const resolved = statuses.find(
      (status) => String(status.id).toLowerCase() === normalized || status.name.toLowerCase() === normalized
    );

    if (!resolved) {
      throw new RedmineMcpError("NOT_FOUND", `Issue status "${statusRef}" was not found.`);
    }

    return resolved;
  }

  public async getCurrentUser(): Promise<NamedRef> {
    if (this.currentUserCache) {
      return this.currentUserCache;
    }

    const response = await this.request<RedmineCurrentUserResponse>("/users/current.json");
    const user = response.user;
    const name = [user.firstname, user.lastname].filter(Boolean).join(" ").trim() || user.login || String(user.id);
    this.currentUserCache = { id: user.id, name };
    return this.currentUserCache;
  }

  public async listProjectMembers(projectIdOrIdentifier: string | number): Promise<NamedRef[]> {
    const result: NamedRef[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await this.request<RedmineMembershipsResponse>(
        `/projects/${encodeURIComponent(String(projectIdOrIdentifier))}/memberships.json`,
        {
          query: {
            limit,
            offset
          }
        }
      );

      const pageMembers = response.memberships
        .map((membership: RedmineMembership) => membership.user)
        .filter((member): member is NamedRef => Boolean(member));
      result.push(...pageMembers);

      offset += response.limit;
      if (offset >= response.total_count) {
        break;
      }
    }

    return dedupeRefs(result);
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const url = new URL(`${this.config.redmineBaseUrl}${path}`);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }

      const hasRawBody = options.rawBody !== undefined;
      const headers: Record<string, string> = {
        "Accept": "application/json",
        "X-Redmine-API-Key": this.config.redmineApiKey
      };
      let body: Uint8Array | string | undefined;
      if (hasRawBody) {
        headers["Content-Type"] = options.contentType ?? "application/octet-stream";
        body = options.rawBody;
      } else if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(options.body);
      }

      const response = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        headers,
        body,
        signal: controller.signal
      });

      if (response.status === 401 || response.status === 403) {
        throw new RedmineMcpError(
          "AUTH_ERROR",
          "Redmine rejected the API key or denied access."
        );
      }

      if (response.status === 404) {
        throw new RedmineMcpError("NOT_FOUND", "The requested Redmine resource was not found.");
      }

      if (response.status === 422) {
        const payload = (await safeJson(response)) as { errors?: string[] } | undefined;
        throw new RedmineMcpError(
          "VALIDATION_ERROR",
          payload?.errors?.join("; ") || "Redmine rejected the request as invalid.",
          payload
        );
      }

      if (!response.ok) {
        const payload = await safeJson(response);
        throw new RedmineMcpError(
          "UPSTREAM_ERROR",
          `Redmine request failed with ${response.status} ${response.statusText}.`,
          payload
        );
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof RedmineMcpError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new RedmineMcpError(
          "UPSTREAM_ERROR",
          `Redmine request timed out after ${this.config.timeoutMs}ms.`
        );
      }

      throw new RedmineMcpError(
        "UPSTREAM_ERROR",
        "Unable to reach the Redmine API.",
        error instanceof Error ? error.message : error
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function dedupeRefs(values: NamedRef[]): NamedRef[] {
  const seen = new Set<number>();
  const result: NamedRef[] = [];

  for (const value of values) {
    if (seen.has(value.id)) {
      continue;
    }
    seen.add(value.id);
    result.push(value);
  }

  return result;
}

async function safeJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return undefined;
  }

  try {
    return await response.json();
  } catch {
    return undefined;
  }
}