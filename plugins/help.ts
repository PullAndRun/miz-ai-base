import type { MizPlugin, PluginInfo } from "@/plugins";

const pluginDisplayNames: Readonly<Record<string, string>> = {
  activity: "活动报名",
  broadcast: "群公告",
  divination: "今日小签",
  ff14: "FF14 市场",
  faq: "群问答",
  help: "功能菜单",
  joke: "笑话图",
  news: "财经快讯",
  qrcode: "二维码",
  remind: "群提醒",
  schedule: "群日程",
  todo: "群待办",
  video: "视频",
  vtb: "B 站主播",
  wallpaper: "每日一图",
};

const helpPlugin: MizPlugin = {
  name: "help",
  commands: ["help", "帮助"],
  description: "看看 miz 能做什么，以及每个命令怎么用。",
  async handle({ commandPrefix, plugins, replyForward }) {
    const lines = createHelpMessages(commandPrefix, plugins);

    await replyForward(lines.length > 0 ? lines : ["暂时没有可用功能，可能还在加载。"], {
      title: "miz · 功能菜单",
      source: commandPrefix,
      summary: `${lines.length} 项可用功能`,
    });
  },
};

export default helpPlugin;

export const createHelpMessages = (commandPrefix: string, plugins: readonly PluginInfo[]) =>
  plugins
    .filter((plugin) => plugin.commands.length > 0)
    .map((plugin) => {
      const commands = plugin.commands.map((command) => `${commandPrefix} ${command}`).join("\n");
      const description = formatDescription(plugin.description ?? "这个功能还没写说明。");
      const displayName = pluginDisplayNames[plugin.name] ?? plugin.name;
      return `【${displayName}】\n${description}\n可用命令：\n${commands}`;
    });

const formatDescription = (description: string) => description.replace(/\s*(用法[：:])/g, "\n$1");
