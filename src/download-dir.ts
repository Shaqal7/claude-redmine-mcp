import { tmpdir } from "node:os";
import { join } from "node:path";

/** The only folder download_attachment saves into when REDMINE_DOWNLOAD_DIR is not set. */
export function defaultDownloadDir(): string {
  return join(tmpdir(), "redmine-mcp-attachments");
}
