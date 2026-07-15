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
  vtb: "主播直播与动态",
  wallpaper: "今日壁纸",
};

const helpPlugin: MizPlugin = {
  name: "help",
  commands: ["help", "帮助"],
  description: "查看当前可用的命令、说明和示例",
  async handle({ commandPrefix, plugins, replyForward }) {
    const lines = createHelpMessages(commandPrefix, plugins);

    await replyForward(lines.length > 0 ? lines : ["现在没有可用命令，插件可能还没有加载完成。"], {
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
      const description = formatDescription(plugin.description ?? "这个功能还没有补充说明。");
      const displayName = pluginDisplayNames[plugin.name] ?? plugin.name;
      return `【${displayName}】\n${description}\n命令：\n${commands}`;
    });

const formatDescription = (description: string) => description.replace(/\s*(用法[：:])/g, "\n$1");
