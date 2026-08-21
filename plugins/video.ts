import type { Logger } from "@/logger";
import type { MizPlugin } from "@/plugins";
import {
  deliverVideoWithFallback,
  isVideoDeliveryError,
  type VideoDeliveryError,
} from "@/video-delivery";
import { enqueueVideoJob } from "@/video-jobs";
import {
  deleteDownloadedVideo,
  downloadVideo,
  isBilibiliUrl,
  isVideoUrl,
  isWhitelistedVideoUser,
} from "@/video";

const VIDEO_SEND_TIMEOUT_MS = 10 * 60_000;

const videoPlugin: MizPlugin = {
  name: "video",
  commands: ["video", "视频"],
  description: [
    "把链接里的视频搬到聊天里。普通成员可用 B 站链接，白名单成员可用其他站点。",
    "用法：miz video 视频链接",
  ].join("\n"),
  async handle({
    command,
    config,
    logger,
    message,
    reply,
    replyForwardWithoutRetry,
    replyWithoutRetry,
  }) {
    const url = command.args.trim();
    if (!url) {
      await reply("🎬 视频链接还没放进来。\n例如：miz video https://...");
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

    const queued = enqueueVideoJob(config.video.maxConcurrentJobs);
    if (queued.position > 0) {
      await reply(`视频已加入队列，前面还有 ${queued.position} 个视频，将按顺序发布。`);
    }
    const admission = await queued.ready;
    /* legacy rejection branch removed
      await reply(admission.reason === "duplicate"
        ? "你已经有一个视频在处理中，请等它完成后再发下一个。"
        : "现在处理中的视频有点多，请稍后再试。");
      return;
    }

    */
    try {
      await processVideo({
        url,
        config,
        logger,
        reply,
        sendVideo: (videoMessage) =>
          replyWithoutRetry([videoMessage], { timeoutMs: VIDEO_SEND_TIMEOUT_MS }),
        sendForward: (videoMessage) => replyForwardWithoutRetry(
          [[videoMessage]],
          {
            title: "视频",
            source: "miz video",
            summary: "1 条视频",
            timeoutMs: VIDEO_SEND_TIMEOUT_MS,
          },
        ),
      });
    } finally {
      admission.release();
    }
  },
};

export default videoPlugin;

const processVideo = async ({
  url,
  config,
  logger,
  reply,
  sendVideo,
  sendForward,
}: {
  url: string;
  config: Parameters<NonNullable<MizPlugin["handle"]>>[0]["config"];
  logger: Logger;
  reply: (message: unknown) => Promise<unknown>;
  sendVideo: Parameters<typeof deliverVideoWithFallback>[2];
  sendForward: Parameters<typeof deliverVideoWithFallback>[3];
}) => {
  let deliveryAttempted = false;
  try {
    const downloadedVideoPath = await downloadVideo({
      url,
      config: config.video,
      network: config.network,
    });
    try {
      deliveryAttempted = true;
      await deliverVideoWithFallback(
        downloadedVideoPath,
        config.video,
        sendVideo,
        sendForward,
      );
    } finally {
      await cleanupVideoFile(downloadedVideoPath, logger);
    }
  } catch (error) {
    if (isVideoDeliveryError(error)) {
      logger.warn("plugin", "all video delivery strategies failed", {
        attempts: describeDeliveryAttempts(error),
      });
    } else {
      logger.error("plugin", "video processing failed", error);
    }
    await reply(deliveryAttempted
      ? "共享文件、Base64 和文件转发都没能把视频发出去。请稍后再试；如果持续失败，请检查 NapCat 和 QQ 的富媒体发送状态。"
      : "视频刚才在下载或转码时卡住了，稍后再试一次吧。如果内容需要登录，请让管理员检查对应站点的登录配置。");
  }
};

const describeDeliveryAttempts = (error: VideoDeliveryError) =>
  error.attempts.map((attempt) => ({
    mode: attempt.mode,
    error: describeError(attempt.error),
  }));

const describeError = (error: unknown) => {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  if (typeof error === "object" && error !== null) {
    return { code: (error as { code?: unknown }).code };
  }
  return { value: String(error) };
};

const cleanupVideoFile = async (videoPath: string, logger: Logger) => {
  await deleteDownloadedVideo(videoPath).catch((error) => {
    logger.warn("plugin", "video cleanup failed", { videoPath, error });
  });
};
