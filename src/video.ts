import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { VideoConfig } from "@/config";

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
export const MAX_VIDEO_DURATION_SECONDS = 10 * 60;

export const isBilibiliUrl = (value: string) => {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "bilibili.com" ||
      hostname.endsWith(".bilibili.com") ||
      hostname === "b23.tv" ||
      hostname.endsWith(".b23.tv");
  } catch {
    return false;
  }
};

export const isVideoUrl = (value: string) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

export const isWhitelistedVideoUser = (
  userId: number | string | undefined,
  whitelistUserIds: readonly (number | string)[],
) => userId !== undefined && whitelistUserIds.some((id) => String(id) === String(userId));

export const downloadVideo = async ({
  url,
  config,
}: {
  url: string;
  config: VideoConfig;
}) => {
  await mkdir(config.downloadDirectory, { recursive: true });

  const args = [
    "--no-playlist",
    "--no-progress",
    "--no-warnings",
    "--paths",
    config.downloadDirectory,
    "--output",
    "%(title).180B [%(id)s].%(ext)s",
    "--format",
    "best[ext=mp4]/best",
    "--merge-output-format",
    "mp4",
    "--print",
    "after_move:filepath",
    ...createRequestArgs(url, config),
  ];
  const output = await runYtDlp(config, args);
  const downloadedPath = output.trim().split(/\r?\n/).filter(Boolean).at(-1);

  if (!downloadedPath) {
    throw new Error("yt-dlp did not return a downloaded video path");
  }

  const videoPath = path.resolve(downloadedPath);
  const file = await stat(videoPath).catch(() => undefined);
  if (!file?.isFile()) {
    throw new Error("yt-dlp returned a missing video file");
  }

  return videoPath;
};

export const getVideoDuration = async (url: string, config: VideoConfig) => {
  const output = await runYtDlp(config, [
    "--no-playlist",
    "--skip-download",
    "--print",
    "%(duration)s",
    ...createRequestArgs(url, config),
  ]);
  const value = Number(output.trim().split(/\r?\n/).filter(Boolean).at(-1));
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

export const getNapcatVideoFileUrl = (videoPath: string, config: VideoConfig) => {
  const napcatPath = path.posix.join(config.napcatMediaDirectory, path.basename(videoPath));
  return pathToFileURL(napcatPath).href;
};

export const deleteDownloadedVideo = (videoPath: string) => rm(videoPath, { force: true });

export const updateYtDlp = async (config: VideoConfig) => {
  await runYtDlp(config, ["-U", ...(config.proxyUrl ? ["--proxy", config.proxyUrl] : [])]);
};

const createRequestArgs = (url: string, config: VideoConfig) => [
  ...(config.proxyUrl ? ["--proxy", config.proxyUrl] : []),
  ...(isBilibiliUrl(url) && config.bilibiliCookie
    ? ["--add-header", `Cookie:${config.bilibiliCookie}`]
    : []),
  url,
];

const runYtDlp = (config: VideoConfig, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(getYtDlpPath(config), args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, DOWNLOAD_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("Unable to start yt-dlp"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }

      reject(new Error(timedOut ? "yt-dlp timed out" : "yt-dlp failed"));
    });
  });

const getYtDlpPath = (config: VideoConfig) => {
  const executable = process.platform === "win32" ? config.ytDlpWindowsPath : config.ytDlpLinuxPath;
  if (!executable) {
    throw new Error("yt-dlp path is not configured for this operating system");
  }

  return executable;
};
