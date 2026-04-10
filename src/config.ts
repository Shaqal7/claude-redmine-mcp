import "dotenv/config";

import { RedmineMcpError } from "./errors.js";
import type { AppConfig } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const redmineBaseUrl = env.REDMINE_BASE_URL?.trim();
  const redmineApiKey = env.REDMINE_API_KEY?.trim();
  const allowedProjects = env.REDMINE_ALLOWED_PROJECTS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const timeoutMs = Number.parseInt(env.REDMINE_TIMEOUT_MS ?? "", 10);

  if (!redmineBaseUrl) {
    throw new RedmineMcpError(
      "VALIDATION_ERROR",
      "Missing REDMINE_BASE_URL environment variable."
    );
  }

  if (!redmineApiKey) {
    throw new RedmineMcpError(
      "VALIDATION_ERROR",
      "Missing REDMINE_API_KEY environment variable."
    );
  }

  if (!allowedProjects || allowedProjects.length === 0) {
    throw new RedmineMcpError(
      "VALIDATION_ERROR",
      "Missing REDMINE_ALLOWED_PROJECTS environment variable."
    );
  }

  return {
    redmineBaseUrl: redmineBaseUrl.replace(/\/+$/, ""),
    redmineApiKey,
    allowedProjects,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  };
}