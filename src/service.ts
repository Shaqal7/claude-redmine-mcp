import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { RedmineMcpError } from "./errors.js";
import { normalizeIssueDetail, normalizeIssueSummary } from "./redmine/normalize.js";
import { ProjectPolicy } from "./redmine/policy.js";
import type {
  AttachFileToChainResult,
  AttachmentDescriptor,
  CreateIssueCustomField,
  CreateIssueResult,
  ListIssuesResult,
  NamedRef,
  NormalizedIssueDetail,
  ProjectIssueMetadata,
  ProjectRef,
  RedmineCustomFieldDefinition,
  RedmineIssue,
  ResolveChainWithAttachmentResult,
  ResolveRelatedTestChainResult,
  SearchIssueHit,
  SearchIssuesResult,
  UpdateIssueNoteResult
} from "./types.js";
import { RedmineClient } from "./redmine/client.js";

type FileReader = (filePath: string) => Promise<Uint8Array>;

const SEARCH_PAGE_SIZE = 10;
const MAX_SEARCH_SCAN = 100;
const FULLTEXT_PAGE_SIZE = 100;
const MAX_FULLTEXT_HITS_PER_PROJECT = 2000;
const DEFAULT_RESOLVE_STATUS = "Rozwiązany";
const MAX_SUBJECT_LENGTH = 255;
const DEFAULT_RELATION_TYPE = "relates";
// Redmine IssueRelation::TYPES (relations to an existing issue; no precedes/follows delay support).
export const RELATION_TYPES = [
  "relates",
  "duplicates",
  "duplicated",
  "blocks",
  "blocked",
  "precedes",
  "follows",
  "copied_to",
  "copied_from"
] as const;

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
    titles_only?: boolean;
    all_words?: boolean;
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

    try {
      return await this.fullTextSearch({
        query,
        projects,
        limit,
        statusId,
        assignee: input.assignee,
        titlesOnly: input.titles_only ?? false,
        allWords: input.all_words ?? true
      });
    } catch (error) {
      // Search module disabled or endpoint unavailable on this Redmine — fall back to the legacy scan.
      if (error instanceof RedmineMcpError && error.code === "NOT_FOUND") {
        return this.scanRecentIssues({ query, projects, limit, statusId, assignee: input.assignee });
      }
      throw error;
    }
  }

  private async fullTextSearch(input: {
    query: string;
    projects: ProjectRef[];
    limit: number;
    statusId: string | number | undefined;
    assignee?: string;
    titlesOnly: boolean;
    allWords: boolean;
  }): Promise<SearchIssuesResult> {
    const results: SearchIssueHit[] = [];
    const seen = new Set<number>();
    let scannedHits = 0;
    let totalHits = 0;
    let truncated = false;

    for (const project of input.projects) {
      if (results.length >= input.limit) {
        truncated = true;
        break;
      }

      const assignedToId = await this.resolveAssigneeFilter(project, input.assignee);
      let offset = 0;
      let projectHitsScanned = 0;

      while (results.length < input.limit) {
        const page = await this.client.searchProjectIssues({
          projectRef: project.identifier ?? project.id,
          query: input.query,
          limit: FULLTEXT_PAGE_SIZE,
          offset,
          titlesOnly: input.titlesOnly,
          allWords: input.allWords
        });

        if (offset === 0) {
          totalHits += page.total_count;
        }

        const hits = page.results.filter((hit) => hit.type.startsWith("issue") && !seen.has(hit.id));
        scannedHits += page.results.length;
        projectHitsScanned += page.results.length;

        const excerptById = new Map(hits.map((hit) => [hit.id, hit.description?.trim() || null]));
        const issues = await this.client.listIssuesByIds({
          issueIds: hits.map((hit) => hit.id),
          statusId: input.statusId,
          assignedToId
        });
        const issuesById = new Map(issues.map((issue) => [issue.id, issue]));

        // Keep Redmine's relevance/date ordering from the search response.
        for (const hit of hits) {
          seen.add(hit.id);
          const issue = issuesById.get(hit.id);
          if (!issue || !(await this.isIssueProjectAllowed(issue))) {
            continue;
          }
          if (results.length >= input.limit) {
            truncated = true;
            break;
          }
          results.push({
            ...normalizeIssueSummary(issue, this.client.getBaseUrl()),
            match_excerpt: excerptById.get(hit.id) ?? null
          });
        }

        offset += FULLTEXT_PAGE_SIZE;
        if (page.results.length === 0 || offset >= page.total_count) {
          break;
        }
        if (results.length >= input.limit) {
          truncated = true;
          break;
        }
        if (projectHitsScanned >= MAX_FULLTEXT_HITS_PER_PROJECT) {
          truncated = true;
          break;
        }
      }
    }

    return {
      query: input.query,
      mode: "fulltext",
      count: results.length,
      scanned_issues: scannedHits,
      total_hits: totalHits,
      truncated,
      issues: results
    };
  }

  private async scanRecentIssues(input: {
    query: string;
    projects: ProjectRef[];
    limit: number;
    statusId: string | number | undefined;
    assignee?: string;
  }): Promise<SearchIssuesResult> {
    const { query, projects, limit, statusId } = input;
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
          // /issues.json already carries subject + description — no per-issue fetch needed.
          const haystack = `${issue.subject}\n${issue.description ?? ""}`.toLowerCase();
          if (haystack.includes(loweredQuery)) {
            results.push(normalizeIssueSummary(issue, this.client.getBaseUrl()));
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
      mode: "scan",
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

  public async createIssue(input: {
    project: string;
    subject: string;
    description: string;
    tracker?: string;
    priority?: string;
    custom_fields?: Record<string, string | string[]>;
    related_issue_id?: number;
    relation_type?: string;
    attachments?: string[];
    dry_run?: boolean;
  }): Promise<CreateIssueResult> {
    const subject = input.subject.trim();
    if (!subject) {
      throw new RedmineMcpError("VALIDATION_ERROR", "Subject must not be empty.");
    }
    if (subject.length > MAX_SUBJECT_LENGTH) {
      throw new RedmineMcpError("VALIDATION_ERROR", `Subject must be at most ${MAX_SUBJECT_LENGTH} characters.`);
    }
    if (!input.description.trim()) {
      throw new RedmineMcpError("VALIDATION_ERROR", "Description must not be empty.");
    }
    const relationType = normalizeRelationType(input.related_issue_id, input.relation_type);
    const dryRun = input.dry_run ?? true;
    const attachments = await this.readNewIssueAttachments(input.attachments ?? []);

    const project = await this.resolveProject(input.project);
    const relatedIssue =
      input.related_issue_id === undefined ? undefined : await this.getAuthorizedIssue(input.related_issue_id);
    const metadata = await this.client.getProjectIssueMetadata(project.identifier ?? project.id);
    const tracker = await this.resolveNewIssueTracker(project, metadata, input.tracker);
    const priority = await this.resolveNewIssuePriority(input.priority);
    const customFields = resolveNewIssueCustomFields(project, metadata, input.custom_fields ?? {});
    const requiredCustomFields = await this.checkCustomFieldDefinitions(metadata, tracker, customFields);

    const notes: string[] = [];
    if (!tracker) {
      const order = metadata.trackers ? ` (project order: ${metadata.trackers.map((entry) => entry.name).join(", ")})` : "";
      notes.push(
        `No tracker given: Redmine picks the first tracker your role may add issues for${order}; the API does not say which one that is.`
      );
    }
    if (relatedIssue && relatedIssue.project.id !== project.id) {
      notes.push(
        `#${relatedIssue.id} is in project "${relatedIssue.project.name}": Redmine rejects cross-project relations unless the cross_project_issue_relations setting is on; then the issue is created but the relation fails.`
      );
    }

    const baseUrl = this.client.getBaseUrl();
    const preview: CreateIssueResult = {
      dry_run: dryRun,
      action: "would_create",
      project: { id: project.id, name: project.name, identifier: project.identifier ?? null },
      tracker,
      priority,
      subject,
      description: input.description,
      custom_fields: customFields,
      attachments: attachments.map((attachment) => ({
        filename: attachment.filename,
        content_type: attachment.contentType,
        size: attachment.bytes.byteLength,
        embed: inlineImageEmbed(attachment.filename)
      })),
      required_custom_fields: requiredCustomFields,
      notes,
      relation: relatedIssue && relationType
        ? { type: relationType, action: "would_relate", issue: normalizeIssueSummary(relatedIssue, baseUrl) }
        : null,
      issue_id: null,
      url: null,
      issue: null
    };
    if (dryRun) {
      return preview;
    }

    const payload: Record<string, unknown> = {
      project_id: project.id,
      subject,
      description: input.description
    };
    if (tracker) {
      payload.tracker_id = tracker.id;
    }
    if (priority) {
      payload.priority_id = priority.id;
    }
    if (customFields.length > 0) {
      payload.custom_fields = customFields.map((field) => ({ id: field.id, value: field.value }));
    }
    // Uploading before the create keeps a failed upload from leaving an issue behind, and sending the tokens
    // with the create lets the description embed the images and puts everything in one journal.
    if (attachments.length > 0) {
      const uploads: Array<{ token: string; filename: string; content_type: string }> = [];
      for (const attachment of attachments) {
        try {
          const token = await this.client.uploadAttachment(attachment.filename, attachment.bytes);
          uploads.push({ token, filename: attachment.filename, content_type: attachment.contentType });
        } catch (error) {
          throw new RedmineMcpError(
            error instanceof RedmineMcpError ? error.code : "UPSTREAM_ERROR",
            `Uploading attachment "${attachment.filename}" failed: ${reasonOf(error)}. No issue was created.`,
            error instanceof RedmineMcpError ? error.details : undefined
          );
        }
      }
      payload.uploads = uploads;
    }

    let created: RedmineIssue;
    try {
      created = await this.client.createIssue(payload);
    } catch (error) {
      // A timeout or 5xx may still have created the issue on the Redmine side.
      if (error instanceof RedmineMcpError && error.code === "UPSTREAM_ERROR") {
        throw new RedmineMcpError(
          "UPSTREAM_ERROR",
          `Creating the issue failed: ${reasonOf(error)}. The outcome is unknown: check project "${project.name}" for a new issue "${subject}" before retrying, to avoid a duplicate.`,
          error.details
        );
      }
      throw error;
    }

    const createdRef = { issue_id: created.id, url: `${baseUrl}/issues/${created.id}` };
    const partialFailure = (step: "verification" | "relation", reason: string) =>
      new RedmineMcpError(
        "UPSTREAM_ERROR",
        `Issue #${created.id} was created (${createdRef.url}) but ${reason} Fix it in Redmine; do not re-run create_issue, it would create a duplicate.`,
        { ...createdRef, failed_step: step }
      );

    let persisted: RedmineIssue;
    try {
      persisted = await this.getAuthorizedIssue(created.id);
    } catch (error) {
      throw partialFailure("verification", `re-reading it failed: ${reasonOf(error)}.`);
    }
    // A wrong project, tracker or subject means the wrong issue exists: stop before relating it.
    // A dropped priority or custom field is fixable in place, so the relation is still added first.
    const { identity, details } = describePersistenceProblems(persisted, {
      project,
      tracker,
      priority,
      subject,
      customFields,
      attachments: attachments.map((attachment) => attachment.filename)
    });
    if (identity.length > 0) {
      const skipped = relatedIssue ? " The relation step was skipped." : "";
      throw partialFailure("verification", `Redmine did not persist: ${[...identity, ...details].join("; ")}.${skipped}`);
    }

    const alsoNotPersisted = details.length > 0 ? ` Also not persisted: ${details.join("; ")}.` : "";
    let relationCreated = "";
    if (relatedIssue && relationType) {
      const relationLabel = `the "${relationType}" relation to #${relatedIssue.id}`;
      try {
        await this.client.createIssueRelation(created.id, relatedIssue.id, relationType);
      } catch (error) {
        throw partialFailure("relation", `adding ${relationLabel} failed: ${reasonOf(error)}.${alsoNotPersisted}`);
      }
      try {
        persisted = await this.getAuthorizedIssue(created.id);
      } catch (error) {
        throw partialFailure(
          "relation",
          `${relationLabel} was created and re-reading the issue afterwards failed: ${reasonOf(error)}. Check the relation in Redmine.${alsoNotPersisted}`
        );
      }
      if (!hasRelationBetween(persisted, relatedIssue.id)) {
        throw partialFailure("relation", `Redmine accepted ${relationLabel} but did not persist it.${alsoNotPersisted}`);
      }
      relationCreated = ` The "${relationType}" relation to #${relatedIssue.id} was created.`;
    }

    if (details.length > 0) {
      throw partialFailure("verification", `Redmine did not persist: ${details.join("; ")}.${relationCreated}`);
    }

    return {
      ...preview,
      action: "created",
      tracker: tracker ?? (persisted.tracker ? { ...persisted.tracker, source: "redmine_default" } : null),
      relation: preview.relation ? { ...preview.relation, action: "related" } : null,
      issue_id: created.id,
      url: createdRef.url,
      issue: normalizeIssueSummary(persisted, baseUrl)
    };
  }

  /** Reads every file before anything is written, so a missing or empty file creates nothing. */
  private async readNewIssueAttachments(filePaths: string[]) {
    const attachments: Array<Awaited<ReturnType<RedmineService["readAttachment"]>>> = [];
    for (const rawPath of filePaths) {
      const filePath = rawPath.trim();
      if (!filePath) {
        throw new RedmineMcpError("VALIDATION_ERROR", "Attachment paths must not be blank.");
      }
      const attachment = await this.readAttachment(filePath);
      const filename = redmineStoredFilename(attachment.filename);
      // Redmine matches an embedded !image! case-insensitively, and the verification goes by name.
      const twin = attachments.find((existing) => existing.filename.toLowerCase() === filename.toLowerCase());
      if (twin) {
        throw new RedmineMcpError(
          "VALIDATION_ERROR",
          `Attachments "${twin.filename}" and "${filename}" share a file name (letter case aside); rename one of them.`
        );
      }
      attachments.push({ ...attachment, filename });
    }
    return attachments;
  }

  private async resolveNewIssueTracker(
    project: ProjectRef,
    metadata: ProjectIssueMetadata,
    trackerRef?: string
  ): Promise<CreateIssueResult["tracker"]> {
    if (trackerRef === undefined) {
      // Redmine's default is the first tracker the user's role may add issues for, which the API does not expose,
      // so the tracker is left to Redmine and reported after the create.
      return null;
    }

    // Redmine silently replaces a tracker_id the role may not use; read-after-write catches that.
    const trackers = metadata.trackers ?? (await this.client.listTrackers());
    const tracker = matchNamedRef(trackerRef, trackers, "Tracker", `project "${project.name}"`);
    return { id: tracker.id, name: tracker.name, source: "input" };
  }

  private async resolveNewIssuePriority(priorityRef?: string): Promise<CreateIssueResult["priority"]> {
    const priorities = (await this.client.listIssuePriorities()).filter((priority) => priority.active !== false);
    if (priorityRef !== undefined) {
      const priority = matchNamedRef(priorityRef, priorities, "Priority", "Redmine issue priorities");
      return { id: priority.id, name: priority.name, source: "input" };
    }

    const fallback = priorities.find((priority) => priority.is_default);
    return fallback ? { id: fallback.id, name: fallback.name, source: "redmine_default" } : null;
  }

  /**
   * With readable field definitions (admin keys only): rejects given fields not enabled for the tracker,
   * which Redmine would drop silently, and lists required fields still missing.
   */
  private async checkCustomFieldDefinitions(
    metadata: ProjectIssueMetadata,
    tracker: CreateIssueResult["tracker"],
    provided: CreateIssueCustomField[]
  ): Promise<CreateIssueResult["required_custom_fields"]> {
    const unknown = (note: string) => ({ known: false, missing: [], note });

    let definitions: RedmineCustomFieldDefinition[];
    try {
      definitions = await this.client.listIssueCustomFieldDefinitions();
    } catch (error) {
      if (error instanceof RedmineMcpError && (error.code === "AUTH_ERROR" || error.code === "NOT_FOUND")) {
        return unknown(
          "Custom field definitions (/custom_fields.json) are readable only by Redmine admins, so required fields are unknown. Redmine checks them on create and rejects a missing one with VALIDATION_ERROR (nothing is created)."
        );
      }
      throw error;
    }
    if (!metadata.issue_custom_fields || !tracker) {
      return unknown(
        "Without a tracker, or when this Redmine does not expose the project's issue custom fields, required fields cannot be scoped."
      );
    }

    const appliesToTracker = (definition: RedmineCustomFieldDefinition) =>
      (definition.trackers ?? []).some((candidate) => candidate.id === tracker.id);
    for (const field of provided) {
      const definition = definitions.find((candidate) => candidate.id === field.id);
      if (definition && !appliesToTracker(definition)) {
        throw new RedmineMcpError(
          "VALIDATION_ERROR",
          `Custom field "${field.name}" is not enabled for tracker "${tracker.name}"; Redmine would drop its value silently.`
        );
      }
    }

    const projectFieldIds = new Set(metadata.issue_custom_fields.map((field) => field.id));
    const providedIds = new Set(provided.map((field) => field.id));
    const missing = definitions
      .filter(
        (definition) =>
          definition.is_required === true &&
          projectFieldIds.has(definition.id) &&
          appliesToTracker(definition) &&
          !definition.default_value?.trim() &&
          !providedIds.has(definition.id)
      )
      .map((definition) => ({ id: definition.id, name: definition.name.trim() }));

    return { known: true, missing };
  }

  public async updateIssueNote(input: {
    issue_id: number;
    journal_id: number;
    note: string;
  }): Promise<UpdateIssueNoteResult> {
    const note = input.note.trim();
    if (!note) {
      throw new RedmineMcpError(
        "VALIDATION_ERROR",
        "Note must not be empty. Use delete_issue_note to remove a note."
      );
    }
    return this.writeJournalNotes(input.issue_id, input.journal_id, note, "updated");
  }

  public async deleteIssueNote(input: { issue_id: number; journal_id: number }): Promise<UpdateIssueNoteResult> {
    return this.writeJournalNotes(input.issue_id, input.journal_id, "", "deleted");
  }

  private async writeJournalNotes(
    issueId: number,
    journalId: number,
    notes: string,
    action: UpdateIssueNoteResult["action"]
  ): Promise<UpdateIssueNoteResult> {
    const issue = await this.getAuthorizedIssue(issueId);
    const journal = (issue.journals ?? []).find((entry) => entry.id === journalId);
    if (!journal) {
      throw new RedmineMcpError(
        "NOT_FOUND",
        `Journal #${journalId} does not belong to issue #${issueId}.`
      );
    }
    if (!journal.notes?.trim()) {
      throw new RedmineMcpError(
        "VALIDATION_ERROR",
        `Journal #${journalId} has no note text (it only records field changes) and cannot be edited.`
      );
    }

    try {
      await this.client.updateJournalNotes(journalId, notes);
    } catch (error) {
      if (error instanceof RedmineMcpError && error.code === "NOT_FOUND") {
        throw new RedmineMcpError(
          "UPSTREAM_ERROR",
          "This Redmine does not expose PUT /journals/{id}.json (requires Redmine 5.0+). Edit the note in the Redmine UI."
        );
      }
      throw error;
    }

    const updated = await this.getAuthorizedIssue(issueId);
    const updatedJournal = (updated.journals ?? []).find((entry) => entry.id === journalId);
    const persisted =
      action === "deleted"
        ? !updatedJournal?.notes?.trim()
        : updatedJournal?.notes?.trim() === notes;
    if (!persisted) {
      throw new RedmineMcpError(
        "UPSTREAM_ERROR",
        `Redmine did not persist the note ${action === "deleted" ? "deletion" : "change"} for journal #${journalId} (missing edit_own_notes / edit_notes permission?).`
      );
    }

    return {
      issue_id: issueId,
      journal_id: journalId,
      action,
      issue: normalizeIssueDetail(updated, this.client.getBaseUrl())
    };
  }

  private async getAuthorizedIssue(issueId: number) {
    const issue = await this.client.getIssue(issueId, [
      "journals",
      "relations",
      "allowed_statuses",
      "attachments",
      "children"
    ]);
    const project = await this.client.getProject(String(issue.project.id));
    this.policy.assertProjectAllowed(project);
    return issue;
  }

  private async isIssueProjectAllowed(issue: RedmineIssue): Promise<boolean> {
    const project = await this.client.getProject(String(issue.project.id));
    try {
      this.policy.assertProjectAllowed(project);
      return true;
    } catch {
      return false;
    }
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

/** Redmine's Attachment#sanitize_filename: the name it stores, and the one a description has to embed. */
export function redmineStoredFilename(filename: string): string {
  return filename.replace(/^.*[\\/]/s, "").replace(/[/?%*:|"'<>\n\r]+/g, "_");
}

const INLINE_IMAGE_EXTENSION = /\.(bmp|gif|jpg|jpe|jpeg|png|webp)$/i;

/**
 * Textile that shows the image in a description, or null when Redmine does not inline that type.
 * Redmine CGI-unescapes the src (a "+" would become a space) and Textile ends the src at "(", "!" or a space,
 * so everything but [A-Za-z0-9-_.~] is percent-encoded.
 */
function inlineImageEmbed(filename: string): string | null {
  if (!INLINE_IMAGE_EXTENSION.test(filename)) {
    return null;
  }
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `!${encoded}!`;
}

function normalizeRelationType(relatedIssueId: number | undefined, relationType: string | undefined): string | undefined {
  if (relatedIssueId === undefined) {
    if (relationType?.trim()) {
      throw new RedmineMcpError("VALIDATION_ERROR", "relation_type requires related_issue_id.");
    }
    return undefined;
  }

  const normalized = relationType?.trim().toLowerCase() || DEFAULT_RELATION_TYPE;
  if (!(RELATION_TYPES as readonly string[]).includes(normalized)) {
    throw new RedmineMcpError(
      "VALIDATION_ERROR",
      `Unknown relation_type "${relationType}". Use one of: ${RELATION_TYPES.join(", ")}.`
    );
  }
  return normalized;
}

/** ID or name, case-insensitive: exact first, then a unique substring match; ambiguity is a VALIDATION_ERROR. */
function matchNamedRef<T extends NamedRef>(ref: string, candidates: T[], label: string, scope: string): T {
  const normalized = ref.trim().toLowerCase();
  const nameOf = (candidate: T) => candidate.name.trim();
  if (!normalized) {
    throw new RedmineMcpError("VALIDATION_ERROR", `${label} must not be blank.`);
  }

  const exact = candidates.find(
    (candidate) => String(candidate.id) === normalized || nameOf(candidate).toLowerCase() === normalized
  );
  if (exact) {
    return exact;
  }

  // A numeric reference is an ID; matching it as part of a name would pick an unrelated entry.
  const fuzzyMatches = /^\d+$/.test(normalized)
    ? []
    : candidates.filter((candidate) => nameOf(candidate).toLowerCase().includes(normalized));
  if (fuzzyMatches.length === 1) {
    return fuzzyMatches[0]!;
  }
  if (fuzzyMatches.length > 1) {
    throw new RedmineMcpError(
      "VALIDATION_ERROR",
      `${label} "${ref}" is ambiguous in ${scope}: ${fuzzyMatches.map(nameOf).join(", ")}.`
    );
  }

  throw new RedmineMcpError(
    "NOT_FOUND",
    `${label} "${ref}" was not found in ${scope}. Available: ${candidates.map(nameOf).join(", ")}.`
  );
}

function resolveNewIssueCustomFields(
  project: ProjectRef,
  metadata: ProjectIssueMetadata,
  input: Record<string, string | string[]>
): CreateIssueCustomField[] {
  const resolved: CreateIssueCustomField[] = [];

  for (const [ref, value] of Object.entries(input)) {
    let field: NamedRef;
    if (metadata.issue_custom_fields) {
      field = matchNamedRef(ref, metadata.issue_custom_fields, "Custom field", `project "${project.name}"`);
    } else if (/^\d+$/.test(ref.trim())) {
      field = { id: Number(ref.trim()), name: `#${ref.trim()}` };
    } else {
      throw new RedmineMcpError(
        "VALIDATION_ERROR",
        `Custom field "${ref}" cannot be resolved by name: this Redmine does not expose the project's issue custom fields. Pass the numeric ID instead.`
      );
    }

    if (resolved.some((existing) => existing.id === field.id)) {
      throw new RedmineMcpError(
        "VALIDATION_ERROR",
        `Custom field "${field.name.trim()}" is given more than once in custom_fields.`
      );
    }
    resolved.push({ id: field.id, name: field.name.trim(), value });
  }

  // Object key order puts numeric keys first; sort so the preview does not depend on how fields were named.
  return resolved.sort((left, right) => left.id - right.id);
}

function describePersistenceProblems(
  issue: RedmineIssue,
  expected: {
    project: ProjectRef;
    tracker: CreateIssueResult["tracker"];
    priority: CreateIssueResult["priority"];
    subject: string;
    customFields: CreateIssueCustomField[];
    attachments: string[];
  }
): { identity: string[]; details: string[] } {
  const identity: string[] = [];
  const details: string[] = [];
  if (issue.project.id !== expected.project.id) {
    identity.push(`project is "${issue.project.name}" instead of "${expected.project.name}"`);
  }
  if (expected.tracker && issue.tracker?.id !== expected.tracker.id) {
    identity.push(
      `tracker is "${issue.tracker?.name ?? "none"}" instead of "${expected.tracker.name}" (Redmine replaces a tracker your role may not use)`
    );
  }
  if (issue.subject.trim() !== expected.subject) {
    identity.push(`subject is "${issue.subject}" instead of "${expected.subject}"`);
  }
  if (expected.priority && issue.priority?.id !== expected.priority.id) {
    details.push(`priority is "${issue.priority?.name ?? "none"}" instead of "${expected.priority.name}"`);
  }
  for (const field of expected.customFields) {
    const actual = issue.custom_fields?.find((candidate) => candidate.id === field.id);
    if (!sameCustomFieldValue(actual?.value ?? null, field.value)) {
      const shown = actual ? JSON.stringify(actual.value) : "missing (not enabled for this tracker?)";
      details.push(`custom field "${field.name}" is ${shown} instead of ${JSON.stringify(field.value)}`);
    }
  }
  const storedFilenames = new Set((issue.attachments ?? []).map((attachment) => attachment.filename));
  for (const filename of expected.attachments) {
    if (!storedFilenames.has(filename)) {
      details.push(`attachment "${filename}" is missing (add it with attach_file_to_issue)`);
    }
  }
  return { identity, details };
}

function sameCustomFieldValue(actual: string | string[] | null, expected: string | string[]): boolean {
  // Redmine stores multi-values de-duplicated.
  const normalize = (value: string | string[] | null) => [
    ...new Set(
      (Array.isArray(value) ? value : value === null ? [] : [value]).map((entry) => entry.trim()).filter(Boolean)
    )
  ].sort();
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

function hasRelationBetween(issue: RedmineIssue, otherIssueId: number): boolean {
  return (issue.relations ?? []).some(
    (relation) =>
      (relation.issue_id === issue.id && relation.issue_to_id === otherIssueId) ||
      (relation.issue_id === otherIssueId && relation.issue_to_id === issue.id)
  );
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\.+$/, "");
}

function projectMatches(project: ProjectRef, projectRef: string): boolean {
  const normalized = projectRef.trim().toLowerCase();
  return (
    String(project.id).toLowerCase() === normalized ||
    project.name.toLowerCase() === normalized ||
    project.identifier?.toLowerCase() === normalized
  );
}
