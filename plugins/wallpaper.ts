import type { MizPlugin } from "@/plugins";
import { createWallpaperMessage, getDailyWallpaper } from "@/wallpaper";

const wallpaperPlugin: MizPlugin = {
  name: "wallpaper",
  commands: ["wallpaper", "壁纸"],
  description: "看看今天的 Bing 高清壁纸，以及标题和版权信息。\n用法：miz wallpaper",
  async handle({ command, config, logger, reply }) {
    if (command.args) {
      await reply("今日壁纸不需要参数，直接发送 miz wallpaper。");
      return;
    }

    if (!config.wallpaper.apiUrl || !config.wallpaper.imageBaseUrl) {
      await reply("今日壁纸还没有接入图片源，请联系管理员完成配置。");
      return;
    }

    try {
      const wallpaper = await getDailyWallpaper(
        config.wallpaper.apiUrl,
        config.wallpaper.imageBaseUrl,
      );
      await reply(createWallpaperMessage(wallpaper));
    } catch (error) {
      logger.error("plugin", "wallpaper request failed", error);
      await reply("今天这张壁纸暂时没取到，晚点再来看看吧。");
    }
  },
};

export default wallpaperPlugin;
