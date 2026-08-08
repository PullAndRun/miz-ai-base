import type { MizPlugin } from "@/plugins";
import { isWhitelistedUser } from "@/group-permissions";
import { summarizeError } from "@/errors";

const recallPlugin: MizPlugin = {
  name: "recall",
  commands: ["recall", "撤回"],
  description: [
    "撤回机器人在当前群最后发送的一条消息，仅限撤回白名单使用。",
    "用法：miz recall",
    "中文命令：miz 撤回",
  ].join("\n"),
  async handle({ command, config, gateway, logger, message, reply }) {
    if (message.groupId === undefined) {
      await reply("撤回只对群消息生效，请到需要撤回消息的群里使用这个命令。");
      return;
    }
    if (command.args.trim()) {
      await reply("这个命令不需要附加内容，直接发送 miz recall 或 miz 撤回即可。");
      return;
    }
    if (!isWhitelistedUser(message.userId, config.recall.whitelistUserIds)) {
      await reply("只有撤回白名单中的成员可以撤回机器人的群消息。");
      return;
    }

    try {
      const result = await gateway.recallLastGroupMessage(message.groupId);
      if (result.status === "not_found") {
        await reply("本群暂时没有记录到可撤回的机器人消息。");
        return;
      }

      logger.info("plugin", "last bot group message recalled", {
        groupId: message.groupId,
        messageId: result.messageId,
        operatorId: message.userId,
      });
      await reply("已撤回机器人在本群的最后一条发言。");
    } catch (error) {
      logger.warn("plugin", "last bot group message could not be recalled", {
        groupId: message.groupId,
        operatorId: message.userId,
        error: summarizeError(error),
      });
      await reply(
        isRecallTimeoutError(error)
          ? "撤回请求超时了。那条消息可能已超过可撤回时限，也可能是网关没有及时响应。"
          : "撤回失败了。可能是机器人没有撤回权限，或消息已经超过可撤回时限。",
      );
    }
  },
};

export default recallPlugin;

export const isRecallTimeoutError = (error: unknown) => {
  const text = collectErrorText(error).join(" ");
  return /超时|已过期|超过.{0,12}(?:撤回|时限|时间)|撤回.{0,12}(?:过期|时限)|too[ -]?old|expired|recall.{0,16}(?:time|limit)|E_API_TIMEOUT/i.test(text);
};

const collectErrorText = (value: unknown, seen = new Set<object>()): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return [];
  }

  seen.add(value);
  const record = value as Record<string, unknown>;
  return [record.name, record.message, record.code, record.wording, record.details, record.cause]
    .flatMap((item) => typeof item === "number" ? [String(item)] : collectErrorText(item, seen));
};
