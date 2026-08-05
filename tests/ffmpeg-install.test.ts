import { describe, expect, test } from "bun:test";
import {
  createFfmpegDownloadProgressReporter,
  ensureFfmpeg,
  formatFfmpegDownloadProgress,
  getManualFfmpegPlatforms,
  getFfmpegAsset,
  isSupportedFfmpegVersion,
  parseExpectedSha256,
  parseFfmpegVersion,
  SUPPORTED_FFMPEG_RELEASE,
} from "@/ffmpeg-install";
import type { VideoConfig } from "@/config";

const videoConfig: VideoConfig = {
  enabled: true,
  runtimeMode: "normal",
  whitelistUserIds: [],
  bilibiliHosts: ["bilibili.com"],
  downloadDirectory: "/temp",
  napcatMediaDirectory: "/app/media",
  ytDlpLinuxPath: "tools/yt-dlp",
  ytDlpWindowsPath: "tools/yt-dlp.exe",
  ffmpegLinuxPath: "tools/ffmpeg",
  ffmpegWindowsPath: "tools/ffmpeg.exe",
  maxConcurrentJobs: 2,
  updateCron: "0 0 * * *",
};

describe("manual FFmpeg download", () => {
  test("is isolated from the application startup path", async () => {
    const [appStartup, runtimeStartup, downloader, packageJson] = await Promise.all([
      Bun.file("scripts/start.ts").text(),
      Bun.file("src/index.ts").text(),
      Bun.file("scripts/download-ffmpeg.ts").text(),
      Bun.file("package.json").json() as Promise<{ scripts: Record<string, string> }>,
    ]);

    expect(appStartup).not.toContain("ffmpeg");
    expect(runtimeStartup).not.toContain("ensureFfmpeg");
    expect(downloader).not.toMatch(/prisma|NapLink|src\/index/);
    expect(packageJson.scripts["ffmpeg:download"]).toBe("bun run scripts/download-ffmpeg.ts");
  });

  test("the manual downloader targets both Windows and Linux", () => {
    expect(getManualFfmpegPlatforms()).toEqual(["win32", "linux"]);
  });
  test("pins Windows x64 to the verified Gyan 8.1.2 release", () => {
    const asset = getFfmpegAsset("win32", "x64");
    expect(asset.archiveName).toBe("ffmpeg-8.1.2-essentials_build.zip");
    expect(asset.archiveUrl).toBe(
      "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip",
    );
    expect(asset.checksumMode).toBe("single");
    expect(asset.executableName).toBe("ffmpeg.exe");
  });

  test("uses the stable 8.1 branch for supported BtbN platforms", () => {
    expect(getFfmpegAsset("linux", "x64").archiveName).toBe(
      "ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz",
    );
    expect(getFfmpegAsset("linux", "arm64").archiveName).toBe(
      "ffmpeg-n8.1-latest-linuxarm64-gpl-8.1.tar.xz",
    );
    expect(getFfmpegAsset("win32", "arm64").archiveName).toBe(
      "ffmpeg-n8.1-latest-winarm64-gpl-8.1.zip",
    );
    expect(() => getFfmpegAsset("darwin", "arm64")).toThrow("not supported");
  });

  test("accepts 8.1 patch releases and skips unrelated versions", () => {
    expect(SUPPORTED_FFMPEG_RELEASE).toBe("8.1");
    expect(parseFfmpegVersion("ffmpeg version 8.1.2-full_build-www.gyan.dev\n")).toBe("8.1.2");
    expect(parseFfmpegVersion("ffmpeg version n8.1.3-12-gabcdef\n")).toBe("8.1.3");
    expect(isSupportedFfmpegVersion("ffmpeg version 8.1.2\n")).toBeTrue();
    expect(isSupportedFfmpegVersion("ffmpeg version n8.1.3-12-gabcdef\n")).toBeTrue();
    expect(isSupportedFfmpegVersion("ffmpeg version 8.0.1\n")).toBeFalse();
    expect(isSupportedFfmpegVersion("ffmpeg version 2026-07-09-git-main\n")).toBeFalse();
  });

  test("does not download again when the configured FFmpeg is already 8.1", async () => {
    let versionChecks = 0;
    let progressEvents = 0;
    const result = await ensureFfmpeg(videoConfig, { proxyUrl: "http://proxy.example.test:7890" }, {
      readCurrentVersion: async () => {
        versionChecks += 1;
        return "ffmpeg version 8.1.2-essentials_build-www.gyan.dev\n";
      },
      onDownloadProgress: () => {
        progressEvents += 1;
      },
    });

    expect(result.status).toBe("current");
    expect(result.version).toBe("8.1.2");
    expect(versionChecks).toBe(1);
    expect(progressEvents).toBe(0);
  });

  test("reports known-size downloads in throttled percentage steps", () => {
    const events: Array<{ percentage?: number; done: boolean }> = [];
    const report = createFfmpegDownloadProgressReporter("ffmpeg.zip", (progress) => {
      events.push({ percentage: progress.percentage, done: progress.done });
    });

    report(0, 100);
    report(1, 100);
    report(5, 100);
    report(9, 100);
    report(10, 100);
    report(100, 100);
    report(100, 100, true);

    expect(events).toEqual([
      { percentage: 0, done: false },
      { percentage: 5, done: false },
      { percentage: 10, done: false },
      { percentage: 100, done: true },
    ]);
    expect(formatFfmpegDownloadProgress({
      archiveName: "ffmpeg.zip",
      receivedBytes: 50 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      percentage: 50,
      done: false,
    })).toBe("FFmpeg downloading: 50% (50.0 MiB / 100.0 MiB)");
  });

  test("reports downloaded bytes when content-length is unavailable", () => {
    const receivedBytes: number[] = [];
    const report = createFfmpegDownloadProgressReporter("ffmpeg.tar.xz", (progress) => {
      receivedBytes.push(progress.receivedBytes);
    });
    const mebibyte = 1024 * 1024;

    report(0);
    report(4 * mebibyte);
    report(5 * mebibyte);
    report(6 * mebibyte, undefined, true);

    expect(receivedBytes).toEqual([0, 5 * mebibyte, 6 * mebibyte]);
    expect(formatFfmpegDownloadProgress({
      archiveName: "ffmpeg.tar.xz",
      receivedBytes: 6 * mebibyte,
      done: true,
    })).toBe("FFmpeg downloading: 6.00 MiB");
  });

  test("parses both single-file and manifest SHA-256 responses", () => {
    const checksum = "a".repeat(64);
    expect(parseExpectedSha256(`${checksum}\n`, "archive.zip", "single")).toBe(checksum);
    expect(parseExpectedSha256(
      `${"b".repeat(64)}  other.zip\n${checksum.toUpperCase()}  archive.zip\n`,
      "archive.zip",
      "manifest",
    )).toBe(checksum);
    expect(() => parseExpectedSha256("invalid", "archive.zip", "single")).toThrow("not found");
  });
});
