import type { MizPlugin } from "@/plugins";
import { createNoNewsMessage, deliverUnsentNews, formatNewsMessages } from "@/news";

const newsPlugin: MizPlugin = {
  name: "news",
  commands: ["news", "新闻"],
  description: "读取当前会话中尚未看过的财经快讯。\n用法：miz news",
  async handle({ command, config, logger, message, reply, replyForward }) {
    if (command.args) {
      await reply("财经快讯暂不支持关键词筛选，直接发送 miz news。");
      return;
    }

    if (!config.news.apiUrl) {
      await reply("财经快讯还没有接入新闻源，请联系管理员完成配置。");
      return;
    }

    try {
      const news = await deliverUnsentNews(config, config.news.apiUrl, getTargetKey(message), async (items) => {
        await replyForward(formatNewsMessages(items), {
          title: "财经快讯",
          source: "miz news",
          summary: `${items.length} 条新消息`,
        });
      });

      if (news.length === 0) {
        await reply(createNoNewsMessage());
      }
    } catch (error) {
      logger.error("plugin", "news request failed", error);
      await reply("新闻源暂时没有响应，过一会儿再刷新吧。");
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
