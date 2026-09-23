import { describe, expect, test } from "bun:test";
import type { MizConfig } from "@/config";
import { createFf14Plugin, parseFf14Action } from "../plugins/ff14";

const createConfig = (priceAlerts: MizConfig["ff14"]["priceAlerts"] = []) => ({
  ff14: {
    manageWhitelistUserIds: [],
    priceAlerts,
  },
} as unknown as MizConfig);

const adminMessage = {
  groupId: 100,
  userId: 1,
  raw: { sender: { role: "admin" } },
};

describe("FF14 price alert commands", () => {
  test("keeps Chinese punctuation in item names", () => {
    expect(parseFf14Action("猫 发型样式：麻花辫丸子头")).toEqual({
      type: "query",
      regionKey: "猫",
      itemName: "发型样式：麻花辫丸子头",
    });
  });

  test("parses an add command with deduplicated at targets", () => {
    expect(parseFf14Action("add 猫 1000 水之碎晶 @123 @456 @123")).toEqual({
      type: "add",
      region: "猫",
      minimumPrice: 1000,
      itemName: "水之碎晶",
      atUserIds: ["123", "456"],
    });
  });

  test("adds an alert for the current group with at targets", async () => {
    const config = createConfig();
    const latestConfig = createConfig([{
      groupId: 100,
      region: "猫",
      itemName: "水之碎晶",
      minimumPrice: 1000,
      priceAlertAtUserIds: ["123"],
    }]);
    let added: unknown;
    let replyText = "";
    const appliedRevisions: number[] = [];
    const plugin = createFf14Plugin({
      loadCurrentConfig: async () => latestConfig,
      addPriceAlert: async (alert) => {
        added = alert;
        return { changed: true, alert };
      },
      getRepository: async () => ({
        enableFf14PriceAlert: async () => false,
      } as never),
      notifyAlertChange: (alerts) => appliedRevisions.push(alerts.length),
    });

    await plugin.handle!({
      command: { name: "ff14", args: "add 猫 1000 水之碎晶 @123", raw: "ff14 add 猫 1000 水之碎晶 @123" },
      config,
      message: adminMessage,
      logger: { error: () => undefined },
      reply: async (message: unknown) => { replyText = String(message); },
    } as never);

    expect(added).toEqual({
      groupId: 100,
      region: "猫",
      itemName: "水之碎晶",
      minimumPrice: 1000,
      priceAlertAtUserIds: ["123"],
    });
    expect(replyText).toContain("已添加");
    expect(replyText).toContain("@123");
    expect(appliedRevisions).toEqual([1]);
  });

  test("disables and enables only the configured item in the current group", async () => {
    const config = createConfig([{
      groupId: 100,
      region: "猫",
      itemName: "水之碎晶",
      minimumPrice: 1000,
      priceAlertAtUserIds: [],
    }]);
    const disabled = new Set<string>();
    const repository = {
      disableFf14PriceAlert: async (groupId: string | number, itemName: string) => {
        const key = `${groupId}:${itemName}`;
        const changed = !disabled.has(key);
        disabled.add(key);
        return changed;
      },
      enableFf14PriceAlert: async (groupId: string | number, itemName: string) =>
        disabled.delete(`${groupId}:${itemName}`),
      listDisabledFf14PriceAlerts: async () => [...disabled].map((key) => {
        const [groupId, itemName] = key.split(":");
        return { groupId, itemName, disabledBy: null, createdAt: new Date() };
      }),
    };
    const plugin = createFf14Plugin({
      loadCurrentConfig: async () => config,
      getRepository: async () => repository as never,
    });
    let replyText = "";
    const context = (args: string) => ({
      command: { name: "ff14", args, raw: `ff14 ${args}` },
      config,
      message: adminMessage,
      logger: { error: () => undefined },
      reply: async (message: unknown) => { replyText = String(message); },
    } as never);

    await plugin.handle!(context("disable 水之碎晶"));
    expect(disabled).toEqual(new Set(["100:水之碎晶"]));
    expect(replyText).toContain("暂时禁用");

    await plugin.handle!(context("enable 水之碎晶"));
    expect(disabled.size).toBe(0);
    expect(replyText).toContain("恢复");
  });

  test("lists only the current group's alerts and shows disabled state", async () => {
    const config = createConfig([
      {
        groupId: 100,
        region: "猫",
        itemName: "水之碎晶",
        minimumPrice: 1000,
        priceAlertAtUserIds: [123],
      },
      {
        groupId: 200,
        region: "鸟",
        itemName: "火之碎晶",
        minimumPrice: 2000,
        priceAlertAtUserIds: [],
      },
    ]);
    const forwarded: unknown[][] = [];
    const plugin = createFf14Plugin({
      loadCurrentConfig: async () => config,
      getRepository: async () => ({
        listDisabledFf14PriceAlerts: async () => [{
          groupId: "100",
          itemName: "水之碎晶",
          disabledBy: "1",
          createdAt: new Date(),
        }],
      } as never),
    });

    await plugin.handle!({
      command: { name: "ff14", args: "list", raw: "ff14 list" },
      config,
      message: { groupId: 100, userId: 2, raw: { sender: { role: "member" } } },
      reply: async () => undefined,
      replyForward: async (messages: unknown[]) => { forwarded.push(messages); },
    } as never);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toHaveLength(1);
    expect(String(forwarded[0][0])).toContain("📦 第 1–1 个商品（共 1 个）");
    expect(String(forwarded[0][0])).toContain("这组有 0 个正在关注，1 个已暂停");
    expect(String(forwarded[0][0])).toContain("1. ⏸️ 水之碎晶");
    expect(String(forwarded[0][0])).toContain("原本关注 猫小胖");
    expect(String(forwarded[0][0])).toContain("恢复后会提醒：@123");
    expect(String(forwarded[0][0])).not.toContain("火之碎晶");
  });

  test("sends one forward message with ten products in each node", async () => {
    const config = createConfig(Array.from({ length: 21 }, (_, index) => ({
      groupId: 100,
      region: "猫" as const,
      itemName: `商品${index + 1}`,
      minimumPrice: 1000 + index,
      priceAlertAtUserIds: [],
    })));
    const forwarded: Array<{ messages: unknown[]; summary: string }> = [];
    const plugin = createFf14Plugin({
      loadCurrentConfig: async () => config,
      getRepository: async () => ({
        listDisabledFf14PriceAlerts: async () => [],
      } as never),
    });

    await plugin.handle!({
      command: { name: "ff14", args: "list", raw: "ff14 list" },
      config,
      message: adminMessage,
      reply: async () => undefined,
      replyForward: async (messages: unknown[], options?: { summary?: string }) => {
        forwarded.push({ messages, summary: options?.summary ?? "" });
      },
    } as never);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].messages).toHaveLength(3);
    expect(String(forwarded[0].messages[0])).toContain("📦 第 1–10 个商品（共 21 个）");
    expect(String(forwarded[0].messages[0])).toContain("这组 10 个商品都在正常关注");
    expect(String(forwarded[0].messages[0])).toContain("商品1");
    expect(String(forwarded[0].messages[0])).toContain("商品10");
    expect(String(forwarded[0].messages[0])).not.toContain("商品11\n");
    expect(String(forwarded[0].messages[1])).toContain("📦 第 11–20 个商品（共 21 个）");
    expect(String(forwarded[0].messages[1])).toContain("商品20");
    expect(String(forwarded[0].messages[2])).toContain("📦 第 21–21 个商品（共 21 个）");
    expect(String(forwarded[0].messages[2])).toContain("商品21");
    expect(forwarded[0].summary).toBe("本群共 21 条商品推送 · 每 10 条分为一个节点");
  });

  test("does not let an ordinary member mutate group alerts", async () => {
    const config = createConfig();
    let addCalls = 0;
    const plugin = createFf14Plugin({
      loadCurrentConfig: async () => config,
      addPriceAlert: async (alert) => {
        addCalls += 1;
        return { changed: true, alert };
      },
    });
    let replyText = "";

    await plugin.handle!({
      command: { name: "ff14", args: "add 猫 1000 水之碎晶", raw: "ff14 add 猫 1000 水之碎晶" },
      config,
      message: { groupId: 100, userId: 2, raw: { sender: { role: "member" } } },
      reply: async (message: unknown) => { replyText = String(message); },
    } as never);

    expect(addCalls).toBe(0);
    expect(replyText).toContain("需要群管理");
  });
});

type BatchQueryInput =
  Omit<MizConfig["ff14"]["batchQueries"][number], "alertEnabled" | "alertAtUserIds">
  & { alertEnabled?: boolean; alertAtUserIds?: Array<string | number> };

const createBatchConfig = (
  batchQueries: BatchQueryInput[],
  manageWhitelistUserIds: MizConfig["ff14"]["manageWhitelistUserIds"] = [],
) => ({
  ff14: {
    manageWhitelistUserIds,
    priceAlerts: [],
    batchSampleSize: 5,
    batchQueries: batchQueries.map((query) => ({
      ...query,
      alertEnabled: query.alertEnabled ?? false,
      alertAtUserIds: query.alertAtUserIds ?? [],
    })),
    itemSearchApiUrl: "https://search.example.test/items/search",
    marketApiUrl: "https://universalis.example.test/api/v2",
    maxListingCount: 10,
  },
  network: { proxyUrl: "" },
} as unknown as MizConfig);

const createBatchQueryResult = (sellPrice: number | undefined) => ({
  regionKey: "猫" as const,
  regionName: "猫小胖",
  sellPrice,
  sampleSize: 5,
  items: [{
    itemName: "火之水晶",
    item: { ID: 1, Name: "火之水晶" },
    status: "ready" as const,
    lowestPrice: 90,
    referencePrice: 120,
    samples: [{ price: 90, hq: false }],
    sellable: sellPrice === undefined ? undefined : true,
  }],
});

describe("FF14 batch price command", () => {
  test("parses batch actions with an optional target group", () => {
    expect(parseFf14Action("batch")).toEqual({ type: "batch" });
    expect(parseFf14Action("批量查价")).toEqual({ type: "batch" });
    expect(parseFf14Action("查价 627836955")).toEqual({ type: "batch", targetGroupId: 627836955 });
    expect(parseFf14Action("batch 12a")).toBeUndefined();
    expect(parseFf14Action("batch 100 200")).toBeUndefined();
  });

  test("queries the current group list and forwards the sell verdict", async () => {
    const config = createBatchConfig([
      { groupId: 100, region: "猫", sellPrice: 100, itemNames: ["火之水晶", "火之碎晶"] },
    ]);
    const forwarded: Array<{ messages: unknown[]; summary: string }> = [];
    const queries: unknown[] = [];
    const plugin = createFf14Plugin({
      getRepository: async () => ({} as never),
      queryBatch: async (query) => {
        queries.push(query);
        return createBatchQueryResult(query.sellPrice);
      },
    });

    await plugin.handle!({
      command: { name: "ff14", args: "batch", raw: "ff14 batch" },
      commandPrefix: "miz",
      config,
      message: adminMessage,
      logger: { error: () => undefined, info: () => undefined },
      reply: async () => undefined,
      replyForward: async (messages: unknown[], options?: { summary?: string }) => {
        forwarded.push({ messages, summary: options?.summary ?? "" });
      },
    } as never);

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      regionKey: "猫",
      itemNames: ["火之水晶", "火之碎晶"],
      sellPrice: 100,
      sampleSize: 5,
      proxyUrl: "",
    });
    expect(forwarded).toHaveLength(1);
    expect(String(forwarded[0].messages[0])).toContain("达到售卖线 1 个");
    expect(forwarded[0].summary).toContain("共 1 个商品");
  });

  test("replies a short hint instead of a forward when nothing reaches the sell line", async () => {
    const config = createBatchConfig([{ groupId: 100, region: "猫", sellPrice: 500, itemNames: ["火之水晶"] }]);
    const forwarded: unknown[][] = [];
    let replyText = "";
    const plugin = createFf14Plugin({
      getRepository: async () => ({} as never),
      queryBatch: async () => ({
        regionKey: "猫",
        regionName: "猫小胖",
        sellPrice: 500,
        sampleSize: 5,
        items: [{
          itemName: "火之水晶",
          item: { ID: 1, Name: "火之水晶" },
          status: "ready",
          lowestPrice: 90,
          referencePrice: 120,
          samples: [{ price: 90, hq: false }],
          sellable: false,
        }],
      }),
    });

    await plugin.handle!({
      command: { name: "ff14", args: "batch", raw: "ff14 batch" },
      commandPrefix: "miz",
      config,
      message: adminMessage,
      logger: { error: () => undefined, info: () => undefined },
      reply: async (message: unknown) => { replyText = String(message); },
      replyForward: async (messages: unknown[]) => { forwarded.push(messages); },
    } as never);

    expect(forwarded).toHaveLength(0);
    expect(replyText).toContain("猫小胖");
    expect(replyText).toContain("1 个商品都没到售卖线");
    expect(replyText).toContain("先不急着上线");
  });

  test("keeps an ordinary member from pushing a batch result into another group", async () => {
    const config = createBatchConfig([{ groupId: 200, region: "猫", itemNames: ["火之水晶"] }]);
    let queryCalls = 0;
    let replyText = "";
    const plugin = createFf14Plugin({
      getRepository: async () => ({} as never),
      queryBatch: async () => {
        queryCalls += 1;
        throw new Error("batch query should not start");
      },
    });

    await plugin.handle!({
      command: { name: "ff14", args: "batch 200", raw: "ff14 batch 200" },
      commandPrefix: "miz",
      config,
      message: { groupId: 100, userId: 2, raw: { sender: { role: "member" } } },
      logger: { error: () => undefined, info: () => undefined },
      reply: async (message: unknown) => { replyText = String(message); },
    } as never);

    expect(queryCalls).toBe(0);
    expect(replyText).toContain("需要群管理或 FF14 管理白名单权限");
  });

  test("lets a whitelisted user push a batch result into the configured group", async () => {
    const config = createBatchConfig(
      [{ groupId: 200, region: "猫", sellPrice: 50, itemNames: ["火之水晶"] }],
      [1],
    );
    const sent: Array<{ groupId: unknown; messages: unknown[] }> = [];
    let replyText = "";
    const plugin = createFf14Plugin({
      getRepository: async () => ({} as never),
      queryBatch: async (query) => createBatchQueryResult(query.sellPrice),
    });

    await plugin.handle!({
      command: { name: "ff14", args: "batch 200", raw: "ff14 batch 200" },
      commandPrefix: "miz",
      config,
      gateway: {
        sendForwardMessage: async (target: { groupId?: unknown }, messages: unknown[]) => {
          sent.push({ groupId: target.groupId, messages });
          return { status: "ok" };
        },
      },
      message: { userId: 1, raw: { sender: { role: "member" } } },
      logger: { error: () => undefined, info: () => undefined },
      reply: async (message: unknown) => { replyText = String(message); },
    } as never);

    expect(sent).toHaveLength(1);
    expect(sent[0].groupId).toBe(200);
    expect(sent[0].messages).toHaveLength(2);
    expect(String(sent[0].messages[0])).toContain("达到售卖线 1 个");
    expect(String(sent[0].messages[1])).toContain("📉 前 1 条 90 · 最低 90 gil");
    expect(replyText).toContain("已把批量查价结果推到群 200");
  });
});