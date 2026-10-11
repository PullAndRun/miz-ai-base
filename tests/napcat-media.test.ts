import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  buildNapcatFileUrl,
  createHashedMediaFileName,
  removeStaleMediaFiles,
  resolveSharedMediaDirectory,
  sharedMediaFileExists,
  writeSharedMediaFile,
} from "@/napcat-media";

const testRootDirectory = await mkdtemp(path.join(tmpdir(), "miz-napcat-media-test-"));

afterAll(async () => {
  await rm(testRootDirectory, { recursive: true, force: true });
});

describe("napcat shared media files", () => {
  test("resolves the shared directory per runtime mode", () => {
    expect(resolveSharedMediaDirectory("docker", "/ignored")).toBe(path.join(process.cwd(), "temp"));
    expect(resolveSharedMediaDirectory("normal", "/data/media")).toBe("/data/media");
  });

  test("builds a file URL for the NapCat-side directory", () => {
    expect(buildNapcatFileUrl("/app/media", "miz-vtb-image-abc.jpg")).toBe(
      "file:///app/media/miz-vtb-image-abc.jpg",
    );
  });

  test("names files deterministically from the key and extension", () => {
    const first = createHashedMediaFileName("miz-vtb-image-", "https://example.test/a.jpg", "jpg");
    const second = createHashedMediaFileName("miz-vtb-image-", "https://example.test/a.jpg", "jpg");
    const other = createHashedMediaFileName("miz-vtb-image-", "https://example.test/b.jpg", "jpg");

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^miz-vtb-image-[0-9a-f]{20}\.jpg$/);
  });

  test("writes files atomically and reports their existence", async () => {
    const directory = path.join(testRootDirectory, "write");
    const fileName = createHashedMediaFileName("miz-vtb-image-", "write-test", "png");
    expect(await sharedMediaFileExists(directory, fileName)).toBeFalse();

    const targetPath = await writeSharedMediaFile(directory, fileName, new Uint8Array([1, 2, 3]));
    expect(targetPath).toBe(path.join(directory, fileName));
    expect(await sharedMediaFileExists(directory, fileName)).toBeTrue();
    expect(await readdir(directory)).toEqual([fileName]);
  });

  test("removes only stale managed files", async () => {
    const directory = path.join(testRootDirectory, "stale");
    const staleName = "miz-vtb-image-0123456789abcdef0123.jpg";
    const freshName = "miz-vtb-image-aaaaaaaaaaaaaaaaaaaa.jpg";
    const foreignName = "miz-video-deadbeef.mp4";
    await writeSharedMediaFile(directory, staleName, new Uint8Array([1]));
    await writeSharedMediaFile(directory, freshName, new Uint8Array([2]));
    await writeSharedMediaFile(directory, foreignName, new Uint8Array([3]));

    const stalePath = path.join(directory, staleName);
    const oldSeconds = (Date.now() - 48 * 60 * 60_000) / 1000;
    await utimes(stalePath, oldSeconds, oldSeconds);
    await utimes(path.join(directory, foreignName), oldSeconds, oldSeconds);

    const removed = await removeStaleMediaFiles(
      directory,
      (fileName) => /^miz-vtb-image-[0-9a-f]{20}\./.test(fileName),
      24 * 60 * 60_000,
    );

    expect(removed).toEqual([stalePath]);
    expect(await sharedMediaFileExists(directory, staleName)).toBeFalse();
    expect(await sharedMediaFileExists(directory, freshName)).toBeTrue();
    expect(await sharedMediaFileExists(directory, foreignName)).toBeTrue();
  });
});
