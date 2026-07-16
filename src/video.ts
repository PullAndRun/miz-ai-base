import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { VideoConfig } from "@/config";
import { isWhitelistedUser } from "@/group-permissions";

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const TRANSCODE_TIMEOUT_MS = 30 * 60_000;
const PROCESS_FORCE_KILL_DELAY_MS = 5_000;
const MAX_CAPTURED_PROCESS_OUTPUT_BYTES = 1024 * 1024;
export const MAX_VIDEO_DURATION_SECONDS = 10 * 60;

export const isVideoDurationAllowed = (durationSeconds: number) =>
  Number.isFinite(durationSeconds) && durationSeconds > 0 && durationSeconds <= MAX_VIDEO_DURATION_SECONDS;

export const isBilibiliUrl = (value: string, allowedHosts: readonly string[]) => {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return allowedHosts.some((allowedHost) => {
      const normalizedHost = allowedHost.trim().toLowerCase().replace(/^\.+/, "");
      return normalizedHost !== "" &&
        (hostname === normalizedHost || hostname.endsWith(`.${normalizedHost}`));
    });
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
) => isWhitelistedUser(userId, whitelistUserIds);

export const downloadVideo = async ({
  url,
  config,
}: {
  url: string;
  config: VideoConfig;
}) => {
  const downloadDirectory = getDownloadDirectory(config);
  await mkdir(downloadDirectory, { recursive: true });
  const downloadStartedAt = Date.now();
  const requestId = crypto.randomUUID();

  const args = [
    "--no-playlist",
    "--no-progress",
    "--no-warnings",
    "--output",
    path.join(downloadDirectory, `%(title).180B [%(id)s] ${requestId}.%(ext)s`),
    "--format",
    "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--merge-output-format",
    "mp4",
    "--ffmpeg-location",
    getFfmpegPath(config),
    "--print",
    "after_move:filepath",
    ...createRequestArgs(url, config),
  ];
  try {
    const output = await runYtDlp(config, args);
    const videoPath = await findDownloadedVideo(output, downloadDirectory, downloadStartedAt, requestId);
    if (!videoPath) {
      throw new Error("yt-dlp returned a missing video file");
    }

    return videoPath;
  } catch (error) {
    await deleteDownloadArtifacts(downloadDirectory, requestId);
    throw error;
  }
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

export const getNapcatVideoFile = async (videoPath: string, config: VideoConfig) => {
  if (config.runtimeMode !== "docker") {
    // In normal mode NapLink transfers bytes to NapCat directly.
    return `base64://${(await readFile(path.resolve(videoPath))).toString("base64")}`;
  }

  // Docker deployments map the project temp directory to NapCat's /app/media.
  // Only send the in-container file address: NapCat reads the bytes itself.
  const napcatPath = path.posix.join(config.napcatMediaDirectory, path.basename(videoPath));
  return pathToFileURL(napcatPath).href;
};

// QQ's video player is not consistently compatible with the HEVC and AV1 streams
// commonly returned by Bilibili. Re-encode to its broadly supported MP4 profile
// and move the MP4 index to the front so playback can start immediately.
export const prepareVideoForQq = async (videoPath: string, config: VideoConfig) => {
  const parsedPath = path.parse(videoPath);
  const outputPath = path.join(parsedPath.dir, `${parsedPath.name}.qq.mp4`);
  try {
    await runFfmpeg(config, [
      "-y",
      "-i",
      videoPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
    return outputPath;
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
};

export const deleteDownloadedVideo = (videoPath: string) => rm(videoPath, { force: true });

export const updateYtDlp = async (config: VideoConfig) => {
  await runYtDlp(config, ["-U", ...(config.proxyUrl ? ["--proxy", config.proxyUrl] : [])]);
};

const createRequestArgs = (url: string, config: VideoConfig) => [
  ...(config.proxyUrl ? ["--proxy", config.proxyUrl] : []),
  ...(isBilibiliUrl(url, config.bilibiliHosts) && config.bilibiliCookie
    ? ["--add-header", `Cookie:${config.bilibiliCookie}`]
    : []),
  url,
];

const runYtDlp = (config: VideoConfig, args: string[]) =>
  runProcess(getYtDlpPath(config), args, "yt-dlp", DOWNLOAD_TIMEOUT_MS);

const runFfmpeg = (config: VideoConfig, args: string[]) =>
  runProcess(getFfmpegPath(config), args, "ffmpeg", TRANSCODE_TIMEOUT_MS);

const runProcess = (
  executable: string,
  args: string[],
  processName: string,
  timeoutMs: number,
) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createCapturedOutput();
    const stderr = createCapturedOutput();
    let timedOut = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      callback();
    };
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      forceKillTimeout = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, PROCESS_FORCE_KILL_DELAY_MS);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => appendCapturedOutput(stdout, chunk));
    // Consume stderr so verbose extractor errors cannot block the child process.
    child.stderr.on("data", (chunk: Buffer) => appendCapturedOutput(stderr, chunk));
    child.once("error", () => {
      settle(() => reject(new Error(`Unable to start ${processName}`)));
    });
    child.once("close", (code) => {
      if (code === 0) {
        settle(() => resolve(Buffer.concat(stdout.chunks).toString("utf8")));
        return;
      }

      settle(() =>
        reject(
          new Error(
            timedOut
              ? `${processName} timed out`
              : `${processName} failed: ${formatProcessError(Buffer.concat(stderr.chunks).toString("utf8"))}`,
          ),
        ),
      );
    });
  });

type CapturedOutput = { chunks: Buffer[]; size: number };

const createCapturedOutput = (): CapturedOutput => ({ chunks: [], size: 0 });

const appendCapturedOutput = (output: CapturedOutput, chunk: Buffer) => {
  output.chunks.push(chunk);
  output.size += chunk.length;
  while (output.size > MAX_CAPTURED_PROCESS_OUTPUT_BYTES && output.chunks.length > 0) {
    const excess = output.size - MAX_CAPTURED_PROCESS_OUTPUT_BYTES;
    if (output.chunks[0].length <= excess) {
      output.size -= output.chunks.shift()!.length;
      continue;
    }
    output.chunks[0] = output.chunks[0].subarray(excess);
    output.size -= excess;
  }
};

const getYtDlpPath = (config: VideoConfig) => {
  const executable = process.platform === "win32" ? config.ytDlpWindowsPath : config.ytDlpLinuxPath;
  if (!executable) {
    throw new Error("yt-dlp path is not configured for this operating system");
  }

  return executable;
};

const getFfmpegPath = (config: VideoConfig) => {
  const executable = process.platform === "win32" ? config.ffmpegWindowsPath : config.ffmpegLinuxPath;
  if (!executable) {
    throw new Error("ffmpeg path is not configured for this operating system");
  }

  return path.resolve(executable);
};

const getDownloadDirectory = (config: VideoConfig) =>
  config.runtimeMode === "docker"
    ? path.join(process.cwd(), "temp")
    : process.platform === "win32" && config.downloadDirectory === "/temp"
    ? path.join(process.cwd(), "temp")
    : config.downloadDirectory;

const findDownloadedVideo = async (
  output: string,
  downloadDirectory: string,
  downloadStartedAt: number,
  requestId: string,
) => {
  const outputCandidates = output
    .split(/\r?\n/)
    .map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
    .reverse();

  for (const candidate of outputCandidates) {
    const videoPath = path.resolve(candidate);
    const file = await stat(videoPath).catch(() => undefined);
    if (
      file?.isFile() &&
      isFinalVideoPath(videoPath) &&
      path.basename(videoPath).includes(requestId) &&
      isPathInsideDirectory(videoPath, downloadDirectory)
    ) {
      return videoPath;
    }
  }

  const candidates = await Promise.all(
    (await readdir(downloadDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.includes(requestId) && isFinalVideoPath(entry.name))
      .map(async (entry) => {
        const videoPath = path.join(downloadDirectory, entry.name);
        return {
          videoPath,
          modifiedAt: (await stat(videoPath)).mtimeMs,
        };
      }),
  );

  return candidates
    .filter((candidate) => candidate.modifiedAt >= downloadStartedAt - 2_000)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.videoPath;
};

const deleteDownloadArtifacts = async (downloadDirectory: string, requestId: string) => {
  const entries = await readdir(downloadDirectory, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.includes(requestId))
      .map((entry) => rm(path.join(downloadDirectory, entry.name), { force: true }).catch(() => undefined)),
  );
};

const isFinalVideoPath = (value: string) =>
  value.toLowerCase().endsWith(".mp4") && !/\.f\d+\.mp4$/i.test(value);

const isPathInsideDirectory = (filePath: string, directory: string) => {
  const relativePath = path.relative(path.resolve(directory), path.resolve(filePath));
  return relativePath !== "" && !relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath);
};

const formatProcessError = (stderr: string) => {
  const detail = stderr
    .replace(/(Cookie:\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-1_000);
  return detail || "unknown download error";
};
