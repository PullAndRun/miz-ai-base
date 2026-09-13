import type { ForwardMessageContent } from "@/plugins";
import {
  createBiliGiftMediaSegment,
  formatBiliGiftAmount,
  getBiliGiftBatteryValue,
  groupBiliGiftsByName,
  resolveBiliGiftMedia,
  type BiliGift,
  type BiliGiftMedia,
} from "@/bili-gift";

export type BiliGiftRarity = Readonly<{
  key: "common" | "rare" | "epic" | "legendary" | "mythic";
  /** 1 最低、5 最高，决定揭晓时的 emoji 个数。 */
  level: number;
  label: string;
  emoji: string;
  /** 抽中该档的概率，五档之和为 1。 */
  probability: number;
  /** 抽中该档时补的一句气氛文案。 */
  flavor: string;
}>;

/** 稀有度按礼物价值分档：免费礼物是普通，越贵越稀有。 */
export const BILI_GIFT_RARITIES: readonly BiliGiftRarity[] = [
  {
    key: "common",
    level: 1,
    label: "普通",
    emoji: "🌱",
    probability: 0.3,
    flavor: "小小心意，也很可爱。",
  },
  {
    key: "rare",
    level: 2,
    label: "稀有",
    emoji: "⭐",
    probability: 0.3,
    flavor: "运气不错～",
  },
  {
    key: "epic",
    level: 3,
    label: "史诗",
    emoji: "✨",
    probability: 0.22,
    flavor: "这发有点东西！",
  },
  {
    key: "legendary",
    level: 4,
    label: "传说",
    emoji: "💎",
    probability: 0.12,
    flavor: "传说级手气，记得截图！",
  },
  {
    key: "mythic",
    level: 5,
    label: "神话",
    emoji: "👑",
    probability: 0.06,
    flavor: "神话降临，全群都该看看它！",
  },
];

const EPIC_MIN_BATTERIES = 100;
const LEGENDARY_MIN_BATTERIES = 2_000;
const MYTHIC_MIN_BATTERIES = 10_000;

const commonRarity = BILI_GIFT_RARITIES[0]!;
const rareRarity = BILI_GIFT_RARITIES[1]!;
const epicRarity = BILI_GIFT_RARITIES[2]!;
const legendaryRarity = BILI_GIFT_RARITIES[3]!;
const mythicRarity = BILI_GIFT_RARITIES[4]!;

export const getBiliGiftRarity = (gift: BiliGift): BiliGiftRarity => {
  const batteries = getBiliGiftBatteryValue(gift);
  if (batteries === undefined) return commonRarity;
  if (batteries >= MYTHIC_MIN_BATTERIES) return mythicRarity;
  if (batteries >= LEGENDARY_MIN_BATTERIES) return legendaryRarity;
  if (batteries >= EPIC_MIN_BATTERIES) return epicRarity;
  return rareRarity;
};

export const BILI_GIFT_LOTTERY_TITLE = "🎰 迷子的礼物抽奖";

export type BiliGiftLotteryDraw = Readonly<{
  gift: BiliGift;
  rarity: BiliGiftRarity;
  /** 展示效果素材；理论上每个礼物都有动图，取不到时为 undefined。 */
  media: BiliGiftMedia | undefined;
}>;

export type BiliGiftLotteryOptions = Readonly<{
  /** 便于测试的随机源，默认 Math.random。 */
  random?: () => number;
}>;

const pickRandom = <T>(items: readonly T[], random: () => number): T | undefined => {
  if (items.length === 0) {
    return undefined;
  }
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)));
  return items[index];
};

/**
 * 抽一款礼物：先按稀有度概率决定档位，再在该档位里随机取一款。
 * 同名礼物只保留 ID 最大的一版。
 */
export const drawBiliGiftLottery = (
  gifts: readonly BiliGift[],
  options: BiliGiftLotteryOptions = {},
): BiliGiftLotteryDraw | undefined => {
  const random = options.random ?? Math.random;
  const pool = groupBiliGiftsByName(gifts).map((group) => group.gifts[0]!);
  const roll = random();
  let cursor = 0;

  for (const rarity of BILI_GIFT_RARITIES) {
    cursor += rarity.probability;
    if (roll < cursor) {
      const candidates = pool.filter((gift) => getBiliGiftRarity(gift).key === rarity.key);
      const gift = pickRandom(candidates, random);
      if (gift) {
        return { gift, rarity: getBiliGiftRarity(gift), media: resolveBiliGiftMedia(gift) };
      }
    }
  }

  // 随机数落在边界或对应档位暂时没货时，整池兜底。
  const gift = pickRandom(pool, random);
  return gift ? { gift, rarity: getBiliGiftRarity(gift), media: resolveBiliGiftMedia(gift) } : undefined;
};

export const formatBiliGiftLotteryValue = (gift: BiliGift) => {
  const batteries = getBiliGiftBatteryValue(gift);
  return batteries === undefined ? "免费" : `${formatBiliGiftAmount(batteries)} 电池`;
};

/** 稀有度星级：emoji 个数就是档位。 */
export const formatBiliGiftLotteryStars = (rarity: BiliGiftRarity) =>
  `${rarity.emoji.repeat(rarity.level)} ${rarity.label}`;

/** 揭晓文案：稀有度越高，emoji 越多。 */
export const formatBiliGiftLotteryReveal = (rarity: BiliGiftRarity) =>
  `${formatBiliGiftLotteryStars(rarity)}！`;

/** 抽到的礼物值多少电池，作为小游戏的分数。 */
export const formatBiliGiftLotteryValueLine = (gift: BiliGift) => {
  const batteries = getBiliGiftBatteryValue(gift);
  return batteries === undefined ? "💰 免费礼物" : `💰 价值 ${formatBiliGiftAmount(batteries)} 电池`;
};

/** 抽奖结果卡片：独立小游戏的揭晓文案，不展示礼物台账数据。 */
export const formatBiliGiftLotteryCard = (draw: BiliGiftLotteryDraw) => {
  const { gift, rarity } = draw;
  return [
    BILI_GIFT_LOTTERY_TITLE,
    "",
    formatBiliGiftLotteryReveal(rarity),
    `你抽到了「${gift.name}」`,
    "",
    formatBiliGiftLotteryValueLine(gift),
    `🎉 ${rarity.flavor}`,
  ].join("\n");
};

/** 抽奖转发消息：结果卡片 + 礼物的展示效果。 */
export const createBiliGiftLotteryForwardMessages = (
  card: string,
  media: BiliGiftMedia,
  mediaFile: string,
): readonly ForwardMessageContent[] => [
  card,
  [createBiliGiftMediaSegment(media, mediaFile)],
];
