import { RedmineMcpError } from "../errors.js";
import type { ProjectRef } from "../types.js";

function normalizeProjectToken(value: string | number): string {
  return String(value).trim().toLowerCase();
}

export class ProjectPolicy {
  private readonly allowedTokens: Set<string>;
  private readonly rawTokens: string[];

  public constructor(allowedProjects: string[]) {
    this.rawTokens = [...allowedProjects];
    this.allowedTokens = new Set(allowedProjects.map(normalizeProjectToken));
  }

  public getAllowedProjects(): string[] {
    return [...this.rawTokens];
  }

  public assertProjectAllowed(project: ProjectRef): void {
    const candidates = [
      normalizeProjectToken(project.id),
      normalizeProjectToken(project.name)
    ];

    if (project.identifier) {
      candidates.push(normalizeProjectToken(project.identifier));
    }

    if (candidates.some((candidate) => this.allowedTokens.has(candidate))) {
      return;
    }

    throw new RedmineMcpError(
      "POLICY_ERROR",
      `Project "${project.name}" is outside the REDMINE_ALLOWED_PROJECTS allowlist.`
    );
  }
}