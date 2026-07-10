import type { MizPlugin } from "@/plugins";
import { createWallpaperMessage, getDailyWallpaper } from "@/wallpaper";

const wallpaperPlugin: MizPlugin = {
  name: "wallpaper",
  commands: ["wallpaper", "壁纸"],
  description: "发送 Bing 今日 UHD 风景壁纸及版权信息。用法：miz wallpaper",
  async handle({ command, config, logger, reply }) {
    if (command.args) {
      await reply("用法：miz wallpaper");
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
      await reply("今日壁纸暂时无法获取，请稍后再试。");
    }
  },
};

export default wallpaperPlugin;
