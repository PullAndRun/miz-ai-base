import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BiliGift } from "@/bili-gift";
import {
  BILI_GIFT_RARITIES,
  drawBiliGiftLottery,
  formatBiliGiftLotteryCard,
  formatBiliGiftLotteryValue,
  getBiliGiftRarity,
} from "@/bili-gift-lottery";
import {
  formatGiftLotteryDrawDate,
  type GiftLotteryDailyDraw,
  type GiftLotteryDrawStore,
} from "@/gift-lottery-draws";
import lotteryPlugin, { handleBiliGiftLotteryCommand } from "../plugins/lottery";

type GameForwardNode = string | Array<{ type: string; data: { file?: string } }>;

const createGift = (gift: Pick<BiliGift, "id" | "name"> & Partial<BiliGift>): BiliGift => ({
  price: 0,
  coinType: "gold",
  description: "",
  effectId: 0,
  webp: "",
  gif: "",
  png: "",
  frame: "",
  effectMp4: "",
  ...gift,
});

const freeGift = createGift({
  id: 1,
  name: "辣条",
  price: 100,
  coinType: "silver",
  gif: "礼物动图/1_辣条.gif",
});
const rareGift = createGift({
  id: 2,
  name: "棒棒糖",
  price: 9_999,
  coinType: "gold",
  effectId: 11,
  gif: "礼物动图/2_棒棒糖.gif",
  effectMp4: "全屏特效/在用/2_棒棒糖_11.mp4",
});
const epicGift = createGift({
  id: 3,
  name: "冰淇淋",
  price: 10_000,
  coinType: "gold",
  effectId: 12,
  gif: "礼物动图/3_冰淇淋.gif",
  effectMp4: "全屏特效/在用/3_冰淇淋_12.mp4",
});
const legendaryGift = createGift({
  id: 4,
  name: "告白花束",
  price: 200_000,
  coinType: "gold",
  effectId: 13,
  gif: "礼物动图/4_告白花束.gif",
  effectMp4: "全屏特效/在用/4_告白花束_13.mp4",
});
const mythicGift = createGift({
  id: 5,
  name: "为你摘星",
  price: 1_000_000,
  coinType: "gold",
  description: "心中有日月，手可摘星辰",
  effectId: 14,
  gif: "礼物动图/5_为你摘星.gif",
  effectMp4: "全屏特效/在用/5_为你摘星_14.mp4",
});

/** 同名礼物的两个版本，用来验证取 ID 最大的一版。 */
const sameNameGifts: readonly BiliGift[] = [
  createGift({
    id: 25,
    name: "小电视飞船",
    price: 1_245_000,
    coinType: "gold",
    effectId: 8,
    gif: "礼物动图/25_小电视飞船.gif",
    effectMp4: "全屏特效/在用/25_小电视飞船_8.mp4",
  }),
  createGift({
    id: 34_998,
    name: "小电视飞船",
    price: 2_999_000,
    coinType: "gold",
    effectId: 2_200,
    gif: "礼物动图/34998_小电视飞船.gif",
    effectMp4: "全屏特效/在用/34998_小电视飞船_2200.mp4",
  }),
];

const gifts: readonly BiliGift[] = [
  freeGift,
  rareGift,
  epicGift,
  legendaryGift,
  mythicGift,
  ...sameNameGifts,
];

const createSequenceRandom = (values: readonly number[]) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
};

const createLogger = () => {
  const entries: string[] = [];
  return {
    entries,
    logger: {
      debug: (_context: string, message: string) => entries.push(`debug:${message}`),
      info: (_context: string, message: string) => entries.push(`info:${message}`),
      warn: (_context: string, message: string) => entries.push(`warn:${message}`),
      error: (_context: string, message: string) => entries.push(`error:${message}`),
    },
  };
};

const createMemoryStore = () => {
  const records = new Map<string, GiftLotteryDailyDraw>();
  const released: string[] = [];
  const keyOf = (key: { userId: string; drawDate: string }) => `${key.userId}:${key.drawDate}`;
  const store: GiftLotteryDrawStore = {
    find: async (key) => records.get(keyOf(key)),
    claim: async (draw) => {
      if (records.has(keyOf(draw))) {
        return "taken";
      }
      records.set(keyOf(draw), { giftId: draw.giftId, giftName: draw.giftName });
      return "claimed";
    },
    release: async (key) => {
      records.delete(keyOf(key));
      released.push(keyOf(key));
    },
  };
  return { records, released, store };
};

describe("Bilibili gift lottery", () => {
  test("classifies gifts into five value tiers", () => {
    expect(getBiliGiftRarity(freeGift).label).toBe("普通");
    expect(getBiliGiftRarity(rareGift).label).toBe("稀有");
    expect(getBiliGiftRarity(epicGift).label).toBe("史诗");
    expect(getBiliGiftRarity(legendaryGift).label).toBe("传说");
    expect(getBiliGiftRarity(mythicGift).label).toBe("神话");
    expect(getBiliGiftRarity(createGift({ id: 6, name: "无价格" })).label).toBe("普通");
    expect(getBiliGiftRarity(createGift({
      id: 7,
      name: "刚好一百电池",
      price: 10_000,
      coinType: "gold",
    })).label).toBe("史诗");
  });

  test("keeps rarity probabilities normalised", () => {
    expect(BILI_GIFT_RARITIES).toHaveLength(5);
    expect(BILI_GIFT_RARITIES.reduce((total, rarity) => total + rarity.probability, 0)).toBeCloseTo(1, 10);
  });

  test("picks the tier with the rolled probability band", () => {
    const draw = (roll: number) => drawBiliGiftLottery(gifts, { random: createSequenceRandom([roll, 0]) })!;

    expect(draw(0).rarity.label).toBe("普通");
    expect(draw(0.29).rarity.label).toBe("普通");
    expect(draw(0.31).rarity.label).toBe("稀有");
    expect(draw(0.61).rarity.label).toBe("史诗");
    expect(draw(0.83).rarity.label).toBe("传说");
    expect(draw(0.99).rarity.label).toBe("神话");
    expect(draw(0.99).gift.name).toBe("为你摘星");
    expect(draw(0.99).media?.relativePath).toBe("全屏特效/在用/5_为你摘星_14.mp4");
  });

  test("takes the largest id when one name has several gift ids", () => {
    const draw = drawBiliGiftLottery(sameNameGifts, { random: createSequenceRandom([0.99, 0]) })!;

    expect(draw.gift.name).toBe("小电视飞船");
    expect(draw.gift.id).toBe(34_998);
    expect(draw.media?.relativePath).toBe("全屏特效/在用/34998_小电视飞船_2200.mp4");
  });

  test("returns no draw for an empty library", () => {
    expect(drawBiliGiftLottery([])).toBeUndefined();
  });

  test("formats battery values", () => {
    expect(formatBiliGiftLotteryValue(mythicGift)).toBe("10000 电池");
    expect(formatBiliGiftLotteryValue(rareGift)).toBe("99.99 电池");
    expect(formatBiliGiftLotteryValue(freeGift)).toBe("免费");
  });

  test("writes a game-style reveal card instead of a gift data card", () => {
    const draw = drawBiliGiftLottery(gifts, { random: createSequenceRandom([0.95, 0]) })!;
    const card = formatBiliGiftLotteryCard(draw);

    expect(card).toContain("🎰 迷子的礼物抽奖");
    expect(card).toContain("👑👑👑👑👑 神话！");
    expect(card).toContain("你抽到了「为你摘星」");
    expect(card).toContain("💰 价值 10000 电池");
    expect(card).toContain("🎉 神话降临，全群都该看看它！");
    // 抽奖是独立小游戏，不展示礼物台账里的字段和官方介绍。
    expect(card).not.toContain("· 礼物 ID：");
    expect(card).not.toContain("· 价格：");
    expect(card).not.toContain("· 特效 ID：");
    expect(card).not.toContain("· 展示素材：");
    expect(card).not.toContain("心中有日月");
  });

  test("shows free gifts as free instead of a value", () => {
    const draw = drawBiliGiftLottery([freeGift], { random: createSequenceRandom([0, 0]) })!;
    const card = formatBiliGiftLotteryCard(draw);

    expect(card).toContain("🌱 普通！");
    expect(card).toContain("💰 免费礼物");
    expect(card).not.toContain("电池");
  });

  test("describes the mini game and the daily limit in the help menu", () => {
    expect(lotteryPlugin.name).toBe("lottery");
    expect(lotteryPlugin.commands).toEqual(["lottery", "抽奖"]);
    expect(lotteryPlugin.description).toContain("迷子的小游戏");
    expect(lotteryPlugin.description).toContain("miz 抽奖");
    expect(lotteryPlugin.description).toContain("每人每天只能抽一次");
  });

  test("formats the local draw date", () => {
    expect(formatGiftLotteryDrawDate(new Date(2026, 8, 14, 23, 59))).toBe("2026-09-14");
    expect(formatGiftLotteryDrawDate(new Date(2026, 8, 15, 0, 1))).toBe("2026-09-15");
  });
});

describe("lottery plugin", () => {
  let directory = "";
  let replies: unknown[] = [];
  let forwards: Array<{ messages: readonly GameForwardNode[]; options: unknown }> = [];

  const runLottery = async (
    args: string,
    options: {
      random?: () => number;
      now?: Date;
      userId?: string;
      store?: GiftLotteryDrawStore;
    } = {},
  ) => {
    const { logger, entries } = createLogger();
    await handleBiliGiftLotteryCommand({
      args,
      commandPrefix: "miz",
      logger,
      message: { text: "miz 抽奖", groupId: 100, userId: options.userId ?? "1", raw: {} },
      reply: async (message: unknown) => {
        replies.push(message);
      },
      replyForwardWithoutRetry: async (messages: readonly unknown[], forwardOptions?: unknown) => {
        forwards.push({ messages: messages as readonly GameForwardNode[], options: forwardOptions });
      },
    }, {
      directory,
      random: options.random,
      now: options.now,
      store: options.store,
    });
    return entries;
  };

  beforeEach(async () => {
    replies = [];
    forwards = [];
    directory = await mkdtemp(path.join(os.tmpdir(), "miz-lottery-"));
    await mkdir(path.join(directory, "全屏特效/在用"), { recursive: true });
    await mkdir(path.join(directory, "礼物动图"), { recursive: true });
    for (const gift of gifts) {
      await writeFile(path.join(directory, gift.gif), `gif-${gift.id}`);
      if (gift.effectMp4) {
        await writeFile(path.join(directory, gift.effectMp4), `bytes-${gift.id}`);
      }
    }
    await writeFile(path.join(directory, "素材索引.json"), JSON.stringify({
      gifts: gifts.map((gift) => ({
        id: gift.id,
        name: gift.name,
        price: gift.price,
        coinType: gift.coinType,
        desc: gift.description,
        effectId: gift.effectId,
        gif: gift.gif,
        effectMp4: gift.effectMp4,
      })),
    }), "utf8");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("forwards the drawn gift with its effect and records the day", async () => {
    const { records, store } = createMemoryStore();
    await runLottery("", {
      random: createSequenceRandom([0.95, 0]),
      now: new Date(2026, 8, 14, 10, 0),
      store,
    });

    expect(replies).toEqual([]);
    expect(forwards).toHaveLength(1);
    const [forward] = forwards;
    const card = forward!.messages[0] as string;
    const mediaNode = forward!.messages[1] as Array<{ type: string; data: { file?: string } }>;

    expect(forward!.messages).toHaveLength(2);
    expect(card).toContain("👑👑👑👑👑 神话！");
    expect(card).toContain("你抽到了「为你摘星」");
    expect(mediaNode).toEqual([{
      type: "video",
      data: { file: `base64://${Buffer.from("bytes-5").toString("base64")}` },
    }]);
    expect(forward!.options).toEqual({
      title: "👑👑👑👑👑 神话 · 为你摘星",
      source: "miz 抽奖",
      summary: "抽到「为你摘星」· 10000 电池",
      timeoutMs: 300_000,
    });
    expect(records.get("1:2026-09-14")).toEqual({ giftId: 5, giftName: "为你摘星" });
  });

  test("refuses a second draw on the same day and allows the next day", async () => {
    const { store } = createMemoryStore();
    const now = new Date(2026, 8, 14, 10, 0);
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now, store });
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now, store });

    expect(forwards).toHaveLength(1);
    expect(String(replies[0])).toContain("今天已经抽过啦");
    expect(String(replies[0])).toContain("为你摘星");

    await runLottery("", {
      random: createSequenceRandom([0.95, 0]),
      now: new Date(2026, 8, 15, 8, 0),
      store,
    });
    expect(forwards).toHaveLength(2);
  });

  test("reports an already claimed day when the claim loses a race", async () => {
    const { store } = createMemoryStore();
    const now = new Date(2026, 8, 14, 10, 0);
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now, store });
    replies = [];
    await runLottery("", {
      random: createSequenceRandom([0.95, 0]),
      now,
      store: {
        find: async () => undefined,
        claim: store.claim,
        release: store.release,
      },
    });

    expect(forwards).toHaveLength(1);
    expect(String(replies[0])).toContain("今天已经抽过啦");
  });

  test("still draws when the daily lookup fails", async () => {
    const entries = await runLottery("", {
      random: createSequenceRandom([0.95, 0]),
      now: new Date(2026, 8, 14, 10, 0),
      store: {
        find: async () => {
          throw new Error("database down");
        },
        claim: async () => "claimed",
        release: async () => {},
      },
    });

    expect(forwards).toHaveLength(1);
    expect(entries).toContain("warn:bilibili gift lottery daily lookup failed");
  });

  test("gives the daily chance back when the result cannot be read", async () => {
    const { records, released, store } = createMemoryStore();
    await rm(path.join(directory, "全屏特效/在用/5_为你摘星_14.mp4"), { force: true });
    await runLottery("", {
      random: createSequenceRandom([0.95, 0]),
      now: new Date(2026, 8, 14, 10, 0),
      store,
    });

    expect(String(replies[0])).toContain("素材读不出来");
    expect(records.size).toBe(0);
    expect(released).toEqual(["1:2026-09-14"]);
  });

  test("gives the daily chance back when the forward fails", async () => {
    const { records, store } = createMemoryStore();
    const { logger } = createLogger();
    await handleBiliGiftLotteryCommand({
      args: "",
      commandPrefix: "miz",
      logger,
      message: { text: "miz 抽奖", groupId: 100, userId: "1", raw: {} },
      reply: async (message: unknown) => {
        replies.push(message);
      },
      replyForwardWithoutRetry: async () => {
        throw Object.assign(new Error("send failed"), { code: "E_API_TIMEOUT" });
      },
    }, {
      directory,
      now: new Date(2026, 8, 14, 10, 0),
      random: createSequenceRandom([0.95, 0]),
      store,
    });

    expect(String(replies[0])).toContain("超时");
    expect(records.size).toBe(0);
  });

  test("rejects extra arguments", async () => {
    const { store } = createMemoryStore();
    await runLottery("十连", { store });

    expect(String(replies[0])).toContain("用法：miz 抽奖");
    expect(String(replies[0])).toContain("不用再加参数");
    expect(forwards).toEqual([]);
  });

  test("tells the admin when the material library is unavailable", async () => {
    const { store } = createMemoryStore();
    await rm(path.join(directory, "素材索引.json"), { force: true });
    const entries = await runLottery("", { store });

    expect(String(replies[0])).toContain("礼物素材库暂时读不到");
    expect(entries).toContain("error:bilibili gift library unavailable for lottery");
  });
});
