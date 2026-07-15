import type { MizPlugin } from "@/plugins";
import { canManageGroupFeature } from "@/group-permissions";
import { getVtbRepository } from "@/vtb";

const MAX_FAQ_KEYWORD_LENGTH = 50;

const faqPlugin: MizPlugin = {
  name: "faq",
  commands: ["faq", "问答"],
  description: [
    "保存群里常问的问题，用一个关键词就能快速找到答案。",
    "查询答案：miz faq 关键词",
    "查看词条：miz faq list",
    "添加词条：miz faq add 关键词 答案",
    "修改词条：miz faq edit 关键词 新答案",
    "删除词条：miz faq delete 关键词",
    "添加、修改和删除需要群管理或 FAQ 白名单权限。",
  ].join("\n"),
  async handle({ command, config, logger, message, reply, replyForward }) {
    if (message.groupId === undefined || message.userId === undefined) {
      await reply("群问答会按群保存，请到对应群里查询或维护。");
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
          ? `【${entry.keyword}】\n${entry.answer}`
          : `还没有“${action.keyword}”这个词条。可以发 miz faq list 看看现有关键词。`);
        return;
      }

      if (action.type === "list") {
        const entries = await repository.listFaqEntries(message.groupId);
        if (entries.length === 0) {
          await reply("群问答还是空的。群管理可以用 miz faq add 关键词 答案 添加第一条。");
          return;
        }
        const chunks = chunk(entries.map((entry) => entry.keyword), 20)
          .map((keywords, index) => `第 ${index + 1} 组\n${keywords.join("、")}`);
        await replyForward(chunks, {
          title: "群问答关键词",
          source: "miz faq",
          summary: `${entries.length} 个可查询词条`,
        });
        return;
      }

      if (!canManageGroupFeature(message.raw, message.userId, config.faq.manageWhitelistUserIds)) {
        await reply("查询问答可以直接使用；维护词条需要群管理或 FAQ 白名单权限。");
        return;
      }

      if (action.type === "delete") {
        const result = await repository.deleteFaqEntry(message.groupId, action.keyword);
        await reply(result.count === 1
          ? `词条“${action.keyword}”已删除。`
          : `没找到“${action.keyword}”这个词条，它可能已经被删掉了。`);
        return;
      }

      if (action.answer.length > config.faq.maxAnswerLength) {
        await reply(`这段答案有点长，请控制在 ${config.faq.maxAnswerLength} 个字以内，方便群友阅读。`);
        return;
      }

      if (action.type === "edit") {
        const result = await repository.updateFaqEntry(message.groupId, action.keyword, action.answer);
        await reply(result.count === 1
          ? `词条“${action.keyword}”已更新。`
          : `还没有“${action.keyword}”这个词条。新增请用 miz faq add ${action.keyword} 答案`);
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
        await reply(`词条“${action.keyword}”已收录。以后发送 miz faq ${action.keyword} 就能查到。`);
      } else if (result.status === "exists") {
        await reply(`“${action.keyword}”已经有答案了。需要改动的话，请用 miz faq edit ${action.keyword} 新答案`);
      } else {
        await reply(`群问答已经存满 ${config.faq.maxEntries} 条。可以先清理不用的词条，再添加新的。`);
      }
    } catch (error) {
      logger.error("plugin", "faq command failed", error);
      await reply("群问答刚才没有保存成功。稍后再试一次，原命令可以直接重发。");
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
  "群问答这样用：",
  "查询：miz faq 关键词",
  "查看全部关键词：miz faq list",
  "添加：miz faq add 关键词 答案",
  "修改：miz faq edit 关键词 新答案",
  "删除：miz faq delete 关键词",
  "关键词请写成一个不带空格的短词。",
].join("\n");
