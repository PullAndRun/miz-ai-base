import type { MizPlugin } from "@/plugins";
import { createNoNewsMessage, deliverUnsentNews, formatNewsMessages } from "@/news";

const newsPlugin: MizPlugin = {
  name: "news",
  commands: ["news", "新闻"],
  description: "把当前会话里还没读过的新闻快讯送到眼前。\n用法：miz news",
  async handle({ command, config, logger, message, reply, replyForward }) {
    if (command.args) {
      await reply("📰 快讯暂时不支持关键词筛选，直接发 miz news 就能刷新。");
      return;
    }

    if (!config.news.apiUrl) {
      await reply("新闻频道还没接通，请联系管理员完成配置。");
      return;
    }

    try {
      const news = await deliverUnsentNews(config, config.news.apiUrl, getTargetKey(message), async (items) => {
        await replyForward(formatNewsMessages(items), {
          title: "📰 新闻快讯",
          source: "miz news",
          summary: `${items.length} 条新消息送达`,
        });
      });

      if (news.length === 0) {
        await reply(createNoNewsMessage());
      }
    } catch (error) {
      logger.error("plugin", "news request failed", error);
      await reply("新闻频道刚才走神了，过一会儿再刷新吧。");
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
