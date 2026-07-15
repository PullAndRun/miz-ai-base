import type { MizPlugin } from "@/plugins";
import { createNoNewsMessage, deliverUnsentNews, formatNewsMessages } from "@/news";

const newsPlugin: MizPlugin = {
  name: "news",
  commands: ["news", "新闻"],
  description: "看看当前会话里还没读过的财经快讯。\n用法：miz news",
  async handle({ command, config, logger, message, reply, replyForward }) {
    if (command.args) {
      await reply("新闻暂时不能按关键词筛选，直接发 miz news 就行。");
      return;
    }

    if (!config.news.apiUrl) {
      await reply("新闻源还没配置好，请联系管理员处理。");
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
      await reply("新闻源刚才没响应，过一会儿再刷新吧。");
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
