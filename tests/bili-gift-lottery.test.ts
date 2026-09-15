import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BiliGift } from "@/bili-gift";
import {
  BILI_GIFT_RARITIES,
  createBiliGiftLotteryLeaderboardMessage,
  drawBiliGiftLottery,
  formatBiliGiftLotteryCard,
  getBiliGiftLotteryCoins,
  getBiliGiftRarity,
} from "@/bili-gift-lottery";
import {
  formatGiftLotteryDrawDate,
  type GiftLotteryDailyDraw,
  type GiftLotteryDrawStore,
} from "@/gift-lottery-draws";
import lotteryPlugin, {
  handleBiliGiftLotteryCommand,
  parseBiliGiftLotteryArguments,
} from "../plugins/lottery";
import { createMp4VideoFixture, createNalSample } from "./support/mp4-fixture";

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

/** 每个礼物的特效视频内容不同，方便断言发出的是抽中礼物的素材。 */
const createEffectVideo = (giftId: number) =>
  createMp4VideoFixture({ samples: [createNalSample(0x65, 8 + (giftId % 16))] });

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

/** 同名礼物的免费新版与付费旧版，用来验证计价取最高电池价值。 */
const sameNameValueGifts: readonly BiliGift[] = [
  createGift({
    id: 35_541,
    name: "bilibili星跃",
    price: 1_000_000,
    coinType: "gold",
    effectId: 5_494,
    gif: "礼物动图/35541_bilibili星跃.gif",
    effectMp4: "全屏特效/在用/35541_bilibili星跃_5494.mp4",
  }),
  createGift({
    id: 35_659,
    name: "bilibili星跃",
    price: 0,
    coinType: "silver",
    effectId: 5_780,
    gif: "礼物动图/35659_bilibili星跃.gif",
    effectMp4: "全屏特效/在用/35659_bilibili星跃_5780.mp4",
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
  const balances = new Map<string, number>();
  const released: string[] = [];
  const keyOf = (key: { groupId: string; userId: string; drawDate: string }) =>
    `${key.groupId}:${key.userId}:${key.drawDate}`;
  const coinKeyOf = (key: { groupId: string; userId: string }) => `${key.groupId}:${key.userId}`;
  const store: GiftLotteryDrawStore = {
    find: async (key) => records.get(keyOf(key)),
    claim: async (draw) => {
      if (records.has(keyOf(draw))) {
        return "taken";
      }
      records.set(keyOf(draw), {
        giftId: draw.giftId,
        giftName: draw.giftName,
        coins: draw.coins,
      });
      return "claimed";
    },
    release: async (key) => {
      records.delete(keyOf(key));
      released.push(keyOf(key));
    },
    readCoins: async (key) => balances.get(coinKeyOf(key)) ?? 0,
    addCoins: async (key, amount) => {
      balances.set(coinKeyOf(key), (balances.get(coinKeyOf(key)) ?? 0) + amount);
    },
    listTopCoins: async (groupId, limit) => [...balances.entries()]
      .filter(([key]) => key.startsWith(groupId + ":"))
      .map(([key, coins]) => ({ userId: key.slice(groupId.length + 1), coins }))
      .sort((left, right) => right.coins - left.coins || left.userId.localeCompare(right.userId))
      .slice(0, limit),
    readCoinRank: async (key) => {
      const coins = balances.get(coinKeyOf(key));
      if (coins === undefined) {
        return undefined;
      }
      const above = [...balances.entries()]
        .filter(([otherKey, otherCoins]) =>
          otherKey.startsWith(key.groupId + ":") && otherCoins > coins)
        .length;
      return { rank: above + 1, coins };
    },
  };
  return { records, balances, released, store };
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

    // 免费礼物被剔除后，原普通档的概率段顺延到稀有档。
    expect(draw(0).rarity.label).toBe("稀有");
    expect(draw(0.29).rarity.label).toBe("稀有");
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

  test("values same-name gifts by the highest battery value", () => {
    const draw = drawBiliGiftLottery(
      sameNameValueGifts,
      { random: createSequenceRandom([0.99, 0]) },
    )!;

    // 最新版仍是 0 价格的 silver 版本，用于展示；计价使用旧版 gold 的 10000 电池。
    expect(draw.gift.id).toBe(35_659);
    expect(draw.media?.relativePath).toBe("全屏特效/在用/35659_bilibili星跃_5780.mp4");
    expect(draw.rarity.label).toBe("神话");
    expect(draw.batteryValue).toBe(10_000);
    expect(draw.coins).toBe(10_000);
    expect(formatBiliGiftLotteryCard(draw, { totalCoins: 10_000 }))
      .toContain("💰 获得 10000 迷币 · 累计 10000");
  });

  test("returns no draw for an empty library", () => {
    expect(drawBiliGiftLottery([])).toBeUndefined();
  });

  test("converts gift value into mi coins", () => {
    expect(getBiliGiftLotteryCoins(mythicGift)).toBe(10_000);
    expect(getBiliGiftLotteryCoins(rareGift)).toBe(100);
    // 免费礼物没有明码标价，不再用 1 迷币兜底。
    expect(getBiliGiftLotteryCoins(freeGift)).toBe(0);
  });

  test("writes a game-style reveal card instead of a gift data card", () => {
    const draw = drawBiliGiftLottery(gifts, { random: createSequenceRandom([0.95, 0]) })!;
    const card = formatBiliGiftLotteryCard(draw, { totalCoins: 12_500 });

    expect(card).toContain("🎰 迷子的礼物抽奖");
    expect(card).toContain("👑👑👑👑👑 神话！");
    expect(card).toContain("你抽到了「为你摘星」");
    expect(card).toContain("💰 获得 10000 迷币 · 累计 12500");
    expect(card).toContain("🎉 神话降临，全群都该看看它！");
    // 抽奖是独立小游戏，不展示礼物台账里的字段和官方介绍。
    expect(card).not.toContain("· 礼物 ID：");
    expect(card).not.toContain("· 价格：");
    expect(card).not.toContain("· 特效 ID：");
    expect(card).not.toContain("· 展示素材：");
    expect(card).not.toContain("心中有日月");
  });

  test("puts the winner nickname in the reveal card", () => {
    const draw = drawBiliGiftLottery(gifts, { random: createSequenceRandom([0.95, 0]) })!;

    const named = formatBiliGiftLotteryCard(draw, { totalCoins: 100, winnerName: "爱的战士" });
    // 名字顶到第一行，合并转发的预览里也能看到。
    expect(named.split("\n")[0]).toBe("🎰 爱的战士 的礼物抽奖");
    expect(named).toContain("抽到了「为你摘星」");
    expect(named).not.toContain("你抽到了");
    // 没有昵称时仍然用「你」称呼。
    expect(formatBiliGiftLotteryCard(draw, { totalCoins: 100 }))
      .toContain("你抽到了「为你摘星」");
  });

  test("excludes free and zero-price gifts from the lottery pool", () => {
    const zeroPriceGift = createGift({
      id: 8,
      name: "零价礼物",
      price: 0,
      coinType: "gold",
    });

    expect(drawBiliGiftLottery([freeGift, zeroPriceGift], {
      random: createSequenceRandom([0, 0]),
    })).toBeUndefined();
    // 免费或 0 价格礼物不折算成保底迷币，也不进入抽奖池。
    expect(getBiliGiftLotteryCoins(freeGift)).toBe(0);
  });

  test("keeps gifts explicitly priced at exactly one battery", () => {
    const paidGift = createGift({
      id: 9,
      name: "一电池礼物",
      price: 100,
      coinType: "gold",
    });
    const draw = drawBiliGiftLottery([paidGift], { random: createSequenceRandom([0, 0]) })!;

    expect(draw.gift.name).toBe("一电池礼物");
    expect(draw.rarity.label).toBe("稀有");
    expect(draw.batteryValue).toBe(1);
    expect(draw.coins).toBe(1);
  });

  test("does not use 1 coin as a fallback for non-exact prices", () => {
    const belowOneBattery = createGift({
      id: 10,
      name: "低于一电池",
      price: 40,
      coinType: "gold",
    });
    const roundsToOne = createGift({
      id: 11,
      name: "近似一电池",
      price: 140,
      coinType: "gold",
    });

    expect(getBiliGiftLotteryCoins(belowOneBattery)).toBe(0);
    expect(getBiliGiftLotteryCoins(roundsToOne)).toBe(0);
    expect(drawBiliGiftLottery([belowOneBattery, roundsToOne], {
      random: createSequenceRandom([0, 0]),
    })).toBeUndefined();
  });

  test("describes the mini game, the leaderboard and the daily limit", () => {
    expect(lotteryPlugin.name).toBe("lottery");
    expect(lotteryPlugin.commands).toEqual(["lottery", "抽奖"]);
    expect(lotteryPlugin.description).toContain("迷子的小游戏");
    expect(lotteryPlugin.description).toContain("miz 抽奖 榜单");
    expect(lotteryPlugin.description).toContain("每个群每人每天只能抽一次");
    expect(lotteryPlugin.description).toContain("迷币");
    expect(lotteryPlugin.description).toContain("免费礼物不参与");
    expect(lotteryPlugin.description).toContain("1 电池");
  });

  test("accepts the English command arguments", () => {
    expect(parseBiliGiftLotteryArguments("")).toBe("draw");
    expect(parseBiliGiftLotteryArguments("   ")).toBe("draw");
    expect(parseBiliGiftLotteryArguments("榜单")).toBe("leaderboard");
    expect(parseBiliGiftLotteryArguments("leaderboard")).toBe("leaderboard");
    expect(parseBiliGiftLotteryArguments(" LeaderBoard ")).toBe("leaderboard");
    expect(parseBiliGiftLotteryArguments("LEADERBOARD")).toBe("leaderboard");
    expect(parseBiliGiftLotteryArguments("十连")).toBeUndefined();
    expect(parseBiliGiftLotteryArguments("rank")).toBeUndefined();
  });

  test("renders the mi coin leaderboard as plain text", () => {
    const message = createBiliGiftLotteryLeaderboardMessage([
      { userId: "1001", coins: 12_000 },
      { userId: "1002", coins: 8_000 },
      { userId: "1003", coins: 6_000 },
      { userId: "1004", coins: 500 },
    ]);

    expect(typeof message).toBe("string");
    expect(message).toContain("🏆 本群迷币榜 · 前 10 名");
    expect(message).toContain("🥇 1001 · 12000 迷币");
    expect(message).toContain("🥈 1002 · 8000 迷币");
    expect(message).toContain("🥉 1003 · 6000 迷币");
    expect(message).toContain("4. 1004 · 500 迷币");
    // 有昵称就显示昵称，没有就退回 QQ 号。
    const named = createBiliGiftLotteryLeaderboardMessage([
      { userId: "1005", coins: 300, name: "小电视" },
      { userId: "1006", coins: 200, name: "   " },
    ]);
    expect(named).toContain("🥇 小电视 · 300 迷币");
    expect(named).toContain("🥈 1006 · 200 迷币");
    // 榜单只列文字，不 at 任何人。
    expect(message).not.toContain("@");
    expect(message).not.toContain("CQ:at");
  });

  test("keeps the leaderboard to ten entries and handles an empty group", () => {
    const entries = Array.from({ length: 13 }, (_unused, index) => ({
      userId: String(2_000 + index),
      coins: 1_000 - index,
    }));
    const message = createBiliGiftLotteryLeaderboardMessage(entries);

    expect(message.split("\n").filter((line) => line.endsWith("迷币"))).toHaveLength(10);

    const empty = createBiliGiftLotteryLeaderboardMessage([], { commandPrefix: "迷子" });
    expect(empty).toContain("本群还没有人抽过奖");
    expect(empty).toContain("迷子 抽奖");
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
      groupId?: number;
      privateChat?: boolean;
      store?: GiftLotteryDrawStore;
      gateway?: { getGroupMemberName: (groupId: string, userId: string) => Promise<string | undefined> };
    } = {},
  ) => {
    const { logger, entries } = createLogger();
    await handleBiliGiftLotteryCommand({
      args,
      commandPrefix: "miz",
      gateway: (options.gateway ?? { getGroupMemberName: async () => undefined }) as never,
      logger,
      message: {
        text: "miz 抽奖",
        ...(options.privateChat ? {} : { groupId: options.groupId ?? 100 }),
        userId: options.userId ?? "1",
        raw: {},
      },
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
        await writeFile(path.join(directory, gift.effectMp4), createEffectVideo(gift.id));
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
    const { records, balances, store } = createMemoryStore();
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
    expect(card).toContain("💰 获得 10000 迷币 · 累计 10000");
    expect(mediaNode).toEqual([{
      type: "video",
      data: { file: `base64://${createEffectVideo(5).toString("base64")}` },
    }]);
    expect(forward!.options).toEqual({
      title: "👑👑👑👑👑 神话 · 为你摘星",
      source: "miz 抽奖",
      summary: "👑👑👑👑👑 神话 · +10000 迷币",
      timeoutMs: 300_000,
    });
    expect(records.get("100:1:2026-09-14")).toEqual({
      giftId: 5,
      giftName: "为你摘星",
      coins: 10_000,
    });
    expect(balances.get("100:1")).toBe(10_000);
  });

  test("falls back to the gift animation when the effect video cannot be played", async () => {
    const { store } = createMemoryStore();
    await writeFile(
      path.join(directory, "全屏特效/在用/5_为你摘星_14.mp4"),
      createMp4VideoFixture({ chunkOffsetShift: -8 }),
    );
    const entries = await runLottery("", {
      random: createSequenceRandom([0.95, 0]),
      now: new Date(2026, 8, 14, 10, 0),
      store,
    });

    const mediaNode = forwards[0]!.messages[1] as Array<{ type: string; data: { file?: string } }>;
    expect(mediaNode).toEqual([{
      type: "image",
      data: { file: `base64://${Buffer.from("gif-5").toString("base64")}` },
    }]);
    expect(entries).toContain("warn:bilibili gift lottery effect video is unplayable");
  });

  test("announces the winner nickname in the draw result", async () => {
    const { store } = createMemoryStore();
    await runLottery("", {
      random: createSequenceRandom([0.95, 0]),
      now: new Date(2026, 8, 14, 10, 0),
      store,
      gateway: {
        getGroupMemberName: async (_groupId, userId) => (userId === "1" ? "爱的战士" : undefined),
      },
    });

    const card = forwards[0]!.messages[0] as string;
    expect(card.split("\n")[0]).toBe("🎰 爱的战士 的礼物抽奖");
    expect(card).toContain("抽到了「为你摘星」");
    expect(card).toContain("💰 获得 10000 迷币 · 累计 10000");
    expect(forwards[0]!.options).toEqual({
      title: "爱的战士 抽到了「为你摘星」",
      source: "miz 抽奖",
      summary: "👑👑👑👑👑 神话 · +10000 迷币",
      timeoutMs: 300_000,
    });
  });

  test("tells the member what they already drew today", async () => {
    const { store } = createMemoryStore();
    const now = new Date(2026, 8, 14, 10, 0);
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now, store });
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now, store });

    expect(String(replies[0])).toContain("你今天在本群已经抽过啦");
    expect(String(replies[0])).toContain("抽到的是「为你摘星」（+10000 迷币）");
  });

  test("refuses a second draw for the same person and lets others draw", async () => {
    const { store } = createMemoryStore();
    const now = new Date(2026, 8, 14, 10, 0);
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now, store });
    // 同一个人当天再抽不行。
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now, store });

    expect(forwards).toHaveLength(1);
    expect(String(replies[0])).toContain("你今天在本群已经抽过啦");
    expect(String(replies[0])).toContain("为你摘星");

    // 同群另一个人当天照样能抽。
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now, userId: "2", store });
    expect(forwards).toHaveLength(2);

    // 第二天本来的人又能抽。
    await runLottery("", {
      random: createSequenceRandom([0.95, 0]),
      now: new Date(2026, 8, 15, 8, 0),
      store,
    });
    expect(forwards).toHaveLength(3);
  });

  test("gives every group its own daily draw", async () => {
    const { store } = createMemoryStore();
    const now = new Date(2026, 8, 14, 10, 0);
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now, store });
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now, groupId: 200, store });
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now, groupId: 300, store });

    expect(forwards).toHaveLength(3);
    expect(replies).toEqual([]);
  });

  test("treats a private chat as its own daily slot", async () => {
    const { store } = createMemoryStore();
    const now = new Date(2026, 8, 14, 10, 0);
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now, privateChat: true, store });
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now, privateChat: true, store });
    await runLottery("", {
      random: createSequenceRandom([0.95, 0]),
      now,
      privateChat: true,
      userId: "2",
      store,
    });

    expect(forwards).toHaveLength(2);
    expect(String(replies[0])).toContain("今天已经抽过啦");
    expect(String(replies[0])).not.toContain("本群");
  });

  test("accumulates mi coins per person in each group", async () => {
    const { balances, store } = createMemoryStore();
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now: new Date(2026, 8, 14, 10, 0), store });
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now: new Date(2026, 8, 15, 10, 0), store });
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now: new Date(2026, 8, 16, 10, 0), userId: "2", store });
    await runLottery("", {
      random: createSequenceRandom([0.95, 0]),
      now: new Date(2026, 8, 14, 10, 0),
      groupId: 200,
      store,
    });

    expect(balances.get("100:1")).toBe(20_000);
    expect(balances.get("100:2")).toBe(10_000);
    expect(balances.get("200:1")).toBe(10_000);
    const cards = forwards.map((forward) => forward.messages[0]);
    expect(cards.some((card) => String(card).includes("累计 10000"))).toBe(true);
    expect(cards.some((card) => String(card).includes("累计 20000"))).toBe(true);
  });

  test("reports an already claimed day when the claim loses a race", async () => {
    const { store } = createMemoryStore();
    const now = new Date(2026, 8, 14, 10, 0);
    await runLottery("", { random: createSequenceRandom([0.95, 0]), now, store });
    replies = [];
    await runLottery("", {
      random: createSequenceRandom([0.95, 0]),
      now,
      store: { ...store, find: async () => undefined },
    });

    expect(forwards).toHaveLength(1);
    expect(String(replies[0])).toContain("已经抽过啦");
  });

  test("still draws when the daily lookup fails", async () => {
    const entries = await runLottery("", {
      random: createSequenceRandom([0.95, 0]),
      now: new Date(2026, 8, 14, 10, 0),
      store: {
        ...createMemoryStore().store,
        find: async () => {
          throw new Error("database down");
        },
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
    expect(released).toEqual(["100:1:2026-09-14"]);
  });

  test("gives the daily chance back when the forward fails", async () => {
    const { records, balances, store } = createMemoryStore();
    const { logger } = createLogger();
    await handleBiliGiftLotteryCommand({
      args: "",
      commandPrefix: "miz",
      gateway: { getGroupMemberName: async () => undefined } as never,
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
    expect(balances.size).toBe(0);
  });

  test("rejects arguments other than the leaderboard", async () => {
    const { store } = createMemoryStore();
    await runLottery("十连", { store });

    expect(String(replies[0])).toContain("用法：miz 抽奖");
    expect(String(replies[0])).toContain("只支持「榜单」");
    expect(forwards).toEqual([]);
  });

  test("shows the group leaderboard without mentioning anyone", async () => {
    const { balances, store } = createMemoryStore();
    balances.set("100:1", 12_000);
    balances.set("100:2", 8_000);
    balances.set("100:3", 500);
    await runLottery("榜单", { userId: "3", store });

    const text = String(replies[0]);
    expect(text).toContain("🏆 本群迷币榜 · 前 10 名");
    expect(text).toContain("🥇 1 · 12000 迷币");
    expect(text).toContain("🥈 2 · 8000 迷币");
    expect(text).toContain("🥉 3 · 500 迷币");
    expect(text).not.toContain("@");
    // 自己就在榜上，就不再重复报排名。
    expect(text).not.toContain("你的排名");
    expect(forwards).toEqual([]);
  });

  test("shows group nicknames instead of QQ numbers", async () => {
    const { balances, store } = createMemoryStore();
    balances.set("100:1", 12_000);
    balances.set("100:2", 8_000);
    balances.set("100:3", 500);
    await runLottery("榜单", {
      userId: "3",
      store,
      gateway: {
        getGroupMemberName: async (_groupId, userId) => (userId === "2" ? undefined : "群友" + userId),
      },
    });

    const text = String(replies[0]);
    expect(text).toContain("🥇 群友1 · 12000 迷币");
    // 昵称取不到时退回 QQ 号。
    expect(text).toContain("🥈 2 · 8000 迷币");
    expect(text).toContain("🥉 群友3 · 500 迷币");
    expect(text).not.toContain("@");
  });

  test("falls back to QQ numbers when the nickname lookup fails", async () => {
    const { balances, store } = createMemoryStore();
    balances.set("100:1", 700);
    await runLottery("榜单", {
      userId: "1",
      store,
      gateway: {
        getGroupMemberName: async () => {
          throw new Error("napcat down");
        },
      },
    });

    expect(String(replies[0])).toContain("🥇 1 · 700 迷币");
  });

  test("appends the viewer rank when outside the top ten", async () => {
    const { balances, store } = createMemoryStore();
    for (let index = 0; index < 12; index += 1) {
      balances.set("100:" + (100 + index), 1_000 - index);
    }
    balances.set("100:999", 5);
    await runLottery("榜单", { userId: "999", store });

    expect(String(replies[0])).toContain("你的排名：第 13 名 · 5 迷币");
  });

  test("invites members without coins to join the leaderboard", async () => {
    const { balances, store } = createMemoryStore();
    balances.set("100:1", 500);
    await runLottery("榜单", { userId: "77", store });

    expect(String(replies[0])).toContain("你还没有迷币");
  });

  test("explains an empty leaderboard", async () => {
    const { store } = createMemoryStore();
    await runLottery("榜单", { store });

    expect(String(replies[0])).toContain("本群还没有人抽过奖");
    expect(String(replies[0])).toContain("miz 抽奖");
  });

  test("shows the leaderboard through the English command", async () => {
    const { balances, store } = createMemoryStore();
    balances.set("100:1", 900);
    await runLottery("leaderboard", { store });

    const text = String(replies[0]);
    expect(text).toContain("🏆 本群迷币榜");
    expect(text).toContain("🥇 1 · 900 迷币");
  });

  test("keeps the leaderboard in groups only", async () => {
    const { store } = createMemoryStore();
    await runLottery("榜单", { privateChat: true, store });

    expect(String(replies[0])).toContain("迷币榜是按群统计的");
  });

  test("does not spend the daily draw on the leaderboard", async () => {
    const { records, store } = createMemoryStore();
    await runLottery("榜单", { store });
    await runLottery("", { random: createSequenceRandom([0.95, 0]), store });

    expect(records.size).toBe(1);
    expect(forwards).toHaveLength(1);
  });

  test("reports an unreadable leaderboard", async () => {
    const { store } = createMemoryStore();
    const entries = await runLottery("榜单", {
      userId: "5",
      store: {
        ...store,
        listTopCoins: async () => {
          throw new Error("database down");
        },
      },
    });

    expect(String(replies[0])).toContain("迷币榜暂时读不到");
    expect(entries).toContain("warn:bilibili gift lottery leaderboard failed");
  });

  test("tells the admin when the material library is unavailable", async () => {
    const { store } = createMemoryStore();
    await rm(path.join(directory, "素材索引.json"), { force: true });
    const entries = await runLottery("", { store });

    expect(String(replies[0])).toContain("礼物素材库暂时读不到");
    expect(entries).toContain("error:bilibili gift library unavailable for lottery");
  });
});
