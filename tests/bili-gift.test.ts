import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createBiliGiftForwardMessages,
  findBiliGift,
  formatBiliGiftCard,
  formatBiliGiftPrice,
  loadBiliGiftLibrary,
  parseBiliGiftCommandArguments,
  readBiliGiftMedia,
  resolveBiliGiftMedia,
  suggestBiliGiftNames,
  type BiliGift,
} from "@/bili-gift";
import giftPlugin, { handleBiliGiftCommand } from "../plugins/gift";
import { createVtbPlugin } from "../plugins/vtb";

type GiftForwardNode = string | Array<{ type: string; data: { file?: string } }>;

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

const spaceShip = createGift({
  id: 34998,
  name: "小电视飞船",
  price: 2_999_000,
  effectId: 2200,
  description: "小电视精心打造的顶级飞船已启航！",
  gif: "礼物动图/34998_小电视飞船.gif",
  webp: "礼物动图/34998_小电视飞船.webp",
  effectMp4: "全屏特效/在用/34998_小电视飞船_2200.mp4",
});

const gifts: readonly BiliGift[] = [
  createGift({
    id: 25,
    name: "小电视飞船",
    price: 1_245_000,
    effectId: 8,
    gif: "礼物动图/25_小电视飞船.gif",
    effectMp4: "全屏特效/在用/25_小电视飞船_8.mp4",
  }),
  createGift({
    id: 33215,
    name: "小电视飞船",
    price: 2_999_000,
    effectId: 1171,
    gif: "礼物动图/33215_小电视飞船.gif",
    effectMp4: "全屏特效/在用/33215_小电视飞船_1171.mp4",
  }),
  spaceShip,
  createGift({
    id: 33070,
    name: "小电视飞船（荣耀飞船）",
    gif: "礼物动图/33070_小电视飞船（荣耀飞船）.gif",
    effectMp4: "全屏特效/在用/33070_小电视飞船（荣耀飞船）_1136.mp4",
  }),
  createGift({
    id: 30052,
    name: "冰淇淋",
    price: 100,
    gif: "礼物动图/30052_冰淇淋.gif",
  }),
  createGift({ id: 33665, name: "粉丝团灯牌", price: 1, coinType: "silver" }),
  createGift({ id: 34371, name: "粉丝团灯牌", price: 1, coinType: "silver" }),
  createGift({
    id: 30256,
    name: "Best wishes!",
    gif: "礼物动图/30256_Best wishes!.gif",
  }),
];

const createLogger = () => {
  const entries: string[] = [];
  return {
    entries,
    logger: {
      debug: (context: string, message: string) => entries.push(`debug:${message}`),
      info: (context: string, message: string) => entries.push(`info:${message}`),
      warn: (context: string, message: string) => entries.push(`warn:${message}`),
      error: (context: string, message: string) => entries.push(`error:${message}`),
    },
  };
};

describe("Bilibili gift lookup", () => {
  test("uses the largest gift ID when one name has multiple gift IDs", () => {
    const match = findBiliGift(gifts, "小电视飞船");

    expect(match?.gift).toMatchObject({ id: 34998, effectId: 2200 });
    expect(match?.sameNameGiftIds).toEqual([34998, 33215, 25]);
    expect(match?.exactName).toBe(true);
  });

  test("matches names case-insensitively and across full-width characters", () => {
    const match = findBiliGift(gifts, " ｂｅｓｔ　ｗｉｓｈｅｓ！ ");

    expect(match?.gift.id).toBe(30256);
    expect(match?.exactName).toBe(true);
  });

  test("prefers exact and prefix matches over names that merely contain the keyword", () => {
    expect(findBiliGift(gifts, "小电视")?.gift.name).toBe("小电视飞船");
    expect(findBiliGift(gifts, "荣耀")?.gift.name).toBe("小电视飞船（荣耀飞船）");
    expect(findBiliGift(gifts, "飞船")?.gift.name).toBe("小电视飞船");
  });

  test("lists alternative names for fuzzy matches", () => {
    const match = findBiliGift(gifts, "飞船");

    expect(match?.exactName).toBe(false);
    expect(match?.alternativeNames).toEqual(["小电视飞船（荣耀飞船）"]);
  });

  test("returns undefined and suggests similar names when nothing matches", () => {
    expect(findBiliGift(gifts, "不存在的礼物")).toBeUndefined();
    expect(suggestBiliGiftNames(gifts, "冰激凌")).toEqual(["冰淇淋"]);
    expect(suggestBiliGiftNames(gifts, "")).toEqual([]);
  });
});

describe("Bilibili gift media", () => {
  test("prefers the full-screen effect video and falls back to the gift animation", () => {
    expect(resolveBiliGiftMedia(spaceShip)).toEqual({
      kind: "video",
      label: "全屏特效",
      relativePath: "全屏特效/在用/34998_小电视飞船_2200.mp4",
    });
    expect(resolveBiliGiftMedia(gifts[4]!)).toEqual({
      kind: "image",
      label: "礼物动图",
      relativePath: "礼物动图/30052_冰淇淋.gif",
    });
    expect(resolveBiliGiftMedia(spaceShip, "animation")).toEqual({
      kind: "image",
      label: "礼物动图",
      relativePath: "礼物动图/34998_小电视飞船.gif",
    });
    expect(resolveBiliGiftMedia(gifts[4]!, "effect")).toBeUndefined();
    expect(resolveBiliGiftMedia(createGift({ id: 1, name: "无素材" }))).toBeUndefined();
  });

  test("formats prices with the matching coin unit", () => {
    expect(formatBiliGiftPrice(spaceShip)).toBe("2999000金瓜子（约 2999 元）");
    expect(formatBiliGiftPrice(gifts[4]!)).toBe("100金瓜子（约 0.1 元）");
    expect(formatBiliGiftPrice(gifts[5]!)).toBe("1银瓜子");
    expect(formatBiliGiftPrice(createGift({ id: 2, name: "免费礼物" }))).toBeUndefined();
  });

  test("builds a gift card with the gift data and the display effect", () => {
    const match = findBiliGift(gifts, "小电视飞船")!;
    const media = resolveBiliGiftMedia(match.gift)!;
    const [card, mediaNode] = createBiliGiftForwardMessages(match, media, "base64://AAAA") as [
      string,
      Array<{ type: string; data: { file?: string } }>,
    ];

    expect(card).toContain("🎁 小电视飞船");
    expect(card).toContain("· 礼物 ID：#34998");
    expect(card).toContain("· 价格：2999000金瓜子（约 2999 元）");
    expect(card).toContain("· 特效 ID：#2200");
    expect(card).toContain("· 同名版本：#34998、#33215、#25（共 3 版，取 ID 最大的一版）");
    expect(card).toContain("· 展示素材：全屏特效");
    expect(card).toContain("「小电视精心打造的顶级飞船已启航！」");
    expect(mediaNode).toEqual([{ type: "video", data: { file: "base64://AAAA" } }]);
  });

  test("omits gift data that the library does not provide", () => {
    const match = findBiliGift(gifts, "冰淇淋")!;
    const card = formatBiliGiftCard(match, resolveBiliGiftMedia(match.gift)!);

    expect(card).toContain("· 礼物 ID：#30052");
    expect(card).toContain("· 展示素材：礼物动图");
    expect(card).not.toContain("· 特效 ID：");
    expect(card).not.toContain("· 同名版本：");
  });

  test("mentions other matching gifts only for fuzzy matches", () => {
    const exact = findBiliGift(gifts, "小电视飞船")!;
    const fuzzy = findBiliGift(gifts, "飞船")!;

    expect(formatBiliGiftCard(exact, resolveBiliGiftMedia(exact.gift)!)).not.toContain("还有：");
    expect(formatBiliGiftCard(fuzzy, resolveBiliGiftMedia(fuzzy.gift)!)).toContain("还有：小电视飞船（荣耀飞船）");
  });

  test("parses an optional media keyword after the gift name", () => {
    expect(parseBiliGiftCommandArguments(" 小电视飞船 ")).toEqual({
      query: "小电视飞船",
      mode: "auto",
    });
    expect(parseBiliGiftCommandArguments("小电视飞船 动图")).toEqual({
      query: "小电视飞船",
      mode: "animation",
    });
    expect(parseBiliGiftCommandArguments("Best wishes! 视频")).toEqual({
      query: "Best wishes!",
      mode: "effect",
    });
    expect(parseBiliGiftCommandArguments("动图")).toEqual({ query: "动图", mode: "auto" });
    expect(parseBiliGiftCommandArguments("   ")).toEqual({ query: "", mode: "auto" });
  });
});

describe("Bilibili gift library", () => {
  let directory = "";

  const writeIndex = async (payload: unknown) => {
    await writeFile(
      path.join(directory, "素材索引.json"),
      JSON.stringify(payload),
      "utf8",
    );
  };

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "miz-gift-"));
    await mkdir(path.join(directory, "全屏特效/在用"), { recursive: true });
    await mkdir(path.join(directory, "礼物动图"), { recursive: true });
    await writeFile(path.join(directory, "全屏特效/在用/34998_小电视飞船_2200.mp4"), "video-bytes");
    await writeFile(path.join(directory, "礼物动图/30052_冰淇淋.gif"), "gif-bytes");
    await writeIndex({
      generated: "2026-09-14T00:00:00.000Z",
      gifts: [
        {
          id: 34998,
          name: "小电视飞船",
          price: 2_999_000,
          coinType: "gold",
          desc: "小电视精心打造的顶级飞船已启航！",
          effectId: 2200,
          gif: "礼物动图/34998_小电视飞船.gif",
          effectMp4: "全屏特效/在用/34998_小电视飞船_2200.mp4",
        },
        {
          id: 30052,
          name: "冰淇淋",
          price: 100,
          coinType: "gold",
          effectId: 0,
          gif: "礼物动图/30052_冰淇淋.gif",
          effectMp4: "",
        },
      ],
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("loads the index and reuses it until the file changes", async () => {
    const first = await loadBiliGiftLibrary(directory);
    const second = await loadBiliGiftLibrary(directory);

    expect(first.map((gift) => gift.id)).toEqual([34998, 30052]);
    expect(first[0]?.description).toBe("小电视精心打造的顶级飞船已启航！");
    expect(second).toBe(first);

    await writeIndex({
      gifts: [
        {
          id: 30052,
          name: "冰淇淋",
          gif: "礼物动图/30052_冰淇淋.gif",
        },
      ],
    });
    const reloaded = await loadBiliGiftLibrary(directory);

    expect(reloaded.map((gift) => gift.id)).toEqual([30052]);
    expect(reloaded).not.toBe(first);
  });

  test("reports a missing or malformed index", async () => {
    await rm(path.join(directory, "素材索引.json"), { force: true });
    await expect(loadBiliGiftLibrary(directory)).rejects.toMatchObject({
      name: "BiliGiftIndexError",
    });

    await writeFile(path.join(directory, "素材索引.json"), "{ \"gifts\": [] }", "utf8");
    await expect(loadBiliGiftLibrary(directory)).rejects.toMatchObject({
      name: "BiliGiftIndexError",
    });
  });

  test("reads media bytes and rejects missing or escaping paths", async () => {
    const media = resolveBiliGiftMedia(spaceShip)!;
    const loaded = await readBiliGiftMedia(media, directory);

    expect(loaded.size).toBe("video-bytes".length);
    expect(Buffer.from(loaded.base64, "base64").toString()).toBe("video-bytes");

    await expect(readBiliGiftMedia({
      kind: "video",
      label: "全屏特效",
      relativePath: "../secret.mp4",
    }, directory)).rejects.toMatchObject({ name: "BiliGiftIndexError" });

    const missing = resolveBiliGiftMedia(createGift({
      id: 999,
      name: "无素材",
      gif: "礼物动图/999_无素材.gif",
    }))!;
    await expect(readBiliGiftMedia(missing, directory)).rejects.toMatchObject({
      name: "BiliGiftIndexError",
    });
  });
});

describe("gift plugin", () => {
  let directory = "";
  let replies: unknown[] = [];
  let forwards: Array<{ messages: readonly GiftForwardNode[]; options: unknown }> = [];

  const createContext = (args: string, commandPrefix = "miz") => {
    const { logger, entries } = createLogger();
    return {
      entries,
      context: {
        args,
        commandPrefix,
        logger,
        reply: async (message: unknown) => {
          replies.push(message);
        },
        replyForwardWithoutRetry: async (messages: readonly unknown[], options?: unknown) => {
          forwards.push({ messages: messages as readonly GiftForwardNode[], options });
        },
      },
    };
  };

  const runGiftCommand = async (args: string, commandPrefix = "miz") => {
    const { context, entries } = createContext(args, commandPrefix);
    await handleBiliGiftCommand(context, { directory });
    return entries;
  };

  const readForward = () => {
    const forward = forwards[0]!;
    return {
      card: forward.messages[0] as string,
      mediaNode: forward.messages[1] as Array<{ type: string; data: { file?: string } }>,
      options: forward.options,
    };
  };

  beforeEach(async () => {
    replies = [];
    forwards = [];
    directory = await mkdtemp(path.join(os.tmpdir(), "miz-gift-plugin-"));
    await mkdir(path.join(directory, "全屏特效/在用"), { recursive: true });
    await mkdir(path.join(directory, "礼物动图"), { recursive: true });
    await writeFile(path.join(directory, "全屏特效/在用/34998_小电视飞船_2200.mp4"), "video-bytes");
    await writeFile(path.join(directory, "全屏特效/在用/33215_小电视飞船_1171.mp4"), "old-video-bytes");
    await writeFile(path.join(directory, "礼物动图/34998_小电视飞船.gif"), "gif-bytes");
    await writeFile(path.join(directory, "礼物动图/30052_冰淇淋.gif"), "ice-gif-bytes");
    await writeFile(path.join(directory, "素材索引.json"), JSON.stringify({
      gifts: [
        {
          id: 33215,
          name: "小电视飞船",
          effectId: 1171,
          gif: "礼物动图/34998_小电视飞船.gif",
          effectMp4: "全屏特效/在用/33215_小电视飞船_1171.mp4",
        },
        {
          id: 34998,
          name: "小电视飞船",
          price: 2_999_000,
          effectId: 2200,
          desc: "小电视精心打造的顶级飞船已启航！",
          gif: "礼物动图/34998_小电视飞船.gif",
          effectMp4: "全屏特效/在用/34998_小电视飞船_2200.mp4",
        },
        {
          id: 30052,
          name: "冰淇淋",
          price: 100,
          gif: "礼物动图/30052_冰淇淋.gif",
        },
      ],
    }), "utf8");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("forwards the gift data card together with the effect video", async () => {
    await runGiftCommand("小电视飞船");

    expect(replies).toEqual([]);
    expect(forwards).toHaveLength(1);
    const { card, mediaNode, options } = readForward();

    expect(card).toContain("🎁 小电视飞船");
    expect(card).toContain("· 礼物 ID：#34998");
    expect(card).toContain("· 价格：2999000金瓜子（约 2999 元）");
    expect(card).toContain("· 特效 ID：#2200");
    expect(card).toContain("· 同名版本：#34998、#33215（共 2 版，取 ID 最大的一版）");
    expect(card).toContain("· 展示素材：全屏特效");
    expect(mediaNode).toEqual([{
      type: "video",
      data: { file: `base64://${Buffer.from("video-bytes").toString("base64")}` },
    }]);
    expect(options).toEqual({
      title: "🎁 小电视飞船",
      source: "miz 礼物",
      summary: "全屏特效 · 礼物 #34998",
      timeoutMs: 300_000,
    });
  });

  test("forwards the gift animation when the gift has no full-screen effect", async () => {
    await runGiftCommand("冰淇淋");

    const { card, mediaNode } = readForward();
    expect(card).toContain("· 展示素材：礼物动图");
    expect(mediaNode).toEqual([{
      type: "image",
      data: { file: `base64://${Buffer.from("ice-gif-bytes").toString("base64")}` },
    }]);
  });

  test("forwards the animation when the query asks for it", async () => {
    await runGiftCommand("小电视飞船 动图");

    const { card, mediaNode } = readForward();
    expect(card).toContain("· 展示素材：礼物动图");
    expect(mediaNode).toEqual([{
      type: "image",
      data: { file: `base64://${Buffer.from("gif-bytes").toString("base64")}` },
    }]);
  });

  test("explains that a gift without effects only has an animation", async () => {
    await runGiftCommand("冰淇淋 特效");

    expect(forwards).toEqual([]);
    expect(String(replies[0])).toContain("没有全屏特效");
    expect(String(replies[0])).toContain("miz 礼物 冰淇淋 动图");
  });

  test("asks for a gift name and explains the usage", async () => {
    await runGiftCommand("");

    expect(String(replies[0])).toContain("用法：miz 礼物 礼物名");
    expect(forwards).toEqual([]);
  });

  test("uses the configured command prefix", async () => {
    await runGiftCommand("", "迷子");

    expect(String(replies[0])).toContain("用法：迷子 礼物 礼物名");
  });

  test("rejects names that are too long", async () => {
    await runGiftCommand("超".repeat(31));

    expect(String(replies[0])).toContain("最多 30 个字");
  });

  test("suggests similar gifts when the name is unknown", async () => {
    const entries = await runGiftCommand("冰激凌");

    expect(replies).toHaveLength(1);
    expect(String(replies[0])).toContain("没有叫「冰激凌」的礼物");
    expect(String(replies[0])).toContain("冰淇淋");
    expect(entries).toContain("info:bilibili gift not found");
  });

  test("tells the admin when the material library is unavailable", async () => {
    await rm(path.join(directory, "素材索引.json"), { force: true });
    const entries = await runGiftCommand("小电视飞船");

    expect(String(replies[0])).toContain("礼物素材库暂时读不到");
    expect(entries).toContain("error:bilibili gift library unavailable");
  });

  test("reports material files that cannot be read", async () => {
    await rm(path.join(directory, "全屏特效/在用/34998_小电视飞船_2200.mp4"), { force: true });
    const entries = await runGiftCommand("小电视飞船");

    expect(String(replies[0])).toContain("素材文件读不出来");
    expect(entries).toContain("error:bilibili gift media unreadable");
  });

  test("reports delivery failures without retrying the forward", async () => {
    const { logger } = createLogger();
    let sendAttempts = 0;
    await handleBiliGiftCommand({
      args: "小电视飞船",
      commandPrefix: "miz",
      logger,
      reply: async (message: unknown) => {
        replies.push(message);
      },
      replyForwardWithoutRetry: async () => {
        sendAttempts += 1;
        throw Object.assign(new Error("send failed"), { code: "E_API_TIMEOUT" });
      },
    }, { directory });

    expect(sendAttempts).toBe(1);
    expect(String(replies[0])).toContain("超时");
  });

  test("describes the command in the help menu", () => {
    expect(giftPlugin.name).toBe("gift");
    expect(giftPlugin.commands).toEqual(["gift", "礼物"]);
    expect(giftPlugin.description).toContain("miz 礼物 礼物名");
    expect(giftPlugin.description).toContain("ID 最大");
  });
});

describe("vtb gift alias", () => {
  test("forwards miz vtb gift to the gift command", async () => {
    const received: Array<{ args: string; commandPrefix: string }> = [];
    const plugin = createVtbPlugin({
      handleGiftCommand: async (context) => {
        received.push({ args: context.args, commandPrefix: context.commandPrefix });
      },
    });

    await plugin.handle!({
      command: { name: "vtb", args: "gift 小电视飞船", raw: "vtb gift 小电视飞船" },
      commandPrefix: "miz",
      config: {},
      logger: createLogger().logger,
      message: { groupId: 100, userId: 1, raw: {} },
      reply: async () => {},
      replyForwardWithoutRetry: async () => {},
    } as never);

    expect(received).toEqual([{ args: "小电视飞船", commandPrefix: "miz" }]);
  });

  test("shows the gift usage when the name is missing", async () => {
    let replyText = "";
    const plugin = createVtbPlugin();

    await plugin.handle!({
      command: { name: "vtb", args: "礼物", raw: "vtb 礼物" },
      commandPrefix: "miz",
      config: {},
      logger: createLogger().logger,
      message: { groupId: 100, userId: 1, raw: {} },
      reply: async (message: unknown) => {
        replyText = String(message);
      },
      replyForwardWithoutRetry: async () => {},
    } as never);

    expect(replyText).toContain("用法：miz 礼物 礼物名");
  });
});
