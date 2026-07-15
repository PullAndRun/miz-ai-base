import type { MizPlugin } from "@/plugins";
import {
  deleteDownloadedVideo,
  downloadVideo,
  getNapcatVideoFile,
  getVideoDuration,
  isBilibiliUrl,
  isVideoDurationAllowed,
  isVideoUrl,
  isWhitelistedVideoUser,
  prepareVideoForQq,
} from "@/video";

const videoPlugin: MizPlugin = {
  name: "video",
  commands: ["video", "视频"],
  description: [
    "下载并发送 10 分钟以内的视频。普通成员可用 B 站链接，白名单成员可使用其他站点。",
    "用法：miz video 视频链接",
  ].join("\n"),
  async handle({ command, config, logger, message, reply, replyWithoutRetry }) {
    const url = command.args.trim();
    if (!url) {
      await reply("请在命令后面放一个视频链接。\n例如：miz video https://...\n支持时长不超过 10 分钟的视频。");
      return;
    }

    if (!config.video.enabled) {
      await reply("视频功能尚未启用，请联系管理员完成配置。");
      return;
    }

    if (!isVideoUrl(url)) {
      await reply("这不是完整的视频链接。请使用以 http:// 或 https:// 开头的地址。");
      return;
    }

    const whitelisted = isWhitelistedVideoUser(message.userId, config.video.whitelistUserIds);
    if (!whitelisted && !isBilibiliUrl(url)) {
      await reply("你目前只能使用 B 站链接；其他站点仅对视频白名单开放。");
      return;
    }

    try {
      const duration = await getVideoDuration(url, config.video);
      if (duration === undefined) {
        await reply("无法读取视频时长。链接可能已失效、需要登录，或不是公开内容。请换一个可以直接访问的链接。");
        return;
      }

      if (!isVideoDurationAllowed(duration)) {
        await reply("这个视频超过 10 分钟，无法发送。请换一个短版，或先裁剪视频。");
        return;
      }

      const downloadedVideoPath = await downloadVideo({ url, config: config.video });
      let videoPath = downloadedVideoPath;
      try {
        videoPath = await prepareVideoForQq(downloadedVideoPath, config.video);
        await replyWithoutRetry({
          type: "video",
          data: {
            file: await getNapcatVideoFile(videoPath, config.video),
          },
        });
      } finally {
        await deleteDownloadedVideo(videoPath);
        if (videoPath !== downloadedVideoPath) {
          await deleteDownloadedVideo(downloadedVideoPath);
        }
      }
      logger.info("plugin", "video sent", {
        userId: message.userId,
        groupId: message.groupId,
        source: isBilibiliUrl(url) ? "bilibili" : "whitelist",
      });
    } catch (error) {
      logger.error("plugin", "video download failed", error);
      await reply("视频处理失败。可以稍后重试；如果内容需要登录，请让管理员检查对应站点的登录配置。");
    }
  },
};

export default videoPlugin;
