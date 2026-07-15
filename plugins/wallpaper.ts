import type { MizPlugin } from "@/plugins";
import { createWallpaperMessage, getDailyWallpaper } from "@/wallpaper";

const wallpaperPlugin: MizPlugin = {
  name: "wallpaper",
  commands: ["wallpaper", "壁纸"],
  description: "每天和大家分享一张 Bing 精选风景图。\n用法：miz wallpaper",
  async handle({ command, config, logger, reply }) {
    if (command.args) {
      await reply("不用加内容，直接发 miz wallpaper 就能看今天这张图。");
      return;
    }

    if (!config.wallpaper.apiUrl || !config.wallpaper.imageBaseUrl) {
      await reply("每日一图还没配置好，请联系管理员处理。");
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
      await reply("今天这张图暂时没取到，晚点再来看看吧。");
    }
  },
};

export default wallpaperPlugin;
