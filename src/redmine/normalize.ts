import type {
  NormalizedIssueDetail,
  NormalizedIssueSummary,
  RedmineCustomField,
  RedmineIssue
} from "../types.js";

function issueUrl(baseUrl: string, issueId: number): string {
  return `${baseUrl}/issues/${issueId}`;
}

function normalizeCustomField(field: RedmineCustomField): { name: string; value: string | string[] } | null {
  if (field.value === null) {
    return null;
  }

  if (Array.isArray(field.value)) {
    const values = field.value.filter((value) => value.trim().length > 0);
    return values.length > 0 ? { name: field.name, value: values } : null;
  }

  return field.value.trim().length > 0 ? { name: field.name, value: field.value } : null;
}

export function normalizeIssueSummary(issue: RedmineIssue, baseUrl: string): NormalizedIssueSummary {
  return {
    id: issue.id,
    project: issue.project.name,
    subject: issue.subject,
    status: issue.status.name,
    priority: issue.priority?.name ?? null,
    assignee: issue.assigned_to?.name ?? null,
    author: issue.author?.name ?? null,
    updated_on: issue.updated_on,
    url: issueUrl(baseUrl, issue.id)
  };
}

export function normalizeIssueDetail(issue: RedmineIssue, baseUrl: string): NormalizedIssueDetail {
  const summary = normalizeIssueSummary(issue, baseUrl);

  return {
    ...summary,
    description: issue.description?.trim() || null,
    tracker: issue.tracker?.name ?? null,
    created_on: issue.created_on ?? null,
    custom_fields: (issue.custom_fields ?? [])
      .map(normalizeCustomField)
      .filter((field): field is { name: string; value: string | string[] } => field !== null),
    relations: (issue.relations ?? []).map((relation) => ({
      id: relation.id,
      type: relation.relation_type,
      issue_id: relation.issue_id ?? null,
      issue_to_id: relation.issue_to_id ?? null,
      delay: relation.delay ?? null
    })),
    journals: (issue.journals ?? []).map((journal) => ({
      id: journal.id,
      user: journal.user?.name ?? null,
      created_on: journal.created_on,
      notes: journal.notes?.trim() || null,
      details: (journal.details ?? []).map((detail) => ({
        property: detail.property,
        name: detail.name ?? null,
        old_value: detail.old_value ?? null,
        new_value: detail.new_value ?? null
      }))
    })),
    allowed_statuses: (issue.allowed_statuses ?? []).map((status) => status.name),
    parent_id: issue.parent?.id ?? null,
    children: (issue.children ?? []).map((child) => ({
      id: child.id,
      subject: child.subject,
      tracker: child.tracker?.name ?? null
    })),
    attachments: (issue.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      filesize: attachment.filesize ?? null,
      content_type: attachment.content_type ?? null,
      description: attachment.description?.trim() || null,
      author: attachment.author?.name ?? null,
      created_on: attachment.created_on ?? null,
      url: attachment.content_url ?? null
    }))
  };
}