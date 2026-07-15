import type { MizPlugin } from "@/plugins";
import { canManageGroupFeature } from "@/group-permissions";
import { getVtbRepository } from "@/vtb";

const MAX_FAQ_KEYWORD_LENGTH = 50;

const faqPlugin: MizPlugin = {
  name: "faq",
  commands: ["faq", "问答"],
  description: [
    "把群里常问的事情收进小词典，以后丢一个关键词就能翻到答案。",
    "查询答案：miz faq 关键词",
    "查看词条：miz faq list",
    "添加词条：miz faq add 关键词 答案",
    "修改词条：miz faq edit 关键词 新答案",
    "删除词条：miz faq delete 关键词",
    "添加、修改和删除需要群管理或 FAQ 白名单权限。",
  ].join("\n"),
  async handle({ command, config, logger, message, reply, replyForward }) {
    if (message.groupId === undefined || message.userId === undefined) {
      await reply("群问答是每个群自己的小词典，回到对应群里查询或维护吧。");
      return;
    }

    const action = parseFaqAction(command.args);
    if (!action) {
      await reply(createFaqUsage());
      return;
    }

    try {
      const repository = await getVtbRepository(config);
      if (action.type === "query") {
        const entry = await repository.findFaqEntry(message.groupId, action.keyword);
        await reply(entry
          ? `📖 ${entry.keyword}\n\n${entry.answer}`
          : `小词典里还没有“${action.keyword}”。发 miz faq list 看看已经收录了什么吧。`);
        return;
      }

      if (action.type === "list") {
        const entries = await repository.listFaqEntries(message.groupId);
        if (entries.length === 0) {
          await reply("📖 这个群的小词典还是空的。群管理可以用 miz faq add 关键词 答案 收录第一条。");
          return;
        }
        const chunks = chunk(entries.map((entry) => entry.keyword), 20)
          .map((keywords, index) => `第 ${index + 1} 组\n${keywords.join("、")}`);
        await replyForward(chunks, {
          title: "📖 群问答小词典",
          source: "miz faq",
          summary: `${entries.length} 个可查询词条`,
        });
        return;
      }

      if (!canManageGroupFeature(message.raw, message.userId, config.faq.manageWhitelistUserIds)) {
        await reply("翻词典可以直接用；收录、修改或删除词条需要群管理或 FAQ 白名单权限。");
        return;
      }

      if (action.type === "delete") {
        const result = await repository.deleteFaqEntry(message.groupId, action.keyword);
        await reply(result.count === 1
          ? `词条“${action.keyword}”已经从小词典里移除。`
          : `没找到词条“${action.keyword}”，它可能已经先一步离开了。`);
        return;
      }

      if (action.answer.length > config.faq.maxAnswerLength) {
        await reply(`这段答案有点长啦，收在 ${config.faq.maxAnswerLength} 个字以内，群友读起来会更轻松。`);
        return;
      }

      if (action.type === "edit") {
        const result = await repository.updateFaqEntry(message.groupId, action.keyword, action.answer);
        await reply(result.count === 1
          ? `✏️ 词条“${action.keyword}”已经换上新答案。`
          : `小词典里还没有“${action.keyword}”。想新增的话，发 miz faq add ${action.keyword} 答案`);
        return;
      }

      const result = await repository.createFaqEntry({
        groupId: message.groupId,
        keyword: action.keyword,
        answer: action.answer,
        creatorId: message.userId,
        maximumEntries: config.faq.maxEntries,
      });
      if (result.status === "created") {
        logger.info("plugin", "faq entry created", { groupId: message.groupId, keyword: action.keyword });
        await reply(`📚 “${action.keyword}”收录完成！以后发 miz faq ${action.keyword} 就能翻到。`);
      } else if (result.status === "exists") {
        await reply(`“${action.keyword}”已经住在小词典里啦。想改答案的话，发 miz faq edit ${action.keyword} 新答案`);
      } else {
        await reply(`小词典已经装满 ${config.faq.maxEntries} 条啦。先清理不用的词条，再收录新的吧。`);
      }
    } catch (error) {
      logger.error("plugin", "faq command failed", error);
      await reply("这次没能把答案收进小词典，稍后再试一次吧。");
    }
  },
};

export default faqPlugin;

export const parseFaqAction = (args: string) => {
  const normalized = args.trim();
  if (!normalized) return undefined;
  if (normalized === "list") return { type: "list" as const };

  const remove = /^delete\s+(\S+)$/.exec(normalized);
  if (remove) {
    const keyword = normalizeKeyword(remove[1]);
    return keyword ? { type: "delete" as const, keyword } : undefined;
  }

  const write = /^(add|edit)\s+(\S+)\s+([\s\S]+)$/.exec(normalized);
  if (write) {
    const keyword = normalizeKeyword(write[2]);
    const answer = write[3].trim();
    if (!keyword || !answer) return undefined;
    return { type: write[1] as "add" | "edit", keyword, answer };
  }

  const keyword = normalizeKeyword(normalized);
  return keyword ? { type: "query" as const, keyword } : undefined;
};

const normalizeKeyword = (keyword: string) => {
  const normalized = keyword.trim().toLowerCase();
  return normalized && !/\s/.test(normalized) && normalized.length <= MAX_FAQ_KEYWORD_LENGTH
    ? normalized
    : undefined;
};

const chunk = <T>(values: readonly T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
};

const createFaqUsage = () => [
  "📖 群问答小词典这样用：",
  "查询：miz faq 关键词",
  "查看全部关键词：miz faq list",
  "添加：miz faq add 关键词 答案",
  "修改：miz faq edit 关键词 新答案",
  "删除：miz faq delete 关键词",
  "关键词请写成一个不带空格的短词。",
].join("\n");
