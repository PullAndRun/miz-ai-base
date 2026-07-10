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
  description: "下载并发送视频。普通用户仅支持哔哩哔哩链接；白名单用户可使用其他站点。用法：miz video 视频链接",
  async handle({ command, config, logger, message, reply }) {
    const url = command.args.trim();
    if (!url) {
      await reply("用法：miz video 视频链接");
      return;
    }

    if (!config.video.enabled) {
      await reply("视频功能当前未启用。");
      return;
    }

    if (!isVideoUrl(url)) {
      await reply("请输入有效的视频链接。");
      return;
    }

    const whitelisted = isWhitelistedVideoUser(message.userId, config.video.whitelistUserIds);
    if (!whitelisted && !isBilibiliUrl(url)) {
      await reply("普通用户仅支持哔哩哔哩视频链接。");
      return;
    }

    try {
      const duration = await getVideoDuration(url, config.video);
      if (duration === undefined) {
        await reply("无法获取视频时长，暂不支持发送。");
        return;
      }

      if (duration >= MAX_VIDEO_DURATION_SECONDS) {
        await reply("仅支持发送小于 10 分钟的视频。");
        return;
      }

      const downloadedVideoPath = await downloadVideo({ url, config: config.video });
      let videoPath = downloadedVideoPath;
      try {
        videoPath = await prepareVideoForQq(downloadedVideoPath, config.video);
        await reply({
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
      await reply("视频下载或发送失败，请稍后再试。");
    }
  },
};

export default videoPlugin;
