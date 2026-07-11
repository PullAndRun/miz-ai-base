import type { MizPlugin } from "@/plugins";
import { createNoNewsMessage, deliverUnsentNews, formatNewsMessages } from "@/news";

const newsPlugin: MizPlugin = {
  name: "news",
  commands: ["news", "新闻"],
  description: "查看尚未推送过的财经快讯。\n用法：miz news",
  async handle({ command, config, logger, message, reply, replyForward }) {
    if (command.args) {
      await reply("请这样使用：miz news\n不需要附加关键词。");
      return;
    }

    try {
      const news = await deliverUnsentNews(config, config.news.apiUrl, getTargetKey(message), async (items) => {
        await replyForward(formatNewsMessages(items), {
          title: "新闻速递",
          source: "miz news",
          summary: `${items.length} 条最新财经资讯`,
        });
      });

      if (news.length === 0) {
        await reply(createNoNewsMessage());
      }
    } catch (error) {
      logger.error("plugin", "news request failed", error);
      await reply("财经快讯暂时无法获取，请稍后再试。");
    }
  },
};

export default newsPlugin;

const getTargetKey = (message: { groupId?: number | string; userId?: number | string }) => {
  if (message.groupId !== undefined) {
    return `group:${message.groupId}`;
  }

  return `private:${message.userId ?? "unknown"}`;
};
