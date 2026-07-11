import type { MizPlugin } from "@/plugins";
import { createWallpaperMessage, getDailyWallpaper } from "@/wallpaper";

const wallpaperPlugin: MizPlugin = {
  name: "wallpaper",
  commands: ["wallpaper", "壁纸"],
  description: "获取今日 Bing UHD 壁纸与版权信息。\n用法：miz wallpaper",
  async handle({ command, config, logger, reply }) {
    if (command.args) {
      await reply("请这样使用：miz wallpaper\n这个命令不需要附加内容。");
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
      await reply("今天的壁纸暂时没能获取到，请稍后再试一次。");
    }
  },
};

export default wallpaperPlugin;
