import { loadConfig } from "@/config";
import { ensureFfmpeg, formatFfmpegDownloadProgress } from "@/ffmpeg-install";

const config = await loadConfig();
const result = await ensureFfmpeg(config.video, config.network, {
  force: process.argv.includes("--force"),
  onDownloadProgress: (progress) => console.log(formatFfmpegDownloadProgress(progress)),
});
console.log(`FFmpeg ${result.status}: ${result.version ?? "unknown"} (${result.path})`);

export {};
