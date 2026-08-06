import { updatePackageDependencies } from "@/dependency-update";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "@/config";
import { installFfmpegForWindowsAndLinux } from "@/ffmpeg-install";

const requestedRuntimeMode = process.argv[2];
if (requestedRuntimeMode === "normal" || requestedRuntimeMode === "docker") {
  process.env.MIZ_RUNTIME_MODE = requestedRuntimeMode;
}
if (requestedRuntimeMode !== undefined && requestedRuntimeMode !== "normal" && requestedRuntimeMode !== "docker") {
  throw new Error("Usage: bun run scripts/update-dependencies.ts [normal|docker]");
}

if (requestedRuntimeMode === "docker" && !await Bun.file("config/app.docker.toml").exists()) {
  const example = Bun.file("config/example/app.docker.toml");
  if (!await example.exists()) throw new Error("Docker configuration template not found: config/example/app.docker.toml");
  await Bun.write("config/app.docker.toml", await example.text());
}

const toolsDirectory = path.resolve("tools");
const githubHeaders = { Accept: "application/vnd.github+json", "User-Agent": "miz-tool-updater" };
const NETWORK_TIMEOUT_MS = 30_000;
type DependencyFetchInit = RequestInit & { proxy?: string };

const fetchWithTimeout = (url: string, init: DependencyFetchInit = {}) =>
  fetch(url, {
    ...init,
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(NETWORK_TIMEOUT_MS)])
      : AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  } as RequestInit).catch((error) => {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`Dependency download timed out after ${NETWORK_TIMEOUT_MS / 1000}s: ${url}`);
    }
    throw error;
  });

const fetchJson = async (url: string, proxyUrl: string) => {
  const response = await fetchWithTimeout(url, { ...(proxyUrl ? { proxy: proxyUrl } : {}), headers: githubHeaders });
  if (!response.ok) throw new Error(`Tool release lookup failed with HTTP ${response.status}`);
  return response.json() as Promise<{ tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> }>;
};

const calculateSha256 = async (filePath: string) => {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(filePath).stream()) hasher.update(chunk);
  return hasher.digest("hex");
};

const updateYtDlpBinaries = async (proxyUrl: string, arch: string) => {
  console.log("yt-dlp: checking latest release...");
  const release = await fetchJson("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest", proxyUrl);
  const tag = release.tag_name;
  if (!tag) throw new Error("yt-dlp release has no version tag");
  const names = arch === "arm64"
    ? { win: "yt-dlp_arm64.exe", linux: "yt-dlp_linux_aarch64" }
    : { win: "yt-dlp.exe", linux: "yt-dlp" };
  await mkdir(toolsDirectory, { recursive: true });
  const checksumAsset = release.assets?.find((item) => item.name === "SHA2-256SUMS");
  if (!checksumAsset?.browser_download_url) throw new Error("yt-dlp release is missing SHA2-256SUMS");
  console.log(`yt-dlp: latest ${tag}; fetching checksums...`);
  const checksumResponse = await fetchWithTimeout(
    checksumAsset.browser_download_url,
    proxyUrl ? { proxy: proxyUrl } : {},
  );
  if (!checksumResponse.ok) throw new Error(`yt-dlp checksum download failed with HTTP ${checksumResponse.status}`);
  const checksumText = await checksumResponse.text();
  for (const [platform, assetName] of Object.entries(names)) {
    const asset = release.assets?.find((item) => item.name === assetName);
    if (!asset?.browser_download_url) throw new Error(`yt-dlp release is missing ${assetName}`);
    const target = path.join(toolsDirectory, platform === "win" ? "yt-dlp.exe" : "yt-dlp");
    const markerPath = `${target}.miz-update.json`;
    const marker = await Bun.file(markerPath).json().catch(() => undefined) as { tag?: string } | undefined;
    const existing = await stat(target).catch(() => undefined);
    const expectedSha256 = new RegExp(`^([a-fA-F0-9]{64})\\s+[*]?${assetName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}$`, "m").exec(checksumText)?.[1]?.toLowerCase();
    if (!expectedSha256) throw new Error(`yt-dlp checksum not found for ${assetName}`);
    if (existing?.isFile() && existing.size > 0) {
      console.log(`yt-dlp ${platform}: verifying existing file...`);
    }
    const currentSha256 = existing?.isFile() && existing.size > 0 ? await calculateSha256(target) : undefined;
    if (currentSha256 === expectedSha256) {
      if (marker?.tag !== tag) {
        await Bun.write(markerPath, `${JSON.stringify({ tag, asset: assetName, sha256: expectedSha256 }, null, 2)}\n`);
      }
      console.log(`yt-dlp ${platform}: current ${tag} (${target})`);
      continue;
    }
    console.log(`yt-dlp ${platform}: downloading ${assetName}...`);
    const response = await fetchWithTimeout(asset.browser_download_url, proxyUrl ? { proxy: proxyUrl } : {});
    if (!response.ok || !response.body) throw new Error(`yt-dlp download failed with HTTP ${response.status}`);
    const staged = `${target}.install-${crypto.randomUUID()}`;
    await Bun.write(staged, response);
    if (platform === "linux") await chmod(staged, 0o755);
    const backup = `${target}.backup-${crypto.randomUUID()}`;
    if (existing?.isFile()) await rename(target, backup);
    try {
      await rename(staged, target);
      if (existing?.isFile()) await rm(backup, { force: true });
    } catch (error) {
      if (existing?.isFile()) await rename(backup, target).catch(() => undefined);
      throw error;
    } finally {
      await rm(staged, { force: true });
    }
    await Bun.write(markerPath, `${JSON.stringify({ tag, asset: assetName, sha256: expectedSha256 }, null, 2)}\n`);
    console.log(`yt-dlp ${platform}: updated ${tag} (${target})`);
  }
};

const config = await loadConfig();
const result = await updatePackageDependencies({ proxyUrl: config.network.proxyUrl });
if (result.changes.length === 0) {
  console.log("Package dependencies are already up to date.");
} else {
  console.log(`Updated ${result.changes.length} package dependencies:`);
  for (const change of result.changes) {
    console.log(`- ${change.name} (${change.section}): ${change.from} -> ${change.to}`);
  }
}

const ffmpegResults = await installFfmpegForWindowsAndLinux(config.video, config.network);
for (const result of ffmpegResults) {
  console.log(`FFmpeg ${result.platform}: ${result.status} ${result.version ?? "unknown"} (${result.path})`);
}
await updateYtDlpBinaries(config.network.proxyUrl, process.arch);

export {};
