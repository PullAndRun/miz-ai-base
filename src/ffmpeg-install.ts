import { chmod, copyFile, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { NetworkConfig, VideoConfig } from "@/config";

export const SUPPORTED_FFMPEG_RELEASE = "8.1";
const GYAN_BASE_URL = "https://www.gyan.dev/ffmpeg/builds/packages";
const BTBN_BASE_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";
const MAX_FFMPEG_ARCHIVE_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_PROGRESS_PERCENT_STEP = 5;
const DOWNLOAD_PROGRESS_BYTES_STEP = 5 * 1024 * 1024;

export type FfmpegAsset = Readonly<{
  archiveName: string;
  archiveUrl: string;
  checksumUrl: string;
  checksumMode: "single" | "manifest";
  executableName: "ffmpeg" | "ffmpeg.exe";
  probeName: "ffprobe" | "ffprobe.exe";
}>;

export type FfmpegInstallResult = Readonly<{
  status: "current" | "installed" | "disabled";
  path: string;
  version?: string;
}>;

export type FfmpegDownloadProgress = Readonly<{
  archiveName: string;
  receivedBytes: number;
  totalBytes?: number;
  percentage?: number;
  done: boolean;
}>;

export const getFfmpegAsset = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): FfmpegAsset => {
  if (platform === "win32" && arch === "x64") {
    const archiveName = "ffmpeg-8.1.2-essentials_build.zip";
    return {
      archiveName,
      archiveUrl: `${GYAN_BASE_URL}/${archiveName}`,
      checksumUrl: `${GYAN_BASE_URL}/${archiveName}.sha256`,
      checksumMode: "single",
      executableName: "ffmpeg.exe",
      probeName: "ffprobe.exe",
    };
  }

  const platformName = platform === "win32" ? "win" : platform === "linux" ? "linux" : undefined;
  const archName = arch === "x64" ? "64" : arch === "arm64" ? "arm64" : undefined;
  if (!platformName || !archName) {
    throw new Error(`Automatic FFmpeg installation is not supported on ${platform}-${arch}`);
  }

  const extension = platform === "win32" ? "zip" : "tar.xz";
  const archiveName = `ffmpeg-n8.1-latest-${platformName}${archName}-gpl-8.1.${extension}`;
  return {
    archiveName,
    archiveUrl: `${BTBN_BASE_URL}/${archiveName}`,
    checksumUrl: `${BTBN_BASE_URL}/checksums.sha256`,
    checksumMode: "manifest",
    executableName: platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    probeName: platform === "win32" ? "ffprobe.exe" : "ffprobe",
  };
};

export const parseFfmpegVersion = (output: string) =>
  /^ffmpeg version (?:n)?(\d+\.\d+(?:\.\d+)?)/im.exec(output)?.[1];

export const isSupportedFfmpegVersion = (output: string) => {
  const version = parseFfmpegVersion(output);
  return version === SUPPORTED_FFMPEG_RELEASE || version?.startsWith(`${SUPPORTED_FFMPEG_RELEASE}.`) === true;
};

export const parseExpectedSha256 = (
  contents: string,
  archiveName: string,
  mode: FfmpegAsset["checksumMode"],
) => {
  if (mode === "single") {
    const checksum = contents.trim().split(/\s+/)[0]?.toLowerCase();
    if (checksum && /^[a-f0-9]{64}$/.test(checksum)) {
      return checksum;
    }
  } else {
    for (const line of contents.split(/\r?\n/)) {
      const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
      if (match?.[2] === archiveName) {
        return match[1].toLowerCase();
      }
    }
  }
  throw new Error(`SHA-256 checksum not found for ${archiveName}`);
};

export const ensureFfmpeg = async (
  config: VideoConfig,
  network: NetworkConfig,
  options: Readonly<{
    force?: boolean;
    readCurrentVersion?: (executablePath: string) => Promise<string>;
    onDownloadProgress?: (progress: FfmpegDownloadProgress) => void;
  }> = {},
): Promise<FfmpegInstallResult> => {
  const configuredPath = getConfiguredFfmpegPath(config);
  const currentPath = resolveCurrentExecutable(configuredPath);
  if (!config.ffmpegAutoDownload && !options.force) {
    return { status: "disabled", path: currentPath ?? configuredPath };
  }

  if (!options.force && currentPath) {
    const versionOutput = await (options.readCurrentVersion ?? readFfmpegVersion)(currentPath).catch(() => "");
    if (isSupportedFfmpegVersion(versionOutput)) {
      return { status: "current", path: currentPath, version: parseFfmpegVersion(versionOutput) };
    }
  }

  const asset = getFfmpegAsset();
  const targetPath = resolveInstallTarget(configuredPath, asset.executableName);
  const targetDirectory = path.dirname(targetPath);
  await mkdir(targetDirectory, { recursive: true });
  const installDirectory = await mkdtemp(path.join(targetDirectory, ".ffmpeg-install-"));
  let stagedFfmpeg: string | undefined;
  try {
    const archivePath = path.join(installDirectory, asset.archiveName);
    const extractDirectory = path.join(installDirectory, "extract");
    await mkdir(extractDirectory, { recursive: true });

    const checksumContents = await fetchText(asset.checksumUrl, network.proxyUrl);
    const expectedChecksum = parseExpectedSha256(checksumContents, asset.archiveName, asset.checksumMode);
    await downloadFile(
      asset.archiveUrl,
      archivePath,
      network.proxyUrl,
      asset.archiveName,
      options.onDownloadProgress,
    );
    const actualChecksum = await calculateFileSha256(archivePath);
    if (actualChecksum !== expectedChecksum) {
      throw new Error(`FFmpeg archive checksum mismatch: expected ${expectedChecksum}, received ${actualChecksum}`);
    }

    await extractArchive(archivePath, extractDirectory);
    const sourceFfmpeg = await findExtractedExecutable(extractDirectory, asset.executableName);
    stagedFfmpeg = createStagedPath(targetPath);
    await copyFile(sourceFfmpeg, stagedFfmpeg);
    if (process.platform !== "win32") {
      await chmod(stagedFfmpeg, 0o755);
    }
    const installedVersionOutput = await readFfmpegVersion(stagedFfmpeg);
    if (!isSupportedFfmpegVersion(installedVersionOutput)) {
      throw new Error(`Downloaded FFmpeg has unsupported version: ${installedVersionOutput.split(/\r?\n/)[0] ?? "unknown"}`);
    }

    await replaceFile(stagedFfmpeg, targetPath);
    await installOptionalProbe(extractDirectory, targetPath, asset.probeName);
    setConfiguredFfmpegPath(config, targetPath);
    return {
      status: "installed",
      path: targetPath,
      version: parseFfmpegVersion(installedVersionOutput),
    };
  } finally {
    if (stagedFfmpeg) {
      await rm(stagedFfmpeg, { force: true });
    }
    await rm(installDirectory, { recursive: true, force: true });
  }
};

const getConfiguredFfmpegPath = (config: VideoConfig) =>
  process.platform === "win32" ? config.ffmpegWindowsPath : config.ffmpegLinuxPath;

const setConfiguredFfmpegPath = (config: VideoConfig, executablePath: string) => {
  if (process.platform === "win32") {
    config.ffmpegWindowsPath = executablePath;
  } else {
    config.ffmpegLinuxPath = executablePath;
  }
};

const resolveCurrentExecutable = (configuredPath: string) =>
  /[\\/]/.test(configuredPath) || path.isAbsolute(configuredPath)
    ? path.resolve(configuredPath)
    : Bun.which(configuredPath);

const resolveInstallTarget = (configuredPath: string, executableName: string) =>
  /[\\/]/.test(configuredPath) || path.isAbsolute(configuredPath)
    ? path.resolve(configuredPath)
    : path.resolve("tools", executableName);

const createFetchOptions = (proxyUrl: string) =>
  proxyUrl ? { proxy: proxyUrl } : {};

const fetchText = async (url: string, proxyUrl: string) => {
  const response = await fetch(url, createFetchOptions(proxyUrl));
  if (!response.ok) {
    throw new Error(`FFmpeg checksum request failed with HTTP ${response.status}`);
  }
  return response.text();
};

const downloadFile = async (
  url: string,
  destination: string,
  proxyUrl: string,
  archiveName: string,
  onProgress?: (progress: FfmpegDownloadProgress) => void,
) => {
  const response = await fetch(url, createFetchOptions(proxyUrl));
  if (!response.ok || !response.body) {
    throw new Error(`FFmpeg download failed with HTTP ${response.status}`);
  }
  const contentLengthHeader = response.headers.get("content-length");
  const parsedContentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  const contentLength = parsedContentLength !== undefined &&
      Number.isFinite(parsedContentLength) &&
      parsedContentLength > 0
    ? parsedContentLength
    : undefined;
  if (contentLength !== undefined && contentLength > MAX_FFMPEG_ARCHIVE_BYTES) {
    throw new Error(`FFmpeg archive is too large: ${contentLength} bytes`);
  }
  const reader = response.body.getReader();
  const writer = Bun.file(destination).writer();
  const reportProgress = createFfmpegDownloadProgressReporter(archiveName, onProgress);
  let receivedBytes = 0;
  try {
    reportProgress(receivedBytes, contentLength, false);
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_FFMPEG_ARCHIVE_BYTES) {
        throw new Error(`FFmpeg archive exceeded ${MAX_FFMPEG_ARCHIVE_BYTES} bytes`);
      }
      writer.write(value);
      reportProgress(receivedBytes, contentLength, false);
    }
    await writer.end();
    reportProgress(receivedBytes, contentLength, true);
  } catch (error) {
    reader.cancel().catch(() => undefined);
    await Promise.resolve(writer.end()).catch(() => undefined);
    await rm(destination, { force: true });
    throw error;
  }
  const file = await stat(destination);
  if (!file.isFile() || file.size === 0 || file.size > MAX_FFMPEG_ARCHIVE_BYTES) {
    throw new Error(`Downloaded FFmpeg archive has invalid size: ${file.size}`);
  }
};

export const createFfmpegDownloadProgressReporter = (
  archiveName: string,
  onProgress?: (progress: FfmpegDownloadProgress) => void,
) => {
  let lastReportedBytes = -DOWNLOAD_PROGRESS_BYTES_STEP;
  let lastReportedPercentage = -DOWNLOAD_PROGRESS_PERCENT_STEP;
  let lastEvent: FfmpegDownloadProgress | undefined;
  return (receivedBytes: number, totalBytes?: number, done = false) => {
    if (!onProgress) {
      return;
    }
    const percentage = totalBytes === undefined
      ? undefined
      : Math.min(100, Math.floor(receivedBytes / totalBytes * 100));
    if (!done && percentage === 100) {
      return;
    }
    const reportDue = done || lastEvent === undefined || (
      percentage === undefined
        ? receivedBytes - lastReportedBytes >= DOWNLOAD_PROGRESS_BYTES_STEP
        : percentage - lastReportedPercentage >= DOWNLOAD_PROGRESS_PERCENT_STEP
    );
    if (!reportDue) {
      return;
    }
    const event: FfmpegDownloadProgress = {
      archiveName,
      receivedBytes,
      totalBytes,
      percentage,
      done,
    };
    if (
      lastEvent?.receivedBytes === event.receivedBytes &&
      lastEvent.percentage === event.percentage &&
      lastEvent.done === event.done
    ) {
      return;
    }
    try {
      onProgress(event);
    } catch {
      // Progress reporting is observational and must not interrupt installation.
    }
    lastEvent = event;
    lastReportedBytes = receivedBytes;
    if (percentage !== undefined) {
      lastReportedPercentage = percentage;
    }
  };
};

export const formatDownloadBytes = (bytes: number) => {
  const mebibytes = bytes / 1024 / 1024;
  return `${mebibytes.toFixed(mebibytes >= 10 ? 1 : 2)} MiB`;
};

export const formatFfmpegDownloadProgress = (progress: FfmpegDownloadProgress) => {
  const received = formatDownloadBytes(progress.receivedBytes);
  if (progress.totalBytes === undefined) {
    return `FFmpeg downloading: ${received}`;
  }
  return `FFmpeg downloading: ${progress.percentage ?? 0}% (${received} / ${formatDownloadBytes(progress.totalBytes)})`;
};

const calculateFileSha256 = async (filePath: string) => {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(filePath).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
};

const extractArchive = async (archivePath: string, destination: string) => {
  const executable = process.platform === "win32" ? "tar.exe" : "tar";
  const child = Bun.spawn([executable, "-xf", archivePath, "-C", destination], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Unable to extract FFmpeg archive: ${stderr.trim().slice(-2_000)}`);
  }
};

const findExtractedExecutable = async (directory: string, executableName: string) => {
  const glob = new Bun.Glob(`**/${executableName}`);
  for await (const candidate of glob.scan({ cwd: directory, absolute: true, onlyFiles: true })) {
    return candidate;
  }
  throw new Error(`Downloaded archive does not contain ${executableName}`);
};

const readFfmpegVersion = async (executablePath: string) => {
  const child = Bun.spawn([executablePath, "-version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`FFmpeg version check failed: ${(stderr || stdout).trim().slice(-2_000)}`);
  }
  return stdout || stderr;
};

const replaceFile = async (stagedPath: string, targetPath: string) => {
  const backupPath = `${targetPath}.backup-${crypto.randomUUID()}`;
  const targetExists = await stat(targetPath).then((file) => file.isFile()).catch(() => false);
  if (targetExists) {
    await rename(targetPath, backupPath);
  }
  try {
    await rename(stagedPath, targetPath);
    if (targetExists) {
      await rm(backupPath, { force: true });
    }
  } catch (error) {
    if (targetExists) {
      await rename(backupPath, targetPath).catch(() => undefined);
    }
    throw error;
  }
};

const createStagedPath = (targetPath: string) => {
  const extension = path.extname(targetPath);
  const basename = path.basename(targetPath, extension);
  return path.join(path.dirname(targetPath), `${basename}.install-${crypto.randomUUID()}${extension}`);
};

const installOptionalProbe = async (extractDirectory: string, targetPath: string, probeName: string) => {
  const sourceProbe = await findExtractedExecutable(extractDirectory, probeName).catch(() => undefined);
  if (!sourceProbe) {
    return;
  }
  const probePath = path.join(path.dirname(targetPath), probeName);
  const stagedProbe = createStagedPath(probePath);
  try {
    await copyFile(sourceProbe, stagedProbe);
    if (process.platform !== "win32") {
      await chmod(stagedProbe, 0o755);
    }
    await replaceFile(stagedProbe, probePath);
  } finally {
    await rm(stagedProbe, { force: true });
  }
};
