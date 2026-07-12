import type { MizPlugin } from "@/plugins";
import {
  deleteDownloadedVideo,
  downloadVideo,
  getNapcatVideoFile,
  getVideoDuration,
  isBilibiliUrl,
  isVideoUrl,
  isWhitelistedVideoUser,
  MAX_VIDEO_DURATION_SECONDS,
  prepareVideoForQq,
} from "@/video";

const videoPlugin: MizPlugin = {
  name: "video",
  commands: ["video", "视频"],
  description: [
    "下载并发送少于 10 分钟的视频。普通成员仅支持 B 站链接，白名单成员可使用其他站点。",
    "用法：miz video 视频链接",
  ].join("\n"),
  async handle({ command, config, logger, message, reply, replyWithoutRetry }) {
    const url = command.args.trim();
    if (!url) {
      await reply("请这样使用：miz video 视频链接\n仅支持时长少于 10 分钟的视频。");
      return;
    }

    if (!config.video.enabled) {
      await reply("视频功能目前没有开启，请联系机器人管理员。");
      return;
    }

    if (!isVideoUrl(url)) {
      await reply("这看起来不是有效的视频链接，请复制完整的 http 或 https 地址后重试。");
      return;
    }

    const whitelisted = isWhitelistedVideoUser(message.userId, config.video.whitelistUserIds);
    if (!whitelisted && !isBilibiliUrl(url)) {
      await reply("当前仅支持发送 B 站视频链接；其他网站仅对白名单成员开放。");
      return;
    }

    try {
      const duration = await getVideoDuration(url, config.video);
      if (duration === undefined) {
        await reply("没能确认视频时长，因此暂不发送。请换一个公开可访问的视频链接试试。");
        return;
      }

      if (duration >= MAX_VIDEO_DURATION_SECONDS) {
        await reply("视频时长超过 10 分钟，暂不支持发送。请裁剪后再试。");
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
      await reply("视频下载或发送没有完成，请稍后再试；如果链接需要登录，请确认机器人已配置登录凭据。");
    }
  },
};

export default videoPlugin;
