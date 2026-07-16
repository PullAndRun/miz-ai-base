import type { MizPlugin } from "@/plugins";
import { createWallpaperMessage, getDailyWallpaper } from "@/wallpaper";

const wallpaperPlugin: MizPlugin = {
  name: "wallpaper",
  commands: ["wallpaper", "壁纸"],
  description: "每天从 Bing 精选里捎来一张风景，给屏幕换换心情。\n用法：miz wallpaper",
  async handle({ command, config, logger, reply }) {
    if (command.args) {
      await reply("🌄 不用追加内容，直接发 miz wallpaper 就能打开今天的风景。");
      return;
    }

    if (!config.wallpaper.apiUrl || !config.wallpaper.imageBaseUrl) {
      await reply("每日一图的 Bing 官方接口还没配置，请联系管理员检查 app.toml。");
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
      await reply("今天的风景还在路上，晚点再来看看吧。");
    }
  },
};

export default wallpaperPlugin;
