export type ErrorCode =
  | "AUTH_ERROR"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "POLICY_ERROR"
  | "UPSTREAM_ERROR";

export interface AppConfig {
  redmineBaseUrl: string;
  redmineApiKey: string;
  allowedProjects: string[];
  defaultExternalProjects: string[];
  timeoutMs: number;
}

export interface NamedRef {
  id: number;
  name: string;
}

export interface ProjectRef extends NamedRef {
  identifier?: string;
}

export interface RedmineCustomField {
  id: number;
  name: string;
  value: string | string[] | null;
}

export interface RedmineJournalDetail {
  property: string;
  name?: string;
  old_value?: string | null;
  new_value?: string | null;
}

export interface RedmineJournal {
  id: number;
  user?: NamedRef;
  notes?: string;
  private_notes?: boolean;
  created_on: string;
  details?: RedmineJournalDetail[];
}

export interface RedmineRelation {
  id: number;
  relation_type: string;
  issue_id?: number;
  issue_to_id?: number;
  delay?: number | null;
}

export interface RedmineAttachment {
  id: number;
  filename: string;
  filesize?: number;
  content_type?: string;
  description?: string;
  content_url?: string;
  author?: NamedRef;
  created_on?: string;
}

export interface RedmineChildIssue {
  id: number;
  subject: string;
  tracker?: NamedRef;
}

export interface RedmineIssue {
  id: number;
  project: NamedRef;
  parent?: { id: number };
  tracker?: NamedRef;
  status: NamedRef;
  priority?: NamedRef;
  author?: NamedRef;
  assigned_to?: NamedRef;
  subject: string;
  description?: string;
  created_on?: string;
  updated_on: string;
  is_private?: boolean;
  custom_fields?: RedmineCustomField[];
  journals?: RedmineJournal[];
  relations?: RedmineRelation[];
  allowed_statuses?: NamedRef[];
  attachments?: RedmineAttachment[];
  children?: RedmineChildIssue[];
}

export interface RedmineSearchResult {
  id: number;
  title: string;
  type: string;
  url: string;
  description?: string;
  datetime?: string;
}

export interface RedmineSearchResponse {
  results: RedmineSearchResult[];
  total_count: number;
  offset: number;
  limit: number;
}

export interface RedmineIssueListResponse {
  issues: RedmineIssue[];
  total_count: number;
  limit: number;
  offset: number;
}

export interface RedmineIssueResponse {
  issue: RedmineIssue;
}

export interface RedmineProjectResponse {
  project: ProjectRef;
}

export interface ProjectIssueMetadata {
  /** Undefined when this Redmine ignores include=trackers. */
  trackers?: NamedRef[];
  /** Undefined when this Redmine ignores include=issue_custom_fields. */
  issue_custom_fields?: NamedRef[];
}

export interface RedmineProjectIssueMetadataResponse {
  project: ProjectRef & ProjectIssueMetadata;
}

export interface RedmineTrackersResponse {
  trackers: NamedRef[];
}

export interface RedmineIssuePriority extends NamedRef {
  is_default?: boolean;
  active?: boolean;
}

export interface RedmineIssuePrioritiesResponse {
  issue_priorities: RedmineIssuePriority[];
}

export interface RedmineCustomFieldDefinition extends NamedRef {
  customized_type?: string;
  is_required?: boolean;
  default_value?: string | null;
  trackers?: NamedRef[];
}

export interface RedmineCustomFieldsResponse {
  custom_fields: RedmineCustomFieldDefinition[];
}

export interface RedmineRelationResponse {
  relation: RedmineRelation;
}

export interface RedmineStatusesResponse {
  issue_statuses: Array<NamedRef & { is_closed?: boolean }>;
}

export interface RedmineMembership {
  id: number;
  user?: NamedRef;
}

export interface RedmineMembershipsResponse {
  memberships: RedmineMembership[];
  total_count: number;
  limit: number;
  offset: number;
}

export interface RedmineCurrentUserResponse {
  user: {
    id: number;
    login?: string;
    firstname: string;
    lastname: string;
    mail?: string;
  };
}

export interface NormalizedIssueSummary {
  id: number;
  project: string;
  subject: string;
  status: string;
  priority: string | null;
  assignee: string | null;
  author: string | null;
  updated_on: string;
  url: string;
}

export interface NormalizedIssueDetail extends NormalizedIssueSummary {
  description: string | null;
  tracker: string | null;
  created_on: string | null;
  custom_fields: Array<{ name: string; value: string | string[] }>;
  relations: Array<{
    id: number;
    type: string;
    issue_id: number | null;
    issue_to_id: number | null;
    delay: number | null;
  }>;
  journals: Array<{
    id: number;
    user: string | null;
    created_on: string;
    notes: string | null;
    details: Array<{
      property: string;
      name: string | null;
      old_value: string | null;
      new_value: string | null;
    }>;
  }>;
  allowed_statuses: string[];
  parent_id: number | null;
  children: Array<{ id: number; subject: string; tracker: string | null }>;
  attachments: Array<{
    id: number;
    filename: string;
    filesize: number | null;
    content_type: string | null;
    description: string | null;
    author: string | null;
    created_on: string | null;
    url: string | null;
  }>;
}

export interface ListIssuesResult {
  project: string;
  count: number;
  total_count: number;
  issues: NormalizedIssueSummary[];
}

export interface SearchIssueHit extends NormalizedIssueSummary {
  /** Fragment of the matching text as returned by Redmine search (subject, description or a note). */
  match_excerpt?: string | null;
}

export interface SearchIssuesResult {
  query: string;
  /** "fulltext" = Redmine /search.json (whole history, incl. notes); "scan" = legacy fallback over recent issues. */
  mode: "fulltext" | "scan";
  count: number;
  /** fulltext: search hits examined; scan: issues examined. */
  scanned_issues: number;
  /** fulltext only: total hits reported by Redmine across searched projects. */
  total_hits?: number;
  truncated: boolean;
  issues: SearchIssueHit[];
}

export interface UpdateIssueNoteResult {
  issue_id: number;
  journal_id: number;
  action: "updated" | "deleted";
  issue: NormalizedIssueDetail;
}

export interface ResolveRelatedTestChainStep {
  issue: NormalizedIssueSummary;
  role: "test" | "same_project_issue" | "external_issue";
  target_status: string;
  action: "would_update" | "updated";
}

export interface ResolveRelatedTestChainResult {
  dry_run: boolean;
  note: string;
  status: string;
  external_projects: string[];
  steps: ResolveRelatedTestChainStep[];
}

export interface RedmineUploadResponse {
  upload: { token: string };
}

export interface AttachmentDescriptor {
  filename: string;
  content_type: string;
  size: number;
}

export interface AttachFileToChainStep {
  issue: NormalizedIssueSummary;
  role: "test" | "external_issue";
  action: "would_attach" | "attached";
}

export interface AttachFileToChainResult {
  dry_run: boolean;
  note: string;
  attachment: AttachmentDescriptor;
  external_projects: string[];
  steps: AttachFileToChainStep[];
}

export interface ResolveChainWithAttachmentStep {
  issue: NormalizedIssueSummary;
  role: "test" | "same_project_issue" | "external_issue";
  target_status: string;
  action: "would_update_with_attachment" | "updated_with_attachment";
}

export interface ResolveChainWithAttachmentResult {
  dry_run: boolean;
  note: string;
  status: string;
  attachment: AttachmentDescriptor;
  external_projects: string[];
  steps: ResolveChainWithAttachmentStep[];
}

export interface CreateIssueCustomField {
  id: number;
  name: string;
  value: string | string[];
}

export interface CreateIssueResult {
  dry_run: boolean;
  action: "would_create" | "created";
  project: { id: number; name: string; identifier: string | null };
  /** null in a preview without input tracker: Redmine picks the first tracker the user's role may add; set after create. */
  tracker: (NamedRef & { source: "input" | "redmine_default" }) | null;
  /** null = Redmine has no default priority configured; Redmine decides. */
  priority: (NamedRef & { source: "input" | "redmine_default" }) | null;
  subject: string;
  description: string;
  custom_fields: CreateIssueCustomField[];
  /** Named as Redmine stores them, which is the name a description embeds (`!name!`, spaces as %20). */
  attachments: AttachmentDescriptor[];
  required_custom_fields: {
    /** false when the field definitions are not readable with this API key (admin-only endpoint). */
    known: boolean;
    missing: NamedRef[];
    note?: string;
  };
  /** Things the preview cannot settle up front (default tracker, cross-project relation). */
  notes: string[];
  relation: {
    type: string;
    action: "would_relate" | "related";
    issue: NormalizedIssueSummary;
  } | null;
  issue_id: number | null;
  url: string | null;
  issue: NormalizedIssueSummary | null;
}
