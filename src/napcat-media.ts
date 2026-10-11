import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeMode } from "@/config";

/**
 * bot 与 NapCat 共享的媒体目录：bot 写入文件，NapCat 通过挂载读到同一份文件。
 * 用 file:// 发送时 WebSocket 帧里只有路径，不受 NapCat 50MiB 单帧上限约束。
 */

/** Docker 模式固定落项目 temp/；Windows 本机的 "/temp" 占位符同样落到项目 temp/。 */
export const resolveSharedMediaDirectory = (runtimeMode: RuntimeMode, configuredDirectory: string) =>
  runtimeMode === "docker"
    ? path.join(process.cwd(), "temp")
    : process.platform === "win32" && configuredDirectory === "/temp"
      ? path.join(process.cwd(), "temp")
      : configuredDirectory;

/** NapCat 视角下的 file:// 地址，例如 file:///app/media/miz-vtb-image-xxx.jpg。 */
export const buildNapcatFileUrl = (napcatDirectory: string, fileName: string) => {
  const fileUrl = new URL("file:///");
  fileUrl.pathname = path.posix.join(napcatDirectory, fileName);
  return fileUrl.href;
};

/** 文件名由 key 的哈希决定：同一张图在被清理前始终命中同一个文件。 */
export const createHashedMediaFileName = (prefix: string, key: string, extension: string) =>
  `${prefix}${createHash("sha1").update(key).digest("hex").slice(0, 20)}.${extension}`;

export const sharedMediaFileExists = async (directory: string, fileName: string) => {
  const file = await stat(path.join(directory, fileName)).catch(() => undefined);
  return file?.isFile() === true;
};

/** 先写临时文件再改名，避免其他进程读到写了一半的图片。 */
export const writeSharedMediaFile = async (directory: string, fileName: string, bytes: Uint8Array) => {
  await mkdir(directory, { recursive: true });
  const targetPath = path.join(directory, fileName);
  const stagingPath = `${targetPath}.${process.pid}.tmp`;
  try {
    await writeFile(stagingPath, bytes);
    await rename(stagingPath, targetPath);
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return targetPath;
};

/** 删除超过保留期的媒体文件；只匹配调用方给出的文件命名，不影响其他产物。 */
export const removeStaleMediaFiles = async (
  directory: string,
  isManagedFile: (fileName: string) => boolean,
  maxAgeMs: number,
  now = Date.now(),
) => {
  const cutoff = now - maxAgeMs;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const removed = (await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !isManagedFile(entry.name)) {
      return undefined;
    }
    const filePath = path.join(directory, entry.name);
    const file = await stat(filePath).catch(() => undefined);
    if (!file || file.mtimeMs > cutoff) {
      return undefined;
    }
    await rm(filePath, { force: true });
    return filePath;
  }))).filter((filePath): filePath is string => filePath !== undefined);
  return removed;
};
