import { loadConfig } from "@/config";
import {
  formatFfmpegDownloadProgress,
  installFfmpegForWindowsAndLinux,
} from "@/ffmpeg-install";

const config = await loadConfig();
console.log(`Preparing Windows and Linux FFmpeg for ${process.arch}...`);
const results = await installFfmpegForWindowsAndLinux(config.video, config.network, {
  force: process.argv.includes("--force"),
  onDownloadProgress: (progress) => console.log(formatFfmpegDownloadProgress(progress)),
});
for (const result of results) {
  const platform = result.platform === "win32" ? "Windows" : "Linux";
  console.log(`${platform} FFmpeg ${result.status}: ${result.version ?? "unknown"} (${result.path})`);
}

export {};
