import type { MizPlugin } from "@/plugins";
import { isWhitelistedUser } from "@/group-permissions";
import { summarizeError } from "@/errors";
import { isRecallTimeoutError } from "@/gateway";

const MAX_RECALL_COUNT = 20;

const recallPlugin: MizPlugin = {
  name: "recall",
  commands: ["recall", "撤回"],
  description: [
    "撤回迷子在当前群最近发送的消息，仅限撤回白名单使用。",
    "用法：miz recall [数量]",
    "例如：miz recall 2；中文命令：miz 撤回 2",
  ].join("\n"),
  async handle({ command, config, gateway, logger, message, reply }) {
    if (message.groupId === undefined) {
      await reply("撤回只对群消息生效，请到需要撤回消息的群里使用这个命令。");
      return;
    }
    const parsedCount = parseRecallCount(command.args);
    if (!parsedCount.ok) {
      await reply(parsedCount.reason);
      return;
    }
    if (!isWhitelistedUser(message.userId, config.recall.whitelistUserIds)) {
      await reply("只有撤回白名单中的成员可以让迷子撤回自己的群消息。");
      return;
    }

    try {
      const result = await gateway.recallLastGroupMessage(message.groupId, parsedCount.count);
      if (result.status === "not_found") {
        await reply("迷子暂时没有记录到本群可撤回的消息。");
        return;
      }

      const timeoutFailures = result.failures.filter((failure) => isRecallTimeoutError(failure.error));
      const otherFailures = result.failures.filter((failure) => !isRecallTimeoutError(failure.error));
      logger.info("plugin", "recent bot group messages recall completed", {
        groupId: message.groupId,
        requestedCount: parsedCount.count,
        recalledMessageIds: result.recalledMessageIds,
        timeoutMessageIds: timeoutFailures.map((failure) => failure.messageId),
        failedMessages: otherFailures.map((failure) => ({
          messageId: failure.messageId,
          error: summarizeError(failure.error),
        })),
        operatorId: message.userId,
      });
      await reply(formatRecallResult(
        parsedCount.count,
        result.recalledMessageIds.length,
        timeoutFailures.length,
        otherFailures.length,
      ));
    } catch (error) {
      logger.warn("plugin", "last bot group message could not be recalled", {
        groupId: message.groupId,
        operatorId: message.userId,
        error: summarizeError(error),
      });
      await reply(
        isRecallTimeoutError(error)
          ? "撤回请求超时了。那条消息可能已超过可撤回时限，也可能是网关没有及时响应。"
          : "撤回失败了。可能是迷子当前没有撤回权限，或消息已经超过可撤回时限。",
      );
    }
  },
};

export default recallPlugin;

export { isRecallTimeoutError } from "@/gateway";

export const parseRecallCount = (args: string):
  | Readonly<{ ok: true; count: number }>
  | Readonly<{ ok: false; reason: string }> => {
  const value = args.trim();
  if (!value) {
    return { ok: true, count: 1 };
  }
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    return { ok: false, reason: "撤回数量需要是正整数，例如：miz recall 2。" };
  }

  const count = Number(value);
  return count <= MAX_RECALL_COUNT
    ? { ok: true, count }
    : { ok: false, reason: `一次最多撤回 ${MAX_RECALL_COUNT} 条消息。` };
};

export const formatRecallResult = (
  requestedCount: number,
  recalledCount: number,
  timeoutCount: number,
  failedCount: number,
) => {
  const foundCount = recalledCount + timeoutCount + failedCount;
  if (timeoutCount === 0 && failedCount === 0) {
    if (recalledCount === 1 && requestedCount === 1) {
      return "迷子已经撤回了自己在本群的最后一条发言。";
    }
    return foundCount < requestedCount
      ? `本群只记录到 ${recalledCount} 条可撤回消息，已经全部撤回。`
      : `迷子已经撤回了自己在本群最近的 ${recalledCount} 条发言。`;
  }

  return [
    recalledCount > 0 ? `已成功撤回 ${recalledCount} 条。` : "没有消息撤回成功。",
    ...(timeoutCount > 0 ? [`${timeoutCount} 条已超过可撤回时限或撤回请求超时。`] : []),
    ...(failedCount > 0 ? [`${failedCount} 条因权限或其他原因撤回失败。`] : []),
    ...(foundCount < requestedCount ? [`迷子只记录到自己在本群最近发送的 ${foundCount} 条消息。`] : []),
  ].join("\n");
};
