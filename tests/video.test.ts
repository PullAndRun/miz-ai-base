import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BILIBILI_QQ_VIDEO_FORMAT,
  canSendNapcatVideoAsDataUrl,
  cleanupStaleVideoArtifacts,
  createFfmpegTranscodeArgs,
  createTranscodedVideoPath,
  createYtDlpCookieFileContents,
  createVideoSourcePathTemplate,
  createYtDlpFfmpegLocationArgs,
  createYtDlpRequestArgs,
  createYtDlpVideoFormatArgs,
  createYtDlpUpdateArgs,
  getNapcatVideoDataUrl,
  getNapcatVideoFile,
  isBilibiliUrl,
  isRetryableYtDlpError,
  isVideoDurationAllowed,
  MAX_NAPCAT_DATA_URL_VIDEO_BYTES,
  MAX_VIDEO_DURATION_SECONDS,
} from "@/video";
import type { VideoConfig } from "@/config";
import {
  createNapcatDataUrlVideoMessage,
  createNapcatVideoMessage,
  deliverVideoWithFallback,
  isVideoDeliveryError,
  isVideoDeliveryUnknownError,
  isVideoSendTimeoutError,
} from "@/video-delivery";

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
  maxConcurrentJobs: 2,
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

  test("matches the Data URL produced by NapCat's video picker", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "miz-video-test-"));
    const videoPath = path.join(directory, "video.mp4");
    try {
      await writeFile(videoPath, Buffer.from([0, 1, 2, 253, 254, 255]));

      expect(await getNapcatVideoDataUrl(videoPath)).toBe(
        "data:video/mp4;base64,AAEC/f7/",
      );
      expect(await createNapcatDataUrlVideoMessage(videoPath)).toEqual({
        type: "video",
        data: {
          file: "data:video/mp4;base64,AAEC/f7/",
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps Data URL payloads below NapCat's WebSocket limit", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "miz-video-test-"));
    const videoPath = path.join(directory, "video.mp4");
    try {
      await writeFile(videoPath, Buffer.from([0, 1, 2]));
      expect(await canSendNapcatVideoAsDataUrl(videoPath)).toBeTrue();

      await truncate(videoPath, MAX_NAPCAT_DATA_URL_VIDEO_BYTES + 1);
      expect(await canSendNapcatVideoAsDataUrl(videoPath)).toBeFalse();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("stale video artifact cleanup", () => {
  test("removes only old miz video files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "miz-video-cleanup-test-"));
    const staleArtifact = path.join(
      directory,
      "miz-video-64c82c6d-1c58-4e2d-8cec-53c48eccb21d.mp4",
    );
    const currentArtifact = path.join(
      directory,
      "miz-video-74c82c6d-1c58-4e2d-9cec-53c48eccb21d-source.mp4.part",
    );
    const unrelatedFile = path.join(directory, "keep.mp4");
    try {
      await Promise.all([
        writeFile(staleArtifact, "stale"),
        writeFile(currentArtifact, "current"),
        writeFile(unrelatedFile, "unrelated"),
      ]);
      const oldTimestamp = new Date(Date.now() - 60_000);
      await utimes(staleArtifact, oldTimestamp, oldTimestamp);

      const removed = await cleanupStaleVideoArtifacts({
        ...videoConfig,
        downloadDirectory: directory,
      }, 30_000);

      expect(removed).toEqual([staleArtifact]);
      expect((await readdir(directory)).sort()).toEqual([
        path.basename(currentArtifact),
        path.basename(unrelatedFile),
      ].sort());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  test("preserves Bilibili's QQ-compatible H.264/AAC streams", () => {
    expect(createYtDlpVideoFormatArgs(true)).toEqual([
      "--format",
      BILIBILI_QQ_VIDEO_FORMAT,
      "--merge-output-format",
      "mp4",
    ]);
    expect(createYtDlpVideoFormatArgs(false)).toEqual([
      "--format",
      "bv*+ba/b",
      "--merge-output-format",
      "mkv",
    ]);
  });

  test("passes the stable FFmpeg resolved from PATH to yt-dlp", () => {
    const stableFfmpeg = process.platform === "win32"
      ? "C:\\stable-ffmpeg\\ffmpeg.exe"
      : "/opt/stable-ffmpeg/ffmpeg";
    expect(createYtDlpFfmpegLocationArgs({
      ...videoConfig,
      ffmpegLinuxPath: "ffmpeg",
      ffmpegWindowsPath: "ffmpeg",
    }, () => stableFfmpeg)).toEqual(["--ffmpeg-location", stableFfmpeg]);
    expect(createYtDlpFfmpegLocationArgs(videoConfig)).toEqual([
      "--ffmpeg-location",
      path.resolve(process.platform === "win32" ? "tools/ffmpeg.exe" : "tools/ffmpeg"),
    ]);
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

describe("video delivery fallback", () => {
  test("uses the NapCat-readable shared file URL first", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "miz-video-test-"));
    const videoPath = path.join(directory, "video.mp4");
    const sentFiles: string[] = [];
    let forwards = 0;
    try {
      await writeFile(videoPath, Buffer.from([0, 1, 2]));
      const result = await deliverVideoWithFallback(
        videoPath,
        videoConfig,
        async (message) => {
          sentFiles.push(message.data.file);
        },
        async () => {
          forwards += 1;
        },
      );

      expect(result).toEqual({ mode: "file", attempts: [] });
      expect(sentFiles).toEqual([`file:///app/media/${path.basename(videoPath)}`]);
      expect(forwards).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("stops fallback after a timeout because the send result is unknown", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "miz-video-test-"));
    const videoPath = path.join(directory, "video.mp4");
    const sentFiles: string[] = [];
    let forwards = 0;
    try {
      await writeFile(videoPath, Buffer.from([0, 1, 2]));
      const delivery = deliverVideoWithFallback(
        videoPath,
        videoConfig,
        async (message) => {
          sentFiles.push(message.data.file);
          if (message.data.file.startsWith("file:")) {
            throw { code: "E_API_TIMEOUT" };
          }
        },
        async () => {
          forwards += 1;
        },
      );

      const error = await delivery.catch((deliveryError: unknown) => deliveryError);
      expect(isVideoDeliveryUnknownError(error)).toBeTrue();
      expect(error).toMatchObject({ mode: "file" });
      expect(sentFiles).toEqual([`file:///app/media/${path.basename(videoPath)}`]);
      expect(forwards).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("falls back to Base64 after a definite shared-file failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "miz-video-test-"));
    const videoPath = path.join(directory, "video.mp4");
    const sentFiles: string[] = [];
    let forwards = 0;
    try {
      await writeFile(videoPath, Buffer.from([0, 1, 2]));
      const result = await deliverVideoWithFallback(
        videoPath,
        videoConfig,
        async (message) => {
          sentFiles.push(message.data.file);
          if (message.data.file.startsWith("file:")) {
            throw new Error("shared file is unavailable");
          }
        },
        async () => {
          forwards += 1;
        },
      );

      expect(result.mode).toBe("data-url");
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]).toMatchObject({ mode: "file" });
      expect(result.attempts[0]?.error).toBeInstanceOf(Error);
      expect(sentFiles).toEqual([
        `file:///app/media/${path.basename(videoPath)}`,
        "data:video/mp4;base64,AAEC",
      ]);
      expect(forwards).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("uses the shared file URL without constructing Base64 for oversized videos", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "miz-video-test-"));
    const videoPath = path.join(directory, "video.mp4");
    const sentFiles: string[] = [];
    try {
      await writeFile(videoPath, Buffer.alloc(0));
      await truncate(videoPath, MAX_NAPCAT_DATA_URL_VIDEO_BYTES + 1);
      const result = await deliverVideoWithFallback(
        videoPath,
        { ...videoConfig, runtimeMode: "docker" },
        async (message) => {
          sentFiles.push(message.data.file);
        },
        async () => undefined,
      );

      expect(result).toEqual({ mode: "file", attempts: [] });
      expect(sentFiles).toEqual([`file:///app/media/${path.basename(videoPath)}`]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("uses a file-backed forward after ordinary file and Base64 delivery fail", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "miz-video-test-"));
    const videoPath = path.join(directory, "video.mp4");
    const sentFiles: string[] = [];
    const forwardedFiles: string[] = [];
    try {
      await writeFile(videoPath, Buffer.from([0, 1, 2]));
      const result = await deliverVideoWithFallback(
        videoPath,
        videoConfig,
        async (message) => {
          sentFiles.push(message.data.file);
          throw new Error("ordinary send failed");
        },
        async (message) => {
          forwardedFiles.push(message.data.file);
        },
      );

      expect(result.mode).toBe("forward");
      expect(result.attempts.map((attempt) => attempt.mode)).toEqual(["file", "data-url"]);
      expect(sentFiles).toEqual([
        `file:///app/media/${path.basename(videoPath)}`,
        "data:video/mp4;base64,AAEC",
      ]);
      expect(forwardedFiles).toEqual([`file:///app/media/${path.basename(videoPath)}`]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports all three delivery errors after every transport fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "miz-video-test-"));
    const videoPath = path.join(directory, "video.mp4");
    try {
      await writeFile(videoPath, Buffer.from([0, 1, 2]));
      const delivery = deliverVideoWithFallback(
        videoPath,
        { ...videoConfig, runtimeMode: "docker" },
        async () => {
          throw new Error("ordinary send failed");
        },
        async () => {
          throw new Error("forward send failed");
        },
      );

      const error = await delivery.catch((deliveryError: unknown) => deliveryError);
      expect(isVideoDeliveryError(error)).toBeTrue();
      expect((error as AggregateError).errors).toHaveLength(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

});
