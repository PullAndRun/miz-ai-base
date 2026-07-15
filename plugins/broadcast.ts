import type { MizPlugin } from "@/plugins";
import { settleWithConcurrency } from "@/concurrency";
import { getGroupIds } from "@/group-ids";

const MAX_BROADCAST_LENGTH = 1_000;

const broadcastPlugin: MizPlugin = {
  name: "broadcast",
  commands: ["broadcast", "广播"],
  description: [
    "把一条消息送到机器人所在的全部群，适合发布统一公告，仅限广播白名单使用。",
    "用法：miz broadcast 广播内容",
    "广播内容最多 1000 个字符。",
  ].join("\n"),
  async handle({ command, config, gateway, logger, message, reply }) {
    const content = command.args.trim();
    if (!content) {
      await reply("📣 公告内容还空着呢。\n例如：miz broadcast 今晚 8 点维护");
      return;
    }
    if (content.length > MAX_BROADCAST_LENGTH) {
      await reply(`这条公告有 ${content.length} 个字符，有点装不下啦。精简到 1000 个字符以内再发一次吧。`);
      return;
    }

    if (!isWhitelisted(message.userId, config.broadcast.whitelistUserIds)) {
      await reply("📣 这支扩音器只对广播白名单成员开放。需要使用的话，请联系管理员。");
      return;
    }

    try {
      const groupIds = getGroupIds(await gateway.getGroupList());
      if (groupIds.length === 0) {
        await reply("暂时找不到可以接收公告的群。看看机器人是否已经进群、网关是否在线吧。");
        return;
      }

      const results = await settleWithConcurrency(
        groupIds,
        5,
        (groupId) => gateway.sendGroupMessage(groupId, content),
      );
      const failedGroupIds: Array<string | number> = [];
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          failedGroupIds.push(groupIds[index]);
          if (isMutedGroupSendError(result.reason)) {
            continue;
          }
          logger.error("plugin", "broadcast delivery failed", {
            groupId: groupIds[index],
            error: normalizeError(result.reason),
          });
        }
      }

      const sentCount = groupIds.length - failedGroupIds.length;
      logger.info("plugin", "broadcast delivered", {
        senderId: message.userId,
        sentCount,
        failedCount: failedGroupIds.length,
      });
      await reply(
        failedGroupIds.length === 0
          ? `📣 广播完成！公告已经送到 ${sentCount} 个群。`
          : `📣 公告已送到 ${sentCount} 个群，还有 ${failedGroupIds.length} 个卡在路上。可能遇到群禁言或连接异常，稍后可以再补发。`,
      );
    } catch (error) {
      logger.error("plugin", "broadcast failed", normalizeError(error));
      await reply("这次广播没能顺利送出。确认一下群禁言和连接状态，稍后再试吧。");
    }
  },
};

export default broadcastPlugin;

const isWhitelisted = (
  userId: string | number | undefined,
  whitelistUserIds: readonly (string | number)[],
) => userId !== undefined && whitelistUserIds.some((id) => String(id) === String(userId));

const normalizeError = (error: unknown) => error instanceof Error
  ? { name: error.name, message: error.message }
  : error;

const isMutedGroupSendError = (error: unknown) => {
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  const details = record.details;
  const message = [record.message, isRecord(details) ? details.message : undefined]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /全员禁言|群禁言|禁言|shut.?up|muted/i.test(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
