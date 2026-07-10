import type { MizPlugin } from "@/plugins";

const helpPlugin: MizPlugin = {
  name: "help",
  commands: ["help", "帮助"],
  description: "列出当前可用命令",
  async handle({ commandPrefix, plugins, replyForward }) {
    const lines = plugins.map((plugin) => {
      const commands = plugin.commands.map((command) => `${commandPrefix} ${command}`).join("\n");
      const description = formatDescription(plugin.description ?? "暂无介绍");
      return `功能: ${plugin.name}\n介绍: ${description}\n命令:\n${commands}`;
    });

    await replyForward(lines.length > 0 ? lines : ["暂无可用命令"], {
      title: `${commandPrefix} help`,
      source: commandPrefix,
      summary: `共 ${lines.length} 个命令`,
    });
  },
};

export default helpPlugin;

const formatDescription = (description: string) => description.replace(/\s*(用法[：:])/g, "\n$1");
