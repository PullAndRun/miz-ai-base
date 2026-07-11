import type { MizPlugin } from "@/plugins";

const helpPlugin: MizPlugin = {
  name: "help",
  commands: ["help", "帮助"],
  description: "查看机器人可用功能与命令",
  async handle({ commandPrefix, plugins, replyForward }) {
    const availablePlugins = plugins.filter((plugin) => plugin.commands.length > 0);
    const lines = availablePlugins.map((plugin) => {
      const commands = plugin.commands.map((command) => `${commandPrefix} ${command}`).join("\n");
      const description = formatDescription(plugin.description ?? "暂无介绍");
      return `【${plugin.name}】\n${description}\n可用命令：\n${commands}`;
    });

    const repeatHelp = "复读为内置功能：群内连续 3 条相同的文本或图片（不含 miz 命令）时，机器人会复读一次。";

    await replyForward(lines.length > 0 ? [...lines, repeatHelp] : ["暂时没有可用命令。"], {
      title: `${commandPrefix} help`,
      source: commandPrefix,
      summary: `共 ${lines.length} 个功能，展开查看完整命令与用法`,
    });
  },
};

export default helpPlugin;

const formatDescription = (description: string) => description.replace(/\s*(用法[：:])/g, "\n$1");
