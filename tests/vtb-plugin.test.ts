import { describe, expect, test } from "bun:test";
import type { MizConfig } from "@/config";
import { createVtbPlugin } from "../plugins/vtb";

const createConfig = (subscriptions: MizConfig["vtb"]["subscriptions"]) => ({
  vtb: {
    enabled: true,
    subscriptionWhitelistUserIds: [],
    subscriptions,
  },
} as unknown as MizConfig);

const adminMessage = {
  groupId: 100,
  userId: 1,
  raw: { sender: { role: "admin" } },
};

describe("VTB subscription commands", () => {
  test("list reads subscriptions persisted after the runtime snapshot", async () => {
    const staleConfig = createConfig([{ groupId: 100, streamers: ["旧主播"] }]);
    const latestConfig = createConfig([{ groupId: 100, streamers: ["旧主播", "新主播"] }]);
    let replyText = "";
    const plugin = createVtbPlugin({
      loadCurrentConfig: async () => latestConfig,
    });

    await plugin.handle!({
      command: { name: "vtb", args: "list", raw: "vtb list" },
      config: staleConfig,
      message: adminMessage,
      reply: async (message: unknown) => {
        replyText = String(message);
      },
    } as never);

    expect(replyText).toContain("旧主播");
    expect(replyText).toContain("新主播");
    expect(replyText).toContain("2 位主播");
  });

  test("unsubscribe keeps database tracking when a newer subscription still uses the streamer", async () => {
    const staleConfig = createConfig([{ groupId: 100, streamers: ["同一主播"] }]);
    const latestConfig = createConfig([{ groupId: 200, streamers: ["同一主播"] }]);
    let repositoryLoads = 0;
    const plugin = createVtbPlugin({
      loadCurrentConfig: async () => latestConfig,
      removeSubscription: async () => ({ changed: true, streamers: [] }),
      getRepository: async () => {
        repositoryLoads += 1;
        return { deleteStreamerByName: async () => true } as never;
      },
    });

    await plugin.handle!({
      command: { name: "vtb", args: "unsubscribe 同一主播", raw: "vtb unsubscribe 同一主播" },
      config: staleConfig,
      message: adminMessage,
      logger: { info: () => undefined },
      reply: async () => undefined,
    } as never);

    expect(repositoryLoads).toBe(0);
  });

  test("list shows whether each streamer has at-all enabled", async () => {
    const config = createConfig([{
      groupId: 100,
      streamers: ["主播甲", "主播乙"],
      atAllStreamers: ["主播乙"],
    }]);
    let replyText = "";
    const plugin = createVtbPlugin({ loadCurrentConfig: async () => config });

    await plugin.handle!({
      command: { name: "vtb", args: "list", raw: "vtb list" },
      config,
      message: adminMessage,
      reply: async (message: unknown) => {
        replyText = String(message);
      },
    } as never);

    expect(replyText).toContain("主播甲（开播 @全体成员：否）");
    expect(replyText).toContain("主播乙（开播 @全体成员：是）");
  });

  test("atall command updates a subscribed streamer", async () => {
    const config = createConfig([{ groupId: 100, streamers: ["主播甲"] }]);
    const calls: unknown[][] = [];
    let replyText = "";
    const plugin = createVtbPlugin({
      setAtAllStreamer: async (...args) => {
        calls.push(args);
        return { changed: true, subscribed: true, atAllStreamers: ["主播甲"] };
      },
    });

    await plugin.handle!({
      command: { name: "vtb", args: "atall enable 主播甲", raw: "vtb atall enable 主播甲" },
      config,
      message: adminMessage,
      logger: { info: () => undefined },
      reply: async (message: unknown) => {
        replyText = String(message);
      },
    } as never);

    expect(calls).toEqual([[100, "主播甲", true]]);
    expect(replyText).toContain("已开启 主播甲");
  });

  test("publishes the latest subscriptions after a successful subscribe", async () => {
    const staleConfig = createConfig([]);
    const latestConfig = createConfig([{ groupId: 100, streamers: ["新主播"] }]);
    const changes: Array<{ groupId: string | number; subscriptions: MizConfig["vtb"]["subscriptions"] }> = [];
    const plugin = createVtbPlugin({
      loadCurrentConfig: async () => latestConfig,
      addSubscription: async () => ({ changed: true, streamers: ["新主播"] }),
      getRepository: async () => ({
        findStreamerByName: async () => ({ name: "新主播", mid: "1" }),
      }) as never,
      notifySubscriptionChange: (change) => changes.push(change),
    });

    await plugin.handle!({
      command: { name: "vtb", args: "subscribe 新主播", raw: "vtb subscribe 新主播" },
      config: staleConfig,
      message: adminMessage,
      logger: { info: () => undefined },
      reply: async () => undefined,
    } as never);

    expect(changes).toEqual([{ groupId: 100, subscriptions: latestConfig.vtb.subscriptions }]);
  });
});
