import type { MizPlugin } from "@/plugins";
import { settleWithConcurrency } from "@/concurrency";
import { getGroupIds } from "@/group-ids";

const MAX_BROADCAST_LENGTH = 1_000;

const broadcastPlugin: MizPlugin = {
  name: "broadcast",
  commands: ["broadcast", "广播"],
  description: [
    "向机器人所在的全部群发送公告，仅限广播白名单使用。",
    "用法：miz broadcast 广播内容",
    "广播内容最多 1000 个字符。",
  ].join("\n"),
  async handle({ command, config, gateway, logger, message, reply }) {
    const content = command.args.trim();
    if (!content) {
      await reply("还没有填写公告内容。\n用法：miz broadcast 公告内容");
      return;
    }
    if (content.length > MAX_BROADCAST_LENGTH) {
      await reply(`这条公告有 ${content.length} 个字符，最多可以发送 1000 个。请精简后再试。`);
      return;
    }

    if (!isWhitelisted(message.userId, config.broadcast.whitelistUserIds)) {
      await reply("全群公告只开放给广播白名单成员。");
      return;
    }

    try {
      const groupIds = getGroupIds(await gateway.getGroupList());
      if (groupIds.length === 0) {
        await reply("群列表是空的，公告没有发送。请检查机器人是否已经加入群聊，以及网关是否在线。");
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
          ? `公告发送完成，已送达 ${sentCount} 个群。`
          : `公告已送达 ${sentCount} 个群，另有 ${failedGroupIds.length} 个群未送达。可能是群禁言或连接异常，可以稍后补发。`,
      );
    } catch (error) {
      logger.error("plugin", "broadcast failed", normalizeError(error));
      await reply("公告没有发出去。可能是群禁言或网关连接异常，请确认状态后再试。");
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
