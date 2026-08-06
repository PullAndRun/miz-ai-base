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
    let added: unknown;
    let replyText = "";
    const plugin = createFf14Plugin({
      loadCurrentConfig: async () => config,
      addPriceAlert: async (alert) => {
        added = alert;
        return { changed: true, alert };
      },
      getRepository: async () => ({
        enableFf14PriceAlert: async () => false,
      } as never),
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
    let replyText = "";
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
      reply: async (message: unknown) => { replyText = String(message); },
    } as never);

    expect(replyText).toContain("禁用 · 猫(猫小胖) · 水之碎晶");
    expect(replyText).toContain("@123");
    expect(replyText).not.toContain("火之碎晶");
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
