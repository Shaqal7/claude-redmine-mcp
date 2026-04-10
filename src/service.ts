import { RedmineMcpError } from "./errors.js";
import { normalizeIssueDetail, normalizeIssueSummary } from "./redmine/normalize.js";
import { ProjectPolicy } from "./redmine/policy.js";
import type {
  ListIssuesResult,
  NamedRef,
  NormalizedIssueDetail,
  ProjectRef,
  SearchIssuesResult
} from "./types.js";
import { RedmineClient } from "./redmine/client.js";

const SEARCH_PAGE_SIZE = 10;
const MAX_SEARCH_SCAN = 100;

export class RedmineService {
  private readonly policy: ProjectPolicy;

  public constructor(private readonly client: RedmineClient, allowedProjects: string[]) {
    this.policy = new ProjectPolicy(allowedProjects);
  }

  public async listIssues(input: {
    project: string;
    status?: string;
    assignee?: string;
    limit?: number;
    sort?: string;
  }): Promise<ListIssuesResult> {
    const project = await this.resolveProject(input.project);
    const statusId = await this.resolveStatusFilter(input.status);
    const assignedToId = await this.resolveAssigneeFilter(project, input.assignee);
    const limit = clampLimit(input.limit);
    const sort = validateSort(input.sort);
    const response = await this.client.listIssues({
      projectId: project.id,
      statusId,
      assignedToId,
      limit,
      sort
    });

    return {
      project: project.name,
      count: response.issues.length,
      total_count: response.total_count,
      issues: response.issues.map((issue) => normalizeIssueSummary(issue, this.client.getBaseUrl()))
    };
  }

  public async searchIssues(input: {
    query: string;
    project?: string;
    status?: string;
    assignee?: string;
    limit?: number;
  }): Promise<SearchIssuesResult> {
    const query = input.query.trim();
    if (!query) {
      throw new RedmineMcpError("VALIDATION_ERROR", "search_issues requires a non-empty query.");
    }

    const projects = input.project
      ? [await this.resolveProject(input.project)]
      : await Promise.all(this.policy.getAllowedProjects().map((project) => this.client.getProject(project)));
    const limit = clampLimit(input.limit);
    const statusId = await this.resolveStatusFilter(input.status);

    const results: SearchIssuesResult["issues"] = [];
    let scannedIssues = 0;
    let truncated = false;
    const loweredQuery = query.toLowerCase();

    for (const project of projects) {
      const assignedToId = await this.resolveAssigneeFilter(project, input.assignee);
      let offset = 0;

      while (results.length < limit && scannedIssues < MAX_SEARCH_SCAN) {
        const page = await this.client.listIssues({
          projectId: project.id,
          statusId,
          assignedToId,
          limit: SEARCH_PAGE_SIZE,
          offset,
          sort: "updated_on:desc"
        });

        if (page.issues.length === 0) {
          break;
        }

        for (const issue of page.issues) {
          if (results.length >= limit || scannedIssues >= MAX_SEARCH_SCAN) {
            break;
          }

          scannedIssues += 1;
          const detailedIssue = await this.client.getIssue(issue.id);
          const haystack = `${detailedIssue.subject}\n${detailedIssue.description ?? ""}`.toLowerCase();
          if (haystack.includes(loweredQuery)) {
            results.push(normalizeIssueSummary(detailedIssue, this.client.getBaseUrl()));
          }
        }

        offset += page.limit;
        if (offset >= page.total_count) {
          break;
        }
      }

      if (results.length >= limit || scannedIssues >= MAX_SEARCH_SCAN) {
        truncated = scannedIssues >= MAX_SEARCH_SCAN;
        break;
      }
    }

    if (scannedIssues >= MAX_SEARCH_SCAN) {
      truncated = true;
    }

    return {
      query,
      count: results.length,
      scanned_issues: scannedIssues,
      truncated,
      issues: results
    };
  }

  public async getIssue(issueId: number): Promise<NormalizedIssueDetail> {
    const issue = await this.getAuthorizedIssue(issueId);
    return normalizeIssueDetail(issue, this.client.getBaseUrl());
  }

  public async addIssueNote(issueId: number, note: string): Promise<NormalizedIssueDetail> {
    const trimmedNote = note.trim();
    if (!trimmedNote) {
      throw new RedmineMcpError("VALIDATION_ERROR", "Note must not be empty.");
    }

    await this.getAuthorizedIssue(issueId);
    await this.client.updateIssue(issueId, { notes: trimmedNote });
    const updated = await this.getAuthorizedIssue(issueId);
    return normalizeIssueDetail(updated, this.client.getBaseUrl());
  }

  public async updateIssueStatus(issueId: number, status: string): Promise<NormalizedIssueDetail> {
    const issue = await this.getAuthorizedIssue(issueId);
    const targetStatus = await this.client.getStatus(status, issue.allowed_statuses);

    await this.client.updateIssue(issueId, { status_id: targetStatus.id });
    const updated = await this.getAuthorizedIssue(issueId);

    if (updated.status.id !== targetStatus.id) {
      throw new RedmineMcpError(
        "UPSTREAM_ERROR",
        `Redmine did not persist the requested status change to "${targetStatus.name}".`
      );
    }

    return normalizeIssueDetail(updated, this.client.getBaseUrl());
  }

  public async assignIssue(issueId: number, assignee: string): Promise<NormalizedIssueDetail> {
    const issue = await this.getAuthorizedIssue(issueId);
    const project = await this.client.getProject(String(issue.project.id));
    const resolvedAssignee = await this.resolveProjectMember(project, assignee);

    await this.client.updateIssue(issueId, { assigned_to_id: resolvedAssignee.id });
    const updated = await this.getAuthorizedIssue(issueId);

    if (updated.assigned_to?.id !== resolvedAssignee.id) {
      throw new RedmineMcpError(
        "UPSTREAM_ERROR",
        `Redmine did not persist the requested assignee change to "${resolvedAssignee.name}".`
      );
    }

    return normalizeIssueDetail(updated, this.client.getBaseUrl());
  }

  private async getAuthorizedIssue(issueId: number) {
    const issue = await this.client.getIssue(issueId, ["journals", "relations", "allowed_statuses"]);
    const project = await this.client.getProject(String(issue.project.id));
    this.policy.assertProjectAllowed(project);
    return issue;
  }

  private async resolveProject(projectRef: string): Promise<ProjectRef> {
    const project = await this.client.getProject(projectRef);
    this.policy.assertProjectAllowed(project);
    return project;
  }

  private async resolveStatusFilter(status?: string): Promise<string | number | undefined> {
    if (!status) {
      return "*";
    }

    const normalized = status.trim().toLowerCase();
    if (normalized === "*" || normalized === "open" || normalized === "closed") {
      return normalized;
    }

    return (await this.client.getStatus(status)).id;
  }

  private async resolveAssigneeFilter(
    project: ProjectRef,
    assignee?: string
  ): Promise<string | number | undefined> {
    if (!assignee) {
      return undefined;
    }

    if (assignee.trim().toLowerCase() === "me") {
      return "me";
    }

    return (await this.resolveProjectMember(project, assignee)).id;
  }

  private async resolveProjectMember(project: ProjectRef, assignee: string): Promise<NamedRef> {
    if (assignee.trim().toLowerCase() === "me") {
      const currentUser = await this.client.getCurrentUser();
      const members = await this.client.listProjectMembers(project.identifier ?? project.id);
      const matchedSelf = members.find((member) => member.id === currentUser.id);
      if (!matchedSelf) {
        throw new RedmineMcpError(
          "NOT_FOUND",
          `Current user "${currentUser.name}" is not assignable in project "${project.name}".`
        );
      }
      return matchedSelf;
    }

    const members = await this.client.listProjectMembers(project.identifier ?? project.id);
    const normalized = assignee.trim().toLowerCase();

    const exact = members.find(
      (member) => member.name.toLowerCase() === normalized || String(member.id) === normalized
    );
    if (exact) {
      return exact;
    }

    const fuzzyMatches = members.filter((member) => member.name.toLowerCase().includes(normalized));
    if (fuzzyMatches.length === 1) {
      return fuzzyMatches[0]!;
    }

    if (fuzzyMatches.length > 1) {
      throw new RedmineMcpError(
        "VALIDATION_ERROR",
        `Assignee "${assignee}" is ambiguous in project "${project.name}".`
      );
    }

    throw new RedmineMcpError(
      "NOT_FOUND",
      `Assignee "${assignee}" was not found in project "${project.name}".`
    );
  }
}

function clampLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit)) {
    return 10;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), 50);
}

function validateSort(sort?: string): string | undefined {
  if (!sort) {
    return "updated_on:desc";
  }

  if (!/^[a-z_]+(?::(?:asc|desc))?(,[a-z_]+(?::(?:asc|desc))?)*$/i.test(sort)) {
    throw new RedmineMcpError("VALIDATION_ERROR", "Sort must use Redmine sort syntax.");
  }

  return sort;
}