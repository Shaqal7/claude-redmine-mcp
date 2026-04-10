import type { ErrorCode } from "./types.js";

export class RedmineMcpError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: unknown;

  public constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "RedmineMcpError";
    this.code = code;
    this.details = details;
  }
}

export function isRedmineMcpError(value: unknown): value is RedmineMcpError {
  return value instanceof RedmineMcpError;
}