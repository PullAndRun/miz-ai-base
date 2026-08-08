import { describe, expect, test } from "bun:test";
import type { MizConfig } from "@/config";
import recallPlugin, { formatRecallResult, isRecallTimeoutError, parseRecallCount } from "../plugins/recall";

const createConfig = (whitelistUserIds: Array<string | number>) => ({
  recall: { whitelistUserIds },
} as MizConfig);

const createContext = ({
  userId = 123,
  groupId = 456,
  whitelistUserIds = [123],
  args = "",
  recall = async () => ({ status: "completed", recalledMessageIds: ["789"], failures: [] } as const),
}: {
  userId?: string | number;
  groupId?: string | number;
  whitelistUserIds?: Array<string | number>;
  args?: string;
  recall?: (count: number) => Promise<
    | { status: "completed"; recalledMessageIds: readonly string[]; failures: readonly { messageId: string; error: unknown }[] }
    | { status: "not_found" }
  >;
} = {}) => {
  const replies: string[] = [];
  let recallCalls = 0;
  return {
    replies,
    getRecallCalls: () => recallCalls,
    context: {
      command: { name: "recall", args, raw: `recall ${args}`.trim() },
      config: createConfig(whitelistUserIds),
      gateway: {
        recallLastGroupMessage: async (_groupId: string | number, count: number) => {
          recallCalls += 1;
          return recall(count);
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
      args: "2",
      recall: async () => ({
        status: "completed",
        recalledMessageIds: ["2"],
        failures: [{
          messageId: "1",
          error: Object.assign(new Error("API调用 delete_msg 超时"), { code: "E_API_TIMEOUT" }),
        }],
      }),
    });

    await recallPlugin.handle!(testContext.context as never);

    expect(testContext.replies[0]).toContain("已成功撤回 1 条");
    expect(testContext.replies[0]).toContain("1 条已超过可撤回时限或撤回请求超时");
    expect(isRecallTimeoutError({ details: { wording: "消息已超过撤回时限" } })).toBeTrue();
    expect(isRecallTimeoutError(new Error("permission denied"))).toBeFalse();
  });

  test("explains when this runtime has no group message to recall", async () => {
    const testContext = createContext({ recall: async () => ({ status: "not_found" }) });

    await recallPlugin.handle!(testContext.context as never);

    expect(testContext.replies[0]).toContain("没有记录到可撤回");
  });

  test("parses an optional count and rejects unsafe batch sizes", async () => {
    expect(parseRecallCount("")).toEqual({ ok: true, count: 1 });
    expect(parseRecallCount("2")).toEqual({ ok: true, count: 2 });
    expect(parseRecallCount("0")).toMatchObject({ ok: false });
    expect(parseRecallCount("1.5")).toMatchObject({ ok: false });
    expect(parseRecallCount("21")).toMatchObject({ ok: false });

    const testContext = createContext({ args: "21" });
    await recallPlugin.handle!(testContext.context as never);
    expect(testContext.getRecallCalls()).toBe(0);
    expect(testContext.replies[0]).toContain("最多撤回 20 条");
  });

  test("reports when fewer tracked messages exist than requested", () => {
    expect(formatRecallResult(3, 2, 0, 0)).toBe("本群只记录到 2 条可撤回消息，已经全部撤回。");
  });
});
