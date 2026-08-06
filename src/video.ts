import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BilibiliConfig, NetworkConfig, VideoConfig } from "@/config";
import { isWhitelistedUser } from "@/group-permissions";

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const TRANSCODE_TIMEOUT_MS = 15 * 60_000;
const PROCESS_FORCE_KILL_DELAY_MS = 5_000;
const MAX_CAPTURED_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const YT_DLP_DOWNLOAD_RETRY_COUNT = 20;
const YT_DLP_OUTER_RETRY_COUNT = 1;
const YT_DLP_OUTER_RETRY_DELAY_MS = 2_000;
export const STALE_VIDEO_ARTIFACT_MAX_AGE_MS = 24 * 60 * 60_000;
const VIDEO_ARTIFACT_NAME_PATTERN = /^miz-video-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:-source)?\./i;
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
  network,
  bilibili,
}: {
  url: string;
  config: VideoConfig;
  network: NetworkConfig;
  bilibili: BilibiliConfig;
}) => {
  const downloadDirectory = getDownloadDirectory(config);
  await mkdir(downloadDirectory, { recursive: true });
  const downloadStartedAt = Date.now();
  const requestId = crypto.randomUUID();
  const transcodedVideoPath = createTranscodedVideoPath(downloadDirectory, requestId);
  const args = [
    "--no-playlist",
    "--no-progress",
    "--no-warnings",
    "--retries",
    String(YT_DLP_DOWNLOAD_RETRY_COUNT),
    "--fragment-retries",
    String(YT_DLP_DOWNLOAD_RETRY_COUNT),
    "--retry-sleep",
    "http:exp=1:20",
    "--retry-sleep",
    "fragment:exp=1:20",
    "--output",
    createVideoSourcePathTemplate(downloadDirectory, requestId),
    ...createYtDlpVideoFormatArgs(),
    ...createYtDlpFfmpegLocationArgs(config),
    "--print",
    "after_move:filepath",
  ];
  try {
    const output = await withYtDlpRequest(url, config, network, bilibili, (requestArgs) =>
      runYtDlpWithTransientRetry(config, [...args, ...requestArgs]));
    const sourceVideoPath = await findDownloadedVideo(output, downloadDirectory, downloadStartedAt, requestId);
    if (!sourceVideoPath) {
      throw new Error("yt-dlp returned a missing video file");
    }

    await runFfmpeg(config, createFfmpegTranscodeArgs(sourceVideoPath, transcodedVideoPath));
    await assertUsableVideoFile(transcodedVideoPath, "ffmpeg returned a missing or empty video file");

    await rm(sourceVideoPath, { force: true });
    return transcodedVideoPath;
  } catch (error) {
    await deleteDownloadArtifacts(downloadDirectory, requestId);
    throw error;
  }
};

export const getVideoDuration = async (
  url: string,
  config: VideoConfig,
  network: NetworkConfig,
  bilibili: BilibiliConfig,
) => {
  const output = await withYtDlpRequest(url, config, network, bilibili, (requestArgs) =>
    runYtDlpWithTransientRetry(config, [
      "--no-playlist",
      "--skip-download",
      "--print",
      "%(duration)s",
      ...requestArgs,
    ]));
  const value = Number(output.trim().split(/\r?\n/).filter(Boolean).at(-1));
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

export const getNapcatVideoFile = (videoPath: string, config: VideoConfig) => {
  const napcatPath = path.posix.join(config.napcatMediaDirectory, path.basename(videoPath));
  const fileUrl = new URL("file:///");
  fileUrl.pathname = napcatPath;
  return fileUrl.href;
};

export const getNapcatVideoBase64 = async (videoPath: string) =>
  `base64://${(await readFile(videoPath)).toString("base64")}`;

export const deleteDownloadedVideo = (videoPath: string) => rm(videoPath, { force: true });

export const cleanupStaleVideoArtifacts = async (
  config: VideoConfig,
  maxAgeMs = STALE_VIDEO_ARTIFACT_MAX_AGE_MS,
) => {
  const downloadDirectory = getDownloadDirectory(config);
  const cutoff = Date.now() - maxAgeMs;
  const entries = await readdir(downloadDirectory, { withFileTypes: true }).catch(() => []);
  const removed = (await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !VIDEO_ARTIFACT_NAME_PATTERN.test(entry.name)) {
      return undefined;
    }
    const artifactPath = path.join(downloadDirectory, entry.name);
    const artifact = await stat(artifactPath).catch(() => undefined);
    if (!artifact || artifact.mtimeMs > cutoff) {
      return undefined;
    }
    await rm(artifactPath, { force: true });
    return artifactPath;
  }))).filter((artifactPath): artifactPath is string => artifactPath !== undefined);
  return removed;
};

export const createYtDlpUpdateArgs = (network: NetworkConfig) => [
  "-U",
  ...(network.proxyUrl ? ["--proxy", network.proxyUrl] : []),
];

export const createVideoSourcePathTemplate = (downloadDirectory: string, requestId: string) =>
  path.join(downloadDirectory, `miz-video-${requestId}-source.%(ext)s`);

export const createTranscodedVideoPath = (downloadDirectory: string, requestId: string) =>
  path.join(downloadDirectory, `miz-video-${requestId}.mp4`);

export const createYtDlpVideoFormatArgs = () => [
  "--format",
  "bv*+ba/b",
  "--merge-output-format",
  "mkv",
];

export const createYtDlpFfmpegLocationArgs = (
  config: VideoConfig,
  findExecutable: (name: string) => string | null = Bun.which,
) => ["--ffmpeg-location", resolveFfmpegExecutable(config, findExecutable)];

export const createFfmpegTranscodeArgs = (sourceVideoPath: string, outputVideoPath: string) => [
  "-nostdin",
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-i",
  sourceVideoPath,
  "-map",
  "0:v:0",
  "-map",
  "0:a:0?",
  "-sn",
  "-dn",
  "-vf",
  "scale=trunc(iw/2)*2:trunc(ih/2)*2",
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
  "-ar",
  "48000",
  "-movflags",
  "+faststart",
  outputVideoPath,
];

export const updateYtDlp = async (config: VideoConfig, network: NetworkConfig) => {
  await runYtDlp(config, createYtDlpUpdateArgs(network));
};

export const createYtDlpRequestArgs = (
  url: string,
  network: NetworkConfig,
  cookieFilePath?: string,
) => [
  ...(network.proxyUrl ? ["--proxy", network.proxyUrl] : []),
  ...(cookieFilePath ? ["--cookies", cookieFilePath] : []),
  url,
];

export const createYtDlpCookieFileContents = (
  url: string,
  config: VideoConfig,
  bilibili: BilibiliConfig,
) => {
  if (!isBilibiliUrl(url, config.bilibiliHosts) || !bilibili.cookie) {
    return undefined;
  }

  const cookies = bilibili.cookie
    .split(";")
    .map((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) {
        return undefined;
      }

      const name = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) && !/[\t\r\n]/.test(value)
        ? { name, value }
        : undefined;
    })
    .filter((cookie): cookie is { name: string; value: string } => cookie !== undefined);
  if (cookies.length === 0) {
    return undefined;
  }

  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();
  const domain = hostname === "b23.tv" || hostname === "bilibili.com" || hostname.endsWith(".bilibili.com")
    ? ".bilibili.com"
    : hostname;
  const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
  const secure = parsedUrl.protocol === "https:" ? "TRUE" : "FALSE";
  const lines = cookies.map(({ name, value }) =>
    [domain, includeSubdomains, "/", secure, "0", name, value].join("\t"));
  return [
    "# Netscape HTTP Cookie File",
    "# Generated temporarily by miz for yt-dlp.",
    ...lines,
    "",
  ].join("\n");
};

export const isRetryableYtDlpError = (error: unknown) =>
  error instanceof Error &&
  /unexpected_eof_while_reading|eof occurred in violation of protocol|connection (?:reset|refused)|remote end closed connection|timed? out|temporary failure in name resolution|network is unreachable|http error 5\d\d/i.test(error.message);

const withYtDlpRequest = async <T>(
  url: string,
  config: VideoConfig,
  network: NetworkConfig,
  bilibili: BilibiliConfig,
  callback: (requestArgs: string[]) => Promise<T>,
) => {
  const cookieContents = createYtDlpCookieFileContents(url, config, bilibili);
  if (!cookieContents) {
    return callback(createYtDlpRequestArgs(url, network));
  }

  const cookieDirectory = path.join(tmpdir(), "miz");
  await mkdir(cookieDirectory, { recursive: true });
  const cookieFilePath = path.join(cookieDirectory, `.miz-yt-dlp-${crypto.randomUUID()}.cookies`);
  await writeFile(cookieFilePath, cookieContents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    return await callback(createYtDlpRequestArgs(url, network, cookieFilePath));
  } finally {
    await rm(cookieFilePath, { force: true });
  }
};

const runYtDlpWithTransientRetry = async (config: VideoConfig, args: string[]) => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= YT_DLP_OUTER_RETRY_COUNT; attempt += 1) {
    try {
      return await runYtDlp(config, args);
    } catch (error) {
      lastError = error;
      if (attempt === YT_DLP_OUTER_RETRY_COUNT || !isRetryableYtDlpError(error)) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, YT_DLP_OUTER_RETRY_DELAY_MS * 2 ** attempt));
    }
  }

  throw lastError;
};

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
          settle(() => reject(new Error(`${processName} timed out`)));
        }
      }, PROCESS_FORCE_KILL_DELAY_MS);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => appendCapturedOutput(stdout, chunk));
    // Consume stderr so verbose extractor errors cannot block the child process.
    child.stderr.on("data", (chunk: Buffer) => appendCapturedOutput(stderr, chunk));
    child.once("error", (error) => {
      settle(() => reject(new Error(`Unable to start ${processName}: ${error.message}`, { cause: error })));
    });
    child.once("close", (code) => {
      if (code === 0 && !timedOut) {
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

  return resolveExecutable(executable);
};

const getFfmpegPath = (config: VideoConfig) => resolveFfmpegExecutable(config);

const getConfiguredFfmpegExecutable = (config: VideoConfig) =>
  process.platform === "win32" ? config.ffmpegWindowsPath : config.ffmpegLinuxPath;

const resolveFfmpegExecutable = (
  config: VideoConfig,
  findExecutable: (name: string) => string | null = Bun.which,
) => {
  const executable = getConfiguredFfmpegExecutable(config);
  if (!executable) {
    throw new Error("ffmpeg path is not configured for this operating system");
  }
  return resolveExecutable(executable, findExecutable);
};

const resolveExecutable = (
  executable: string,
  findExecutable: (name: string) => string | null = Bun.which,
) => /[\\/]/.test(executable) || path.isAbsolute(executable)
  ? path.resolve(executable)
  : findExecutable(executable) ?? executable;

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
      isFinalDownloadedPath(videoPath) &&
      path.basename(videoPath).startsWith(`miz-video-${requestId}-source.`) &&
      isPathInsideDirectory(videoPath, downloadDirectory)
    ) {
      return videoPath;
    }
  }

  const candidates = await Promise.all(
    (await readdir(downloadDirectory, { withFileTypes: true }))
      .filter((entry) =>
        entry.isFile() &&
        entry.name.startsWith(`miz-video-${requestId}-source.`) &&
        isFinalDownloadedPath(entry.name))
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

const assertUsableVideoFile = async (videoPath: string, message: string) => {
  const videoFile = await stat(videoPath).catch(() => undefined);
  if (!videoFile?.isFile() || videoFile.size === 0) {
    throw new Error(message);
  }
};

const isFinalDownloadedPath = (value: string) =>
  !/\.(?:part|ytdl|temp)$/i.test(value) && !/\.f\d+\.[^.]+$/i.test(value);

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
