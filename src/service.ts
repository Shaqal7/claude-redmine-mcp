import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { RedmineMcpError } from "./errors.js";
import { normalizeIssueDetail, normalizeIssueSummary } from "./redmine/normalize.js";
import { ProjectPolicy } from "./redmine/policy.js";
import type {
  AttachFileToChainResult,
  AttachmentDescriptor,
  ListIssuesResult,
  NamedRef,
  NormalizedIssueDetail,
  ProjectRef,
  RedmineIssue,
  ResolveChainWithAttachmentResult,
  ResolveRelatedTestChainResult,
  SearchIssuesResult
} from "./types.js";
import { RedmineClient } from "./redmine/client.js";

type FileReader = (filePath: string) => Promise<Uint8Array>;

const SEARCH_PAGE_SIZE = 10;
const MAX_SEARCH_SCAN = 100;
const DEFAULT_RESOLVE_STATUS = "Rozwiązany";

export class RedmineService {
  private readonly policy: ProjectPolicy;
  private readonly defaultExternalProjects: string[];
  private readonly readFileImpl: FileReader;

  public constructor(
    private readonly client: RedmineClient,
    allowedProjects: string[],
    defaultExternalProjects: string[],
    readFileImpl: FileReader = (filePath) => readFile(filePath).then((buffer) => new Uint8Array(buffer))
  ) {
    if (!defaultExternalProjects || defaultExternalProjects.length === 0) {
      throw new RedmineMcpError(
        "VALIDATION_ERROR",
        "RedmineService requires a non-empty defaultExternalProjects list (set REDMINE_DEFAULT_EXTERNAL_PROJECTS)."
      );
    }
    this.policy = new ProjectPolicy(allowedProjects);
    this.defaultExternalProjects = defaultExternalProjects;
    this.readFileImpl = readFileImpl;
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

  public async attachFileToIssue(input: {
    issue_id: number;
    file_path: string;
    note?: string;
  }): Promise<NormalizedIssueDetail> {
    const filePath = input.file_path.trim();
    if (!filePath) {
      throw new RedmineMcpError("VALIDATION_ERROR", "file_path must not be empty.");
    }
    const note = input.note?.trim();

    await this.getAuthorizedIssue(input.issue_id);
    const { filename, contentType, bytes } = await this.readAttachment(filePath);
    const token = await this.client.uploadAttachment(filename, bytes);

    const patch: Record<string, unknown> = {
      uploads: [{ token, filename, content_type: contentType }]
    };
    if (note) {
      patch.notes = note;
    }

    await this.client.updateIssue(input.issue_id, patch);
    const updated = await this.getAuthorizedIssue(input.issue_id);
    return normalizeIssueDetail(updated, this.client.getBaseUrl());
  }

  public async attachFileToTestChain(input: {
    test_issue_id: number;
    file_path: string;
    note: string;
    external_projects?: string[];
    dry_run?: boolean;
  }): Promise<AttachFileToChainResult> {
    const note = input.note.trim();
    if (!note) {
      throw new RedmineMcpError("VALIDATION_ERROR", "Note must not be empty.");
    }
    const filePath = input.file_path.trim();
    if (!filePath) {
      throw new RedmineMcpError("VALIDATION_ERROR", "file_path must not be empty.");
    }

    const externalProjects = normalizeExternalProjects(input.external_projects, this.defaultExternalProjects);
    const dryRun = input.dry_run ?? true;

    const { testIssue, externalIssue } = await this.findTestChain(input.test_issue_id, externalProjects);

    const targets = [
      { role: "test" as const, issue: testIssue },
      { role: "external_issue" as const, issue: externalIssue }
    ];

    const attachment = await this.readAttachment(filePath);
    const attachmentDescriptor: AttachmentDescriptor = {
      filename: attachment.filename,
      content_type: attachment.contentType,
      size: attachment.bytes.byteLength
    };

    if (!dryRun) {
      const completed: string[] = [];
      for (const target of targets) {
        try {
          const token = await this.client.uploadAttachment(attachment.filename, attachment.bytes);
          await this.client.updateIssue(target.issue.id, {
            notes: note,
            uploads: [
              { token, filename: attachment.filename, content_type: attachment.contentType }
            ]
          });
          completed.push(`#${target.issue.id} (${target.role})`);
        } catch (error) {
          const partial = completed.length > 0
            ? ` Already attached before failure: ${completed.join(", ")}. Chain is now in a partially-attached state and must be reconciled manually.`
            : "";
          const reason = error instanceof Error ? error.message : String(error);
          throw new RedmineMcpError(
            "UPSTREAM_ERROR",
            `Failed to attach file to #${target.issue.id} (${target.role}): ${reason}.${partial}`
          );
        }
      }
    }

    const refreshed = dryRun
      ? targets
      : await Promise.all(
          targets.map(async (target) => ({
            role: target.role,
            issue: await this.getAuthorizedIssue(target.issue.id)
          }))
        );

    return {
      dry_run: dryRun,
      note,
      attachment: attachmentDescriptor,
      external_projects: externalProjects,
      steps: refreshed.map((target) => ({
        role: target.role,
        action: dryRun ? "would_attach" : "attached",
        issue: normalizeIssueSummary(target.issue, this.client.getBaseUrl())
      }))
    };
  }

  private async readAttachment(filePath: string): Promise<{
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }> {
    let bytes: Uint8Array;
    try {
      bytes = await this.readFileImpl(filePath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RedmineMcpError("VALIDATION_ERROR", `Unable to read file "${filePath}": ${reason}.`);
    }

    if (bytes.byteLength === 0) {
      throw new RedmineMcpError("VALIDATION_ERROR", `File "${filePath}" is empty.`);
    }

    return {
      filename: basename(filePath),
      contentType: contentTypeForExtension(extname(filePath)),
      bytes
    };
  }

  public async resolveRelatedTestChain(input: {
    test_issue_id: number;
    note: string;
    status?: string;
    external_projects?: string[];
    dry_run?: boolean;
  }): Promise<ResolveRelatedTestChainResult> {
    const note = input.note.trim();
    if (!note) {
      throw new RedmineMcpError("VALIDATION_ERROR", "Note must not be empty.");
    }

    const status = input.status?.trim() || DEFAULT_RESOLVE_STATUS;
    const externalProjects = normalizeExternalProjects(input.external_projects, this.defaultExternalProjects);
    const dryRun = input.dry_run ?? true;

    const { testIssue, sameProjectIssue, externalIssue } = await this.findTestChain(
      input.test_issue_id,
      externalProjects
    );

    const chain = [
      { role: "test" as const, issue: testIssue },
      { role: "same_project_issue" as const, issue: sameProjectIssue },
      { role: "external_issue" as const, issue: externalIssue }
    ];

    if (!dryRun) {
      const completed: string[] = [];
      for (const step of chain) {
        try {
          await this.resolveIssueWithNote(step.issue, status, note);
          completed.push(`#${step.issue.id} (${step.role})`);
        } catch (error) {
          const partial = completed.length > 0
            ? ` Already updated before failure: ${completed.join(", ")}. Chain is now in a partially-resolved state and must be reconciled manually.`
            : "";
          const reason = error instanceof Error ? error.message : String(error);
          throw new RedmineMcpError(
            "UPSTREAM_ERROR",
            `Failed to update #${step.issue.id} (${step.role}): ${reason}.${partial}`
          );
        }
      }
    }

    const refreshedChain = dryRun
      ? chain
      : await Promise.all(
          chain.map(async (step) => ({
            role: step.role,
            issue: await this.getAuthorizedIssue(step.issue.id)
          }))
        );

    return {
      dry_run: dryRun,
      note,
      status,
      external_projects: externalProjects,
      steps: refreshedChain.map((step) => ({
        role: step.role,
        target_status: status,
        action: dryRun ? "would_update" : "updated",
        issue: normalizeIssueSummary(step.issue, this.client.getBaseUrl())
      }))
    };
  }

  public async resolveChainWithAttachment(input: {
    test_issue_id: number;
    file_path: string;
    note: string;
    status?: string;
    external_projects?: string[];
    dry_run?: boolean;
  }): Promise<ResolveChainWithAttachmentResult> {
    const note = input.note.trim();
    if (!note) {
      throw new RedmineMcpError("VALIDATION_ERROR", "Note must not be empty.");
    }
    const filePath = input.file_path.trim();
    if (!filePath) {
      throw new RedmineMcpError("VALIDATION_ERROR", "file_path must not be empty.");
    }

    const status = input.status?.trim() || DEFAULT_RESOLVE_STATUS;
    const externalProjects = normalizeExternalProjects(input.external_projects, this.defaultExternalProjects);
    const dryRun = input.dry_run ?? true;

    const { testIssue, sameProjectIssue, externalIssue } = await this.findTestChain(
      input.test_issue_id,
      externalProjects
    );

    const chain = [
      { role: "test" as const, issue: testIssue },
      { role: "same_project_issue" as const, issue: sameProjectIssue },
      { role: "external_issue" as const, issue: externalIssue }
    ];

    const attachment = await this.readAttachment(filePath);
    const attachmentDescriptor: AttachmentDescriptor = {
      filename: attachment.filename,
      content_type: attachment.contentType,
      size: attachment.bytes.byteLength
    };

    if (!dryRun) {
      const completed: string[] = [];
      for (const step of chain) {
        try {
          const targetStatus = await this.client.getStatus(status, step.issue.allowed_statuses);
          const token = await this.client.uploadAttachment(attachment.filename, attachment.bytes);
          await this.client.updateIssue(step.issue.id, {
            status_id: targetStatus.id,
            notes: note,
            uploads: [
              { token, filename: attachment.filename, content_type: attachment.contentType }
            ]
          });
          const updated = await this.getAuthorizedIssue(step.issue.id);
          if (updated.status.id !== targetStatus.id) {
            throw new RedmineMcpError(
              "UPSTREAM_ERROR",
              `Redmine did not persist the requested status change to "${targetStatus.name}" for #${step.issue.id}.`
            );
          }
          completed.push(`#${step.issue.id} (${step.role})`);
        } catch (error) {
          const partial = completed.length > 0
            ? ` Already updated before failure: ${completed.join(", ")}. Chain is now in a partially-resolved state and must be reconciled manually.`
            : "";
          const reason = error instanceof Error ? error.message : String(error);
          throw new RedmineMcpError(
            "UPSTREAM_ERROR",
            `Failed to update #${step.issue.id} (${step.role}) with attachment: ${reason}.${partial}`
          );
        }
      }
    }

    const refreshedChain = dryRun
      ? chain
      : await Promise.all(
          chain.map(async (step) => ({
            role: step.role,
            issue: await this.getAuthorizedIssue(step.issue.id)
          }))
        );

    return {
      dry_run: dryRun,
      note,
      status,
      attachment: attachmentDescriptor,
      external_projects: externalProjects,
      steps: refreshedChain.map((step) => ({
        role: step.role,
        target_status: status,
        action: dryRun ? "would_update_with_attachment" : "updated_with_attachment",
        issue: normalizeIssueSummary(step.issue, this.client.getBaseUrl())
      }))
    };
  }

  private async getAuthorizedIssue(issueId: number) {
    const issue = await this.client.getIssue(issueId, ["journals", "relations", "allowed_statuses"]);
    const project = await this.client.getProject(String(issue.project.id));
    this.policy.assertProjectAllowed(project);
    return issue;
  }

  private async findSingleRelatedIssue(
    sourceIssue: RedmineIssue,
    predicate: (candidate: RedmineIssue, candidateProject: ProjectRef) => boolean,
    errorPrefix: string
  ): Promise<RedmineIssue> {
    const relatedIds = getRelatedIssueIds(sourceIssue);
    const matches: RedmineIssue[] = [];

    for (const relatedId of relatedIds) {
      const candidate = await this.getAuthorizedIssue(relatedId);
      const candidateProject = await this.client.getProject(String(candidate.project.id));
      if (predicate(candidate, candidateProject)) {
        matches.push(candidate);
      }
    }

    if (matches.length === 1) {
      return matches[0]!;
    }

    const relatedList = relatedIds.length > 0 ? relatedIds.map((id) => `#${id}`).join(", ") : "none";
    throw new RedmineMcpError(
      matches.length === 0 ? "NOT_FOUND" : "VALIDATION_ERROR",
      `${errorPrefix} Related issue candidates: ${relatedList}.`
    );
  }

  private async findTestChain(
    testIssueId: number,
    externalProjects: string[]
  ): Promise<{ testIssue: RedmineIssue; sameProjectIssue: RedmineIssue; externalIssue: RedmineIssue }> {
    const testIssue = await this.getAuthorizedIssue(testIssueId);
    const testProject = await this.client.getProject(String(testIssue.project.id));
    const sameProjectIssue = await this.findSingleRelatedIssue(
      testIssue,
      (candidate, candidateProject) =>
        candidate.id !== testIssue.id &&
        candidateProject.id === testProject.id &&
        candidate.tracker?.name.trim().toLowerCase() !== "test",
      `Expected exactly one non-test related issue in project "${testProject.name}".`
    );
    const externalIssue = await this.findSingleRelatedIssue(
      sameProjectIssue,
      (candidate, candidateProject) =>
        candidate.id !== testIssue.id &&
        candidate.id !== sameProjectIssue.id &&
        candidateProject.id !== testProject.id &&
        externalProjects.some((projectRef) => projectMatches(candidateProject, projectRef)),
      `Expected exactly one related issue in one of external projects: ${externalProjects.join(", ")}.`
    );
    return { testIssue, sameProjectIssue, externalIssue };
  }

  private async resolveIssueWithNote(issue: RedmineIssue, status: string, note: string): Promise<void> {
    const targetStatus = await this.client.getStatus(status, issue.allowed_statuses);
    await this.client.updateIssue(issue.id, {
      status_id: targetStatus.id,
      notes: note
    });

    const updated = await this.getAuthorizedIssue(issue.id);
    if (updated.status.id !== targetStatus.id) {
      throw new RedmineMcpError(
        "UPSTREAM_ERROR",
        `Redmine did not persist the requested status change to "${targetStatus.name}" for #${issue.id}.`
      );
    }
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

function getRelatedIssueIds(issue: RedmineIssue): number[] {
  const ids = new Set<number>();
  for (const relation of issue.relations ?? []) {
    if (relation.issue_id !== undefined && relation.issue_id !== issue.id) {
      ids.add(relation.issue_id);
    }
    if (relation.issue_to_id !== undefined && relation.issue_to_id !== issue.id) {
      ids.add(relation.issue_to_id);
    }
  }

  return [...ids];
}

function normalizeExternalProjects(projects: string[] | undefined, fallback: string[]): string[] {
  const normalized = (projects && projects.length > 0 ? projects : fallback)
    .map((project) => project.trim())
    .filter(Boolean);

  if (normalized.length === 0) {
    throw new RedmineMcpError(
      "VALIDATION_ERROR",
      "At least one external project must be provided (set REDMINE_DEFAULT_EXTERNAL_PROJECTS or pass external_projects)."
    );
  }

  return [...new Set(normalized)];
}

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

function contentTypeForExtension(extension: string): string {
  return CONTENT_TYPE_BY_EXTENSION[extension.toLowerCase()] ?? "application/octet-stream";
}

function projectMatches(project: ProjectRef, projectRef: string): boolean {
  const normalized = projectRef.trim().toLowerCase();
  return (
    String(project.id).toLowerCase() === normalized ||
    project.name.toLowerCase() === normalized ||
    project.identifier?.toLowerCase() === normalized
  );
}
