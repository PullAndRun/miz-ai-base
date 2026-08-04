import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  createFfmpegTranscodeArgs,
  createTranscodedVideoPath,
  createYtDlpCookieFileContents,
  createVideoSourcePathTemplate,
  createYtDlpRequestArgs,
  createYtDlpUpdateArgs,
  getNapcatVideoFile,
  isBilibiliUrl,
  isRetryableYtDlpError,
  isVideoDurationAllowed,
  MAX_VIDEO_DURATION_SECONDS,
} from "@/video";
import type { VideoConfig } from "@/config";
import {
  createNapcatVideoMessage,
  isVideoSendTimeoutError,
} from "../plugins/video";

const videoConfig: VideoConfig = {
  enabled: true,
  runtimeMode: "normal",
  whitelistUserIds: [],
  bilibiliHosts: ["bilibili.com", "b23.tv"],
  downloadDirectory: "/temp",
  napcatMediaDirectory: "/app/media",
  ytDlpLinuxPath: "tools/yt-dlp",
  ytDlpWindowsPath: "tools/yt-dlp.exe",
  ffmpegLinuxPath: "tools/ffmpeg",
  ffmpegWindowsPath: "tools/ffmpeg.exe",
  updateCron: "0 0 * * *",
};
const networkConfig = { proxyUrl: "" };
const bilibiliConfig = { cookie: "SESSDATA=test-cookie" };

describe("video duration limit", () => {
  test("allows exactly ten minutes and rejects anything longer", () => {
    expect(isVideoDurationAllowed(MAX_VIDEO_DURATION_SECONDS)).toBeTrue();
    expect(isVideoDurationAllowed(MAX_VIDEO_DURATION_SECONDS + 0.01)).toBeFalse();
  });
});

describe("video download filenames", () => {
  test("keeps the NapCat-visible temporary filename ASCII-only", () => {
    const sourceTemplate = createVideoSourcePathTemplate(
      "/temp",
      "64c82c6d-1c58-4e2d-bcec-53c48eccb21d",
    );
    const outputPath = createTranscodedVideoPath(
      "/temp",
      "64c82c6d-1c58-4e2d-bcec-53c48eccb21d",
    );

    expect(path.basename(sourceTemplate)).toBe(
      "miz-video-64c82c6d-1c58-4e2d-bcec-53c48eccb21d-source.%(ext)s",
    );
    expect(path.basename(outputPath)).toBe(
      "miz-video-64c82c6d-1c58-4e2d-bcec-53c48eccb21d.mp4",
    );
    expect(/^[\x20-\x7E]+$/.test(path.basename(sourceTemplate))).toBeTrue();
    expect(/^[\x20-\x7E]+$/.test(path.basename(outputPath))).toBeTrue();
  });

  test("gives NapCat a shared file URL without base64", () => {
    const videoPath = "C:\\miz\\temp\\miz-video-id.mp4";

    expect(getNapcatVideoFile(videoPath, videoConfig)).toBe(
      "file:///app/media/miz-video-id.mp4",
    );
    expect(createNapcatVideoMessage(videoPath, videoConfig)).toEqual({
      type: "video",
      data: {
        file: "file:///app/media/miz-video-id.mp4",
      },
    });
  });
});

describe("ffmpeg video transcoding", () => {
  test("produces an H.264/AAC MP4 that QQ can recognize as video", () => {
    const args = createFfmpegTranscodeArgs("source.mkv", "output.mp4");

    expect(args).toContain("libx264");
    expect(args).toContain("yuv420p");
    expect(args).toContain("aac");
    expect(args).toContain("+faststart");
    expect(args.at(-1)).toBe("output.mp4");
  });
});

describe("video host configuration", () => {
  test("does not recognize hosts that are not configured", () => {
    expect(isBilibiliUrl("https://www.bilibili.com/video/BV1", [])).toBeFalse();
    expect(isBilibiliUrl("https://b23.tv/abc123", [])).toBeFalse();
  });

  test("matches configured hosts and their subdomains", () => {
    const hosts = ["video.example.test", "short.example.test"];
    expect(isBilibiliUrl("https://www.video.example.test/video/1", hosts)).toBeTrue();
    expect(isBilibiliUrl("https://short.example.test/abc", hosts)).toBeTrue();
    expect(isBilibiliUrl("https://notvideo.example.test/video/1", hosts)).toBeFalse();
  });
});

describe("Bilibili download authentication", () => {
  test.each([
    "https://www.bilibili.com/video/BV1",
    "https://b23.tv/abc123",
  ])("passes the app.toml cookie to yt-dlp for %s", (url) => {
    expect(createYtDlpRequestArgs(url, networkConfig, "/temp/miz.cookies")).toEqual([
      "--cookies",
      "/temp/miz.cookies",
      url,
    ]);
  });

  test("converts the configured header into a scoped Netscape cookie file", () => {
    const contents = createYtDlpCookieFileContents("https://b23.tv/abc123", {
      ...videoConfig,
    }, { cookie: "SESSDATA=test-cookie; bili_jct=csrf=value" });

    expect(contents).toContain(".bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\ttest-cookie");
    expect(contents).toContain(".bilibili.com\tTRUE\t/\tTRUE\t0\tbili_jct\tcsrf=value");
    expect(contents).not.toContain("Cookie:");
  });

  test("does not send the Bilibili cookie to unrelated hosts", () => {
    const url = "https://example.com/video.mp4";
    expect(createYtDlpRequestArgs(url, networkConfig)).toEqual([url]);
    expect(createYtDlpCookieFileContents(url, videoConfig, bilibiliConfig)).toBeUndefined();
  });

  test("uses the proxy from miz.network for video requests", () => {
    expect(createYtDlpRequestArgs(
      "https://example.com/video.mp4",
      { proxyUrl: "http://proxy.example.test:7890" },
    )).toEqual([
      "--proxy",
      "http://proxy.example.test:7890",
      "https://example.com/video.mp4",
    ]);
  });
});

describe("yt-dlp transient failures", () => {
  test("retries TLS EOF failures reported by the downloader", () => {
    expect(isRetryableYtDlpError(new Error(
      "yt-dlp failed: [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol",
    ))).toBeTrue();
  });

  test("does not retry permanent extractor failures", () => {
    expect(isRetryableYtDlpError(new Error("yt-dlp failed: HTTP Error 403: Forbidden"))).toBeFalse();
  });
});

describe("yt-dlp updates", () => {
  test("uses the proxy configured in miz.network", () => {
    expect(createYtDlpUpdateArgs({ proxyUrl: "http://proxy.example.test:7890" })).toEqual([
      "-U",
      "--proxy",
      "http://proxy.example.test:7890",
    ]);
  });

  test("does not pass a proxy option when miz.network has no proxy", () => {
    expect(createYtDlpUpdateArgs({ proxyUrl: "" })).toEqual(["-U"]);
  });
});

describe("video delivery timeout", () => {
  test("treats an API timeout as an unknown send result", () => {
    expect(isVideoSendTimeoutError({ code: "E_API_TIMEOUT" })).toBeTrue();
    expect(isVideoSendTimeoutError(new Error("download failed"))).toBeFalse();
  });
});
