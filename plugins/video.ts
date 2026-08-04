import type { MizPlugin } from "@/plugins";
import type { Logger } from "@/logger";
import type { VideoConfig } from "@/config";
import {
  deleteDownloadedVideo,
  downloadVideo,
  getNapcatVideoBase64File,
  getNapcatVideoFile,
  getVideoDuration,
  isBilibiliUrl,
  isVideoDurationAllowed,
  isVideoUrl,
  isWhitelistedVideoUser,
} from "@/video";

const VIDEO_SEND_TIMEOUT_MS = 10 * 60_000;
const VIDEO_SEND_CLEANUP_GRACE_MS = 10 * 60_000;

const videoPlugin: MizPlugin = {
  name: "video",
  commands: ["video", "视频"],
  description: [
    "把链接里的视频搬到聊天里，最长 10 分钟。普通成员可用 B 站链接，白名单成员可用其他站点。",
    "用法：miz video 视频链接",
  ].join("\n"),
  async handle({ command, config, logger, message, reply, replyForward, replyWithoutRetry }) {
    const url = command.args.trim();
    if (!url) {
      await reply("🎬 视频链接还没放进来。\n例如：miz video https://...\n时长记得控制在 10 分钟以内。");
      return;
    }

    if (!config.video.enabled) {
      await reply("视频搬运通道还没开启，喊管理员来接通一下吧。");
      return;
    }

    if (!isVideoUrl(url)) {
      await reply("这个链接像是少了一截，请使用以 http:// 或 https:// 开头的完整地址。");
      return;
    }

    const whitelisted = isWhitelistedVideoUser(message.userId, config.video.whitelistUserIds);
    if (!whitelisted && !isBilibiliUrl(url, config.video.bilibiliHosts)) {
      await reply("目前可以直接搬运 B 站视频；其他站点需要视频白名单权限。");
      return;
    }

    try {
      const duration = await getVideoDuration(url, config.video, config.network, config.bilibili);
      if (duration === undefined) {
        await reply("没能读到视频时长。链接可能失效、需要登录，或内容没有公开，换一个能直接打开的链接试试吧。");
        return;
      }

      if (!isVideoDurationAllowed(duration)) {
        await reply("这段视频超过 10 分钟，搬不过来啦。换个短版，或者先裁剪一下吧。");
        return;
      }

      const downloadedVideoPath = await downloadVideo({
        url,
        config: config.video,
        network: config.network,
        bilibili: config.bilibili,
      });
      let delayedCleanup = false;
      try {
        const result = await deliverVideoWithFallback(
          downloadedVideoPath,
          config.video,
          (videoMessage) => replyWithoutRetry(videoMessage, { timeoutMs: VIDEO_SEND_TIMEOUT_MS }),
          (videoMessage) => replyForward(
            [videoMessage],
            {
              title: "视频",
              source: "miz video",
              summary: "1 条视频",
            },
          ),
        );
        delayedCleanup = result.encounteredTimeout;
      } catch (error) {
        delayedCleanup = isVideoDeliveryError(error) && error.encounteredTimeout;
        throw error;
      } finally {
        if (delayedCleanup) {
          scheduleVideoCleanup([downloadedVideoPath], logger);
        } else {
          await cleanupVideoFiles([downloadedVideoPath]);
        }
      }
    } catch (error) {
      logger.error("plugin", "video processing or delivery failed", error);
      await reply(isVideoDeliveryError(error)
        ? "视频已经下载好了，但 NapCat 向 QQ 上传视频失败了。请稍后再试；如果持续失败，请检查 NapCat 和 QQ 的富媒体发送状态。"
        : "视频刚才在路上卡住了，稍后再试一次吧。如果内容需要登录，请让管理员检查对应站点的登录配置。");
    }
  },
};

export default videoPlugin;

export const isVideoSendTimeoutError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "E_API_TIMEOUT";

export type VideoDeliveryMode = "file" | "base64" | "forward";

export type VideoDeliveryError = AggregateError & Readonly<{
  name: "VideoDeliveryError";
  encounteredTimeout: boolean;
}>;

export const isVideoDeliveryError = (error: unknown): error is VideoDeliveryError =>
  error instanceof AggregateError && error.name === "VideoDeliveryError";

const createVideoDeliveryError = (errors: readonly unknown[]): VideoDeliveryError =>
  Object.assign(new AggregateError(errors, "all video delivery attempts failed"), {
    name: "VideoDeliveryError" as const,
    encounteredTimeout: errors.some(isVideoSendTimeoutError),
  });

export const createNapcatVideoMessage = (videoPath: string, config: VideoConfig) => [{
  type: "video",
  data: {
    file: getNapcatVideoFile(videoPath, config),
  },
}] as const;

export const createNapcatBase64VideoMessage = async (videoPath: string) => [{
  type: "video",
  data: {
    file: await getNapcatVideoBase64File(videoPath),
  },
}] as const;

export const deliverVideoWithFallback = async (
  videoPath: string,
  config: VideoConfig,
  sendVideoMessage: (message: readonly unknown[]) => Promise<unknown>,
  sendForwardMessage: (message: readonly unknown[]) => Promise<unknown>,
): Promise<{ mode: VideoDeliveryMode; encounteredTimeout: boolean }> => {
  const errors: unknown[] = [];
  const attempt = async (mode: VideoDeliveryMode, operation: () => Promise<unknown>) => {
    try {
      await operation();
      return { mode, encounteredTimeout: errors.some(isVideoSendTimeoutError) };
    } catch (error) {
      errors.push(error);
      return undefined;
    }
  };

  const fileResult = await attempt("file", () =>
    sendVideoMessage(createNapcatVideoMessage(videoPath, config)));
  if (fileResult) {
    return fileResult;
  }

  const base64Result = await attempt("base64", async () =>
    sendVideoMessage(await createNapcatBase64VideoMessage(videoPath)));
  if (base64Result) {
    return base64Result;
  }

  const forwardResult = await attempt("forward", () =>
    sendForwardMessage(createNapcatVideoMessage(videoPath, config)));
  if (forwardResult) {
    return forwardResult;
  }

  throw createVideoDeliveryError(errors);
};

const cleanupVideoFiles = async (videoPaths: readonly string[]) => {
  await Promise.all(videoPaths.map((videoPath) => deleteDownloadedVideo(videoPath)));
};

const scheduleVideoCleanup = (videoPaths: readonly string[], logger: Logger) => {
  const timer = setTimeout(() => {
    void cleanupVideoFiles(videoPaths).catch((error) => {
      logger.warn("plugin", "delayed video cleanup failed", error);
    });
  }, VIDEO_SEND_CLEANUP_GRACE_MS);
  timer.unref?.();
};
