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
});
