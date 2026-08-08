import { describe, expect, test } from "bun:test";
import type { MizConfig } from "@/config";
import recallPlugin, { isRecallTimeoutError } from "../plugins/recall";

const createConfig = (whitelistUserIds: Array<string | number>) => ({
  recall: { whitelistUserIds },
} as MizConfig);

const createContext = ({
  userId = 123,
  groupId = 456,
  whitelistUserIds = [123],
  recall = async () => ({ status: "recalled", messageId: "789" } as const),
}: {
  userId?: string | number;
  groupId?: string | number;
  whitelistUserIds?: Array<string | number>;
  recall?: () => Promise<{ status: "recalled"; messageId: string } | { status: "not_found" }>;
} = {}) => {
  const replies: string[] = [];
  let recallCalls = 0;
  return {
    replies,
    getRecallCalls: () => recallCalls,
    context: {
      command: { name: "recall", args: "", raw: "recall" },
      config: createConfig(whitelistUserIds),
      gateway: {
        recallLastGroupMessage: async () => {
          recallCalls += 1;
          return recall();
        },
      },
      logger: { info: () => undefined, warn: () => undefined },
      message: { userId, groupId },
      reply: async (message: unknown) => {
        replies.push(String(message));
      },
    },
  };
};

describe("recall command", () => {
  test("allows a configured QQ account to recall the bot's last group message", async () => {
    const testContext = createContext({ userId: "123", whitelistUserIds: [123] });

    await recallPlugin.handle!(testContext.context as never);

    expect(testContext.getRecallCalls()).toBe(1);
    expect(testContext.replies).toEqual(["已撤回机器人在本群的最后一条发言。"]);
  });

  test("does not call the gateway for a user outside the recall whitelist", async () => {
    const testContext = createContext({ userId: 999, whitelistUserIds: [123] });

    await recallPlugin.handle!(testContext.context as never);

    expect(testContext.getRecallCalls()).toBe(0);
    expect(testContext.replies[0]).toContain("撤回白名单");
  });

  test("reports an expired or timed-out recall instead of claiming success", async () => {
    const testContext = createContext({
      recall: async () => {
        throw Object.assign(new Error("API调用 delete_msg 超时"), { code: "E_API_TIMEOUT" });
      },
    });

    await recallPlugin.handle!(testContext.context as never);

    expect(testContext.replies[0]).toContain("撤回请求超时");
    expect(isRecallTimeoutError({ details: { wording: "消息已超过撤回时限" } })).toBeTrue();
    expect(isRecallTimeoutError(new Error("permission denied"))).toBeFalse();
  });

  test("explains when this runtime has no group message to recall", async () => {
    const testContext = createContext({ recall: async () => ({ status: "not_found" }) });

    await recallPlugin.handle!(testContext.context as never);

    expect(testContext.replies[0]).toContain("没有记录到可撤回");
  });
});
