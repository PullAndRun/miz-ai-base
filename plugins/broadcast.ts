import type { MizPlugin } from "@/plugins";
import { settleWithConcurrency } from "@/concurrency";
import { getGroupIds } from "@/group-ids";

const MAX_BROADCAST_LENGTH = 1_000;

const broadcastPlugin: MizPlugin = {
  name: "broadcast",
  commands: ["broadcast", "广播"],
  description: [
    "向机器人所在的全部群发送一条广播（仅白名单可用）。",
    "用法：miz broadcast 广播内容",
  ].join("\n"),
  async handle({ command, config, gateway, logger, message, reply }) {
    const content = command.args.trim();
    if (!content || content.length > MAX_BROADCAST_LENGTH) {
      await reply("请这样使用：miz broadcast 广播内容\n内容最多 1000 个字符，会发送到机器人所在的所有群。");
      return;
    }

    if (!isWhitelisted(message.userId, config.broadcast.whitelistUserIds)) {
      await reply("你没有群广播权限。只有配置白名单中的 QQ 号可以发送全群广播。");
      return;
    }

    try {
      const groupIds = getGroupIds(await gateway.getGroupList());
      if (groupIds.length === 0) {
        await reply("目前没有获取到可广播的群，请确认机器人已加入群聊且连接正常。");
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
          ? `广播已发送到 ${sentCount} 个群。`
          : `广播已发送到 ${sentCount} 个群；另有 ${failedGroupIds.length} 个群发送失败，请稍后重试。`,
      );
    } catch (error) {
      logger.error("plugin", "broadcast failed", normalizeError(error));
      await reply("群广播没有发送成功，请稍后重试。");
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
