import { describe, expect, test } from "bun:test";
import type { MizConfig } from "@/config";
import { createVtbPlugin } from "../plugins/vtb";

const createConfig = (subscriptions: MizConfig["vtb"]["subscriptions"]) => ({
  vtb: {
    enabled: true,
    adminWhitelistUserIds: [],
    subscriptions,
  },
} as unknown as MizConfig);

const adminMessage = {
  groupId: 100,
  userId: 1,
  raw: { sender: { role: "admin" } },
};

const privateMessage = {
  userId: 2,
  raw: {},
};

const groupMessage = {
  groupId: 100,
  userId: 1,
  raw: {},
};

describe("VTB subscription commands", () => {
  test.each([
    "subscribe 主播甲",
    "unsubscribe 主播甲",
    "dynamic enable 主播甲",
    "dynamicatall enable 主播甲",
    "atall enable 主播甲",
  ])("rejects removed compatibility command: %s", async (args) => {
    let replyText = "";
    const plugin = createVtbPlugin();
    await plugin.handle!({
      command: { name: "vtb", args, raw: `vtb ${args}` },
      config: createConfig([]),
      message: adminMessage,
      reply: async (message: unknown) => {
        replyText = String(message);
      },
    } as never);
    expect(replyText).toContain("没用对");
  });

  test("rejects a live-room URL before querying Bilibili", async () => {
    const config = createConfig([]);
    config.vtb.userApiUrl = "https://example.test/users?name=";
    config.vtb.liveApiUrl = "https://example.test/live";
    config.vtb.webUrl = "https://www.example.test";
    config.vtb.liveWebUrl = "https://live.example.test";
    let repositoryLoads = 0;
    let replyText = "";
    const plugin = createVtbPlugin({
      getRepository: async () => {
        repositoryLoads += 1;
        return {} as never;
      },
    });

    await plugin.handle!({
      command: {
        name: "vtb",
        args: "live https://live.bilibili.com/1978987236",
        raw: "vtb live https://live.bilibili.com/1978987236",
      },
      config,
      message: groupMessage,
      reply: async (message: unknown) => {
        replyText = String(message);
      },
    } as never);

    expect(replyText).toContain("昵称");
    expect(replyText).toContain("不是直播间链接");
    expect(repositoryLoads).toBe(0);
  });

  test("requires the VTB admin whitelist for Bilibili login", async () => {
    const config = createConfig([]);
    config.vtb.adminWhitelistUserIds = [1];
    let replyText = "";
    const plugin = createVtbPlugin();

    await plugin.handle!({
      command: { name: "vtb", args: "login", raw: "vtb login" },
      config,
      message: privateMessage,
      reply: async (message: unknown) => {
        replyText = String(message);
      },
    } as never);

    expect(replyText.length).toBeGreaterThan(0);
  });

  test("requires the VTB admin whitelist for Bilibili logout", async () => {
    const config = createConfig([]);
    config.vtb.adminWhitelistUserIds = [1];
    let replyText = "";
    const plugin = createVtbPlugin();

    await plugin.handle!({
      command: { name: "vtb", args: "logout", raw: "vtb logout" },
      config,
      message: privateMessage,
      reply: async (message: unknown) => {
        replyText = String(message);
      },
    } as never);

    expect(replyText.length).toBeGreaterThan(0);
  });

  test.each(["login", "logout"])("allows VTB %s only in private chat", async (type) => {
    const config = createConfig([]);
    config.vtb.adminWhitelistUserIds = [1];
    let replyText = "";
    const plugin = createVtbPlugin();

    await plugin.handle!({
      command: { name: "vtb", args: type, raw: `vtb ${type}` },
      config,
      message: groupMessage,
      reply: async (message: unknown) => {
        replyText = String(message);
      },
    } as never);

    expect(replyText).toContain("私聊");
  });

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

  test("list shows only enabled settings in a readable grouped format", async () => {
    const config = createConfig([{
      groupId: 100,
      streamers: ["主播甲", "主播乙"],
      atAllStreamers: ["主播乙"],
      dynamicStreamers: ["主播乙"],
      dynamicAtAllStreamers: ["主播乙"],
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

    expect(replyText).toContain("📺 本群已订阅 2 位主播：\n1. 主播甲\n   · 直播推送\n\n2. 主播乙\n   · 直播推送\n   · 动态推送\n   · 开播 @全体成员\n   · 动态 @全体成员");
    expect(replyText).not.toContain("动态推送：否");
    expect(replyText).not.toContain("动态 @全体成员：否");
    expect(replyText).not.toContain("开播 @全体成员：否");
    expect(replyText).not.toContain("订阅状态：");
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
      command: { name: "vtb", args: "atall live enable 主播甲", raw: "vtb atall live enable 主播甲" },
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

  test("dynamic subscription can be added for a subscribed streamer", async () => {
    const config = createConfig([{ groupId: 100, streamers: ["主播甲"] }]);
    const calls: unknown[][] = [];
    let replyText = "";
    const plugin = createVtbPlugin({
      addSubscription: async (...args) => {
        calls.push(args);
        return { changed: true, subscribed: true, dynamicStreamers: ["主播甲"] };
      },
      loadCurrentConfig: async () => config,
      getRepository: async () => ({ findStreamerByName: async () => ({ name: "主播甲", mid: "1" }) } as never),
    });

    await plugin.handle!({
      command: { name: "vtb", args: "subscribe dynamic 主播甲", raw: "vtb subscribe dynamic 主播甲" },
      config,
      message: adminMessage,
      logger: { info: () => undefined },
      reply: async (message: unknown) => {
        replyText = String(message);
      },
    } as never);

    expect(calls).toEqual([[100, "主播甲", "dynamic"]]);
    expect(replyText).toContain("动态推送");
  });

  test("dynamic subscription accepts a VTB whitelist user but rejects ordinary members", async () => {
    const config = createConfig([{ groupId: 100, streamers: ["主播甲"] }]);
    config.vtb.adminWhitelistUserIds = [99];
    let calls = 0;
    const plugin = createVtbPlugin({
      addSubscription: async () => {
        calls += 1;
        return { changed: true, subscribed: true, dynamicStreamers: [] };
      },
      loadCurrentConfig: async () => config,
      getRepository: async () => ({ findStreamerByName: async () => ({ name: "主播甲", mid: "1" }) } as never),
    });

    await plugin.handle!({
      command: { name: "vtb", args: "subscribe dynamic 主播甲", raw: "vtb subscribe dynamic 主播甲" },
      config,
      message: { groupId: 100, userId: 99, raw: {} },
      logger: { info: () => undefined },
      reply: async () => undefined,
    } as never);
    expect(calls).toBe(1);

    await plugin.handle!({
      command: { name: "vtb", args: "subscribe dynamic 主播甲", raw: "vtb subscribe dynamic 主播甲" },
      config,
      message: { groupId: 100, userId: 98, raw: {} },
      logger: { info: () => undefined },
      reply: async () => undefined,
    } as never);
    expect(calls).toBe(1);
  });

  test("typed atall command toggles dynamic @all independently", async () => {
    const config = createConfig([{ groupId: 100, streamers: ["主播甲"] }]);
    const calls: unknown[][] = [];
    const plugin = createVtbPlugin({
      setDynamicAtAllStreamer: async (...args) => {
        calls.push(args);
        return { changed: true, subscribed: true, dynamicAtAllStreamers: ["主播甲"] };
      },
      loadCurrentConfig: async () => config,
    });

    await plugin.handle!({
      command: { name: "vtb", args: "atall dynamic enable 主播甲", raw: "vtb atall dynamic enable 主播甲" },
      config,
      message: adminMessage,
      logger: { info: () => undefined },
      reply: async () => undefined,
    } as never);

    expect(calls).toEqual([[100, "主播甲", true]]);
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
      command: { name: "vtb", args: "subscribe live 新主播", raw: "vtb subscribe live 新主播" },
      config: staleConfig,
      message: adminMessage,
      logger: { info: () => undefined },
      reply: async () => undefined,
    } as never);

    expect(changes).toEqual([{ groupId: 100, subscriptions: latestConfig.vtb.subscriptions }]);
  });

  test("explains why a subscription failed and how to fix the config", async () => {
    const config = createConfig([]);
    let replyText = "";
    const plugin = createVtbPlugin({
      addSubscription: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });

    await plugin.handle!(
      {
        command: { name: "vtb", args: "subscribe live 新主播", raw: "vtb subscribe live 新主播" },
        config,
        message: adminMessage,
        logger: { error: () => undefined },
        reply: async (message: unknown) => {
          replyText = String(message);
        },
      } as never,
    );

    expect(replyText).toBe("订阅没成功（主播“新主播”）：VTB 订阅名单没能读写。请检查 config/vtb.toml，再试一次。");
  });
});
