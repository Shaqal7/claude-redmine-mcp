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

export interface RedmineIssue {
  id: number;
  project: NamedRef;
  tracker?: NamedRef;
  status: NamedRef;
  priority?: NamedRef;
  author?: NamedRef;
  assigned_to?: NamedRef;
  subject: string;
  description?: string;
  created_on?: string;
  updated_on: string;
  custom_fields?: RedmineCustomField[];
  journals?: RedmineJournal[];
  relations?: RedmineRelation[];
  allowed_statuses?: NamedRef[];
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
}

export interface ListIssuesResult {
  project: string;
  count: number;
  total_count: number;
  issues: NormalizedIssueSummary[];
}

export interface SearchIssuesResult {
  query: string;
  count: number;
  scanned_issues: number;
  truncated: boolean;
  issues: NormalizedIssueSummary[];
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
