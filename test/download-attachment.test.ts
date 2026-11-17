import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RedmineMcpError } from "../src/errors.js";
import { MAX_DOWNLOAD_BYTES, RedmineService } from "../src/service.js";
import type { ProjectRef, RedmineAttachment, RedmineIssue } from "../src/types.js";

const rossmannProject: ProjectRef = { id: 1, name: "Market3 Merge Rossmann", identifier: "rossmannmerge" };
const kasaProject: ProjectRef = { id: 9, name: "Rossmann - Kasa", identifier: "kasa" };

/** Structurally complete PNG: signature, IHDR with the given size, IEND (pixels are not decoded by the server). */
function png(width = 1, height = 1): Uint8Array {
  const bytes = new Uint8Array(45);
  const view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], 33);
  return bytes;
}

function jpeg(width = 1, height = 1): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9
  ]);
}

function gif(width = 1, height = 1): Uint8Array {
  return new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 0xff, width >> 8, height & 0xff, height >> 8, 0x00, 0x00, 0x00, 0x3b
  ]);
}

/** Lossless WebP (VP8L) header with the given size; RIFF size matches the length. */
function webp(width = 1, height = 1): Uint8Array {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c], 8);
  view.setUint32(16, 10, true);
  bytes[20] = 0x2f;
  const bits = (width - 1) | ((height - 1) << 14);
  view.setUint32(21, bits, true);
  return bytes;
}

/** WebP with a lossy (VP8) or extended (VP8X) header of the given size. */
function webpVariant(chunk: "VP8 " | "VP8X", width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set(Array.from(chunk, (char) => char.charCodeAt(0)), 12);
  view.setUint32(16, 10, true);
  if (chunk === "VP8 ") {
    bytes.set([0x9d, 0x01, 0x2a], 23);
    view.setUint16(26, width, true);
    view.setUint16(28, height, true);
  } else {
    view.setUint16(24, (width - 1) & 0xffff, true);
    bytes[26] = (width - 1) >> 16;
    view.setUint16(27, (height - 1) & 0xffff, true);
    bytes[29] = (height - 1) >> 16;
  }
  return bytes;
}

const PNG = png();

function attachment(overrides: Partial<RedmineAttachment> & Pick<RedmineAttachment, "id" | "filename">): RedmineAttachment {
  return {
    filesize: 45,
    content_type: "image/png",
    author: { id: 5, name: "Tomasz Śmierzchała" },
    created_on: "2026-10-28T13:25:45Z",
    content_url: `https://redmine.example.com/redmine/attachments/download/${overrides.id}/${overrides.filename}`,
    ...overrides
  };
}

function issueWith(attachments: RedmineAttachment[], project: ProjectRef = rossmannProject): RedmineIssue {
  return {
    id: 295390,
    project: { id: project.id, name: project.name },
    subject: "TEST: numer domu bez ulicy",
    status: { id: 3, name: "Rozwiązany" },
    updated_on: "2026-11-17T14:09:26Z",
    attachments
  };
}

function setup(issue: RedmineIssue, download: { bytes: Uint8Array; contentType?: string | null }) {
  const client = {
    getBaseUrl: () => "https://redmine.example.com/redmine",
    getIssue: vi.fn(async () => issue),
    getProject: vi.fn(async (projectRef: string) => (projectRef === "9" ? kasaProject : rossmannProject)),
    downloadAttachment: vi.fn(async () => ({ bytes: download.bytes, contentType: download.contentType ?? null }))
  };
  const service = new RedmineService(client as never, ["rossmannmerge"], ["rossmannmerge"]);
  return { client, service };
}

function textFile(id: number, filename: string, text = "x") {
  return setup(issueWith([attachment({ id, filename, content_type: "text/plain" })]), {
    bytes: new TextEncoder().encode(text)
  });
}

describe("RedmineService.downloadAttachment", () => {
  let saveDir: string;
  let realSaveDir: string;

  beforeEach(async () => {
    saveDir = await mkdtemp(join(tmpdir(), "redmine-mcp-download-test-"));
    realSaveDir = await realpath(saveDir);
  });

  afterEach(async () => {
    await rm(saveDir, { recursive: true, force: true });
  });

  it("rejects an issue outside the allowlist with POLICY_ERROR before downloading", async () => {
    const { client, service } = setup(issueWith([attachment({ id: 1, filename: "a.png" })], kasaProject), {
      bytes: PNG
    });

    await expect(service.downloadAttachment({ issue_id: 295390, attachment_id: 1 })).rejects.toMatchObject({
      code: "POLICY_ERROR",
      message: 'Project "Rossmann - Kasa" is outside the REDMINE_ALLOWED_PROJECTS allowlist.'
    });
    expect(client.downloadAttachment).not.toHaveBeenCalled();
  });

  it("rejects an attachment that belongs to another issue with NOT_FOUND before downloading", async () => {
    const { client, service } = setup(issueWith([attachment({ id: 1, filename: "a.png" })]), { bytes: PNG });

    const error = await service
      .downloadAttachment({ issue_id: 295390, attachment_id: 777 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RedmineMcpError);
    expect(error).toMatchObject({ code: "NOT_FOUND", details: { attachment_ids_on_issue: [1] } });
    expect((error as Error).message).toContain("#295390");
    expect(client.downloadAttachment).not.toHaveBeenCalled();
  });

  it("returns a PNG as an inline image with its metadata", async () => {
    const meta = attachment({ id: 296490, filename: "clipboard-202610281423-eenjm.png" });
    const { client, service } = setup(issueWith([meta]), { bytes: PNG, contentType: "image/png" });

    const result = await service.downloadAttachment({ issue_id: 295390, attachment_id: 296490 });

    expect(client.getIssue).toHaveBeenCalledWith(295390, expect.arrayContaining(["attachments"]));
    expect(client.downloadAttachment).toHaveBeenCalledWith({
      attachmentId: 296490,
      contentUrl: meta.content_url,
      maxBytes: MAX_DOWNLOAD_BYTES
    });
    expect(result.delivered_as).toBe("image");
    expect(result.image).toEqual({ data: Buffer.from(PNG).toString("base64"), mime_type: "image/png" });
    expect(result.saved_to).toBeNull();
    expect(result.attachment).toMatchObject({
      issue_id: 295390,
      id: 296490,
      filename: "clipboard-202610281423-eenjm.png",
      filesize: PNG.byteLength,
      content_type: "image/png",
      author: "Tomasz Śmierzchała",
      created_on: "2026-10-28T13:25:45Z"
    });
  });

  it.each([
    ["image/jpeg", jpeg(640, 480)],
    ["image/gif", gif(640, 480)],
    ["image/webp", webp(640, 480)],
    ["image/webp", webpVariant("VP8 ", 640, 480)],
    ["image/webp", webpVariant("VP8X", 640, 480)]
  ])("returns a %s inline", async (mimeType, bytes) => {
    const { service } = setup(issueWith([attachment({ id: 2, filename: "img", content_type: mimeType })]), { bytes });

    const result = await service.downloadAttachment({ issue_id: 295390, attachment_id: 2 });

    expect(result.delivered_as).toBe("image");
    expect(result.image?.mime_type).toBe(mimeType);
  });

  it("takes the image type from the bytes, not from the label", async () => {
    const { service } = setup(issueWith([attachment({ id: 2, filename: "photo.png", content_type: "image/png" })]), {
      bytes: jpeg()
    });

    const result = await service.downloadAttachment({ issue_id: 295390, attachment_id: 2 });

    expect(result.image?.mime_type).toBe("image/jpeg");
  });

  it.each([
    ["a truncated PNG (no IEND)", png().subarray(0, 33), /truncated or damaged/],
    ["a PNG taller than 8000 px", png(1200, 9000), /1200×9000 px.*8000 px/],
    ["a JPEG wider than 8000 px", jpeg(8001, 10), /8001×10 px/],
    ["a JPEG without its end marker", jpeg().subarray(0, 39), /truncated or damaged/],
    ["a GIF without its trailer", gif().subarray(0, 13), /truncated or damaged/],
    ["a WebP shorter than its RIFF size", webp().subarray(0, 26), /truncated or damaged/],
    ["an extended WebP wider than 8000 px", webpVariant("VP8X", 70000, 10), /70000×10 px/]
  ])("saves %s as a file instead of an image block", async (_label, bytes, note) => {
    const { service } = setup(issueWith([attachment({ id: 20, filename: "shot.png" })]), { bytes });

    const result = await service.downloadAttachment({ issue_id: 295390, attachment_id: 20, save_dir: saveDir });

    expect(result.delivered_as).toBe("file");
    expect(result.image).toBeUndefined();
    expect(result.saved_to).toBe(join(realSaveDir, "20-shot.png"));
    expect(result.note).toMatch(note);
  });

  it.each([
    ["a RIFF file that is not WebP (WAV)", new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])],
    ["bytes starting with 0xFF but not a JPEG", new Uint8Array([0xff, 0x00, 0xff, 0xd9])]
  ])("does not treat %s as an image", async (_label, bytes) => {
    const { service } = setup(issueWith([attachment({ id: 21, filename: "x.bin", content_type: "application/octet-stream" })]), {
      bytes
    });

    const result = await service.downloadAttachment({ issue_id: 295390, attachment_id: 21, save_dir: saveDir });

    expect(result.delivered_as).toBe("file");
    expect(result.image).toBeUndefined();
  });

  it("saves a non-image file under save_dir and returns only its path", async () => {
    const log = new TextEncoder().encode("line 1\nline 2\n");
    const { service } = setup(
      issueWith([attachment({ id: 3, filename: "kasa.log", content_type: "text/plain", filesize: log.byteLength })]),
      { bytes: log, contentType: "text/plain" }
    );

    const result = await service.downloadAttachment({ issue_id: 295390, attachment_id: 3, save_dir: saveDir });

    expect(result.delivered_as).toBe("file");
    expect(result.image).toBeUndefined();
    expect(result.saved_to).toBe(join(realSaveDir, "3-kasa.log"));
    expect(new Uint8Array(await readFile(join(saveDir, "3-kasa.log")))).toEqual(log);
    expect(JSON.stringify(result)).not.toContain("line 1");
  });

  it("saves a non-image file under the system temp directory by default", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2]);
    const { service } = setup(
      issueWith([attachment({ id: 987654321, filename: "dump.zip", content_type: "application/zip" })]),
      { bytes: zip }
    );

    const result = await service.downloadAttachment({ issue_id: 295390, attachment_id: 987654321 });

    try {
      expect(result.saved_to).toBe(join(await realpath(tmpdir()), "redmine-mcp-attachments", "987654321-dump.zip"));
      expect(new Uint8Array(await readFile(result.saved_to as string))).toEqual(zip);
    } finally {
      await rm(result.saved_to as string, { force: true });
    }
  });

  it("also saves an inline image when save_dir is given", async () => {
    const { service } = setup(issueWith([attachment({ id: 4, filename: "shot.png" })]), { bytes: PNG });

    const result = await service.downloadAttachment({ issue_id: 295390, attachment_id: 4, save_dir: saveDir });

    expect(result.delivered_as).toBe("image");
    expect(result.saved_to).toBe(join(realSaveDir, "4-shot.png"));
    expect(new Uint8Array(await readFile(join(saveDir, "4-shot.png")))).toEqual(PNG);
  });

  it("saves a file labelled as an image whose bytes are not an image, with a note", async () => {
    const html = new TextEncoder().encode("<html>login</html>");
    const { service } = setup(issueWith([attachment({ id: 5, filename: "fake.png" })]), { bytes: html });

    const result = await service.downloadAttachment({ issue_id: 295390, attachment_id: 5, save_dir: saveDir });

    expect(result.delivered_as).toBe("file");
    expect(result.image).toBeUndefined();
    expect(result.saved_to).toBe(join(realSaveDir, "5-fake.png"));
    expect(result.note).toMatch(/not a PNG, JPEG, GIF or WebP/);
  });

  it("saves an image too large to show inline, with a note", async () => {
    const big = new Uint8Array(3_750_001);
    big.set(PNG);
    const { service } = setup(issueWith([attachment({ id: 6, filename: "big.png", filesize: big.byteLength })]), {
      bytes: big
    });

    const result = await service.downloadAttachment({ issue_id: 295390, attachment_id: 6, save_dir: saveDir });

    expect(result.delivered_as).toBe("file");
    expect(result.image).toBeUndefined();
    expect(result.note).toMatch(/too large to show inline/);
  });

  it("refuses an attachment whose Redmine size is over the limit before downloading", async () => {
    const { client, service } = setup(
      issueWith([attachment({ id: 7, filename: "huge.zip", filesize: MAX_DOWNLOAD_BYTES + 1 })]),
      { bytes: PNG }
    );

    await expect(service.downloadAttachment({ issue_id: 295390, attachment_id: 7 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("10 MB")
    });
    expect(client.downloadAttachment).not.toHaveBeenCalled();
  });

  it("keeps the saved file inside save_dir whatever the attachment name", async () => {
    const { service } = textFile(8, "..\\..\\evil:name?.txt");

    const result = await service.downloadAttachment({ issue_id: 295390, attachment_id: 8, save_dir: saveDir });

    expect(result.saved_to).toBe(join(realSaveDir, "8-evil_name_.txt"));
    expect(await readdir(saveDir)).toEqual(["8-evil_name_.txt"]);
  });

  it("replaces control characters in the saved name", async () => {
    const { service } = textFile(14, "a\u0001b\u001fc.txt");

    const result = await service.downloadAttachment({ issue_id: 295390, attachment_id: 14, save_dir: saveDir });

    expect(result.saved_to).toBe(join(realSaveDir, "14-a_b_c.txt"));
  });

  it("shortens a very long name but keeps its extension", async () => {
    const { service } = textFile(15, `${"a".repeat(255)}.txt`);

    const result = await service.downloadAttachment({ issue_id: 295390, attachment_id: 15, save_dir: saveDir });

    const name = basename(result.saved_to as string);
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name).toMatch(/^15-a+\.txt$/);
    expect(await readdir(saveDir)).toEqual([name]);
  });

  it("refuses a save_dir outside the system temp directory and creates nothing", async () => {
    const outside = resolve(tmpdir(), "..", `kb24-outside-${process.pid}-${Date.now()}`);
    const { service } = textFile(10, "a.bat");

    await expect(
      service.downloadAttachment({ issue_id: 295390, attachment_id: 10, save_dir: join(saveDir, "..", "..", basename(outside)) })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("temp directory") });
    await expect(stat(outside)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses the temp directory itself as save_dir", async () => {
    const { service } = textFile(16, "a.txt");

    await expect(
      service.downloadAttachment({ issue_id: 295390, attachment_id: 16, save_dir: tmpdir() })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("temp directory") });
  });

  it("refuses a relative save_dir", async () => {
    const { service } = textFile(17, "a.txt");

    await expect(
      service.downloadAttachment({ issue_id: 295390, attachment_id: 17, save_dir: "~/Downloads" })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("absolute") });
  });

  it("refuses a save_dir that leaves the temp directory through a junction or symlink", async () => {
    const target = await mkdtemp(join(process.cwd(), ".kb24-link-target-"));
    const link = join(saveDir, "link");
    await symlink(target, link, "junction");
    const { service } = textFile(11, "a.bat");

    try {
      await expect(
        service.downloadAttachment({ issue_id: 295390, attachment_id: 11, save_dir: join(link, "sub") })
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("temp directory") });
      expect(await readdir(target)).toEqual([]);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("refuses a directory that other users can write to", async () => {
    const shared = join(saveDir, "shared");
    await mkdir(shared);
    await chmod(shared, 0o777);
    const { service } = textFile(12, "a.txt");

    await expect(
      service.downloadAttachment({ issue_id: 295390, attachment_id: 12, save_dir: join(shared, "inner") })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("writable by others") });
    expect(await readdir(shared)).toEqual(["inner"]);
    expect(await readdir(join(shared, "inner"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("creates the directory and the file private to the user", async () => {
    const { service } = textFile(13, "a.txt");

    const result = await service.downloadAttachment({
      issue_id: 295390,
      attachment_id: 13,
      save_dir: join(saveDir, "fresh")
    });

    expect((await stat(join(saveDir, "fresh"))).mode & 0o777).toBe(0o700);
    expect((await stat(result.saved_to as string)).mode & 0o777).toBe(0o600);
  });

  it("reuses an identical earlier download and never overwrites a different file", async () => {
    const { service } = textFile(9, "a.txt", "same");

    await service.downloadAttachment({ issue_id: 295390, attachment_id: 9, save_dir: saveDir });
    const again = await service.downloadAttachment({ issue_id: 295390, attachment_id: 9, save_dir: saveDir });
    expect(again.saved_to).toBe(join(realSaveDir, "9-a.txt"));

    await writeFile(join(saveDir, "9-a.txt"), "someone else's file");
    await expect(
      service.downloadAttachment({ issue_id: 295390, attachment_id: 9, save_dir: saveDir })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("already exists") });
    expect(await readFile(join(saveDir, "9-a.txt"), "utf8")).toBe("someone else's file");
  });
});
