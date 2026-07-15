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
  description: "想找功能或忘了命令？来这里翻翻 miz 的功能图鉴。",
  async handle({ commandPrefix, plugins, replyForward }) {
    const lines = createHelpMessages(commandPrefix, plugins);

    await replyForward(lines.length > 0 ? lines : ["功能还在赶来的路上，稍后再打开菜单看看吧。"], {
      title: "✨ miz · 功能图鉴",
      source: commandPrefix,
      summary: `${lines.length} 项功能等你来用`,
    });
  },
};

export default helpPlugin;

export const createHelpMessages = (commandPrefix: string, plugins: readonly PluginInfo[]) =>
  plugins
    .filter((plugin) => plugin.commands.length > 0)
    .map((plugin) => {
      const commands = plugin.commands.map((command) => `${commandPrefix} ${command}`).join("\n");
      const description = formatDescription(plugin.description ?? "这个功能还在准备说明，先记住它的名字吧。");
      const displayName = pluginDisplayNames[plugin.name] ?? plugin.name;
      return `✦ ${displayName}\n${description}\n\n指令入口：\n${commands}`;
    });

const formatDescription = (description: string) => description.replace(/\s*(用法[：:])/g, "\n$1");
