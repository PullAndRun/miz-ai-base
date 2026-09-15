import type { ForwardMessageContent } from "@/plugins";
import {
  createBiliGiftMediaSegment,
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

/** 稀有度按礼物价值分档：免费礼物会归为普通，但抽奖池会剔除它们，越贵越稀有。 */
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

const getBiliGiftRarityForBatteryValue = (batteries: number | undefined): BiliGiftRarity => {
  if (batteries === undefined) return commonRarity;
  if (batteries >= MYTHIC_MIN_BATTERIES) return mythicRarity;
  if (batteries >= LEGENDARY_MIN_BATTERIES) return legendaryRarity;
  if (batteries >= EPIC_MIN_BATTERIES) return epicRarity;
  return rareRarity;
};

export const getBiliGiftRarity = (gift: BiliGift): BiliGiftRarity =>
  getBiliGiftRarityForBatteryValue(getBiliGiftBatteryValue(gift));

export const BILI_GIFT_LOTTERY_TITLE = "🎰 迷子的礼物抽奖";

export type BiliGiftLotteryDraw = Readonly<{
  gift: BiliGift;
  rarity: BiliGiftRarity;
  /** 展示效果素材；理论上每个礼物都有动图，取不到时为 undefined。 */
  media: BiliGiftMedia | undefined;
  /** 抽中礼物的电池价值；免费和 0 电池礼物不会进入奖池，因此始终大于 0。 */
  batteryValue: number;
  /** 本次获得的迷币，按 batteryValue 折算。 */
  coins: number;
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
 * 迷币只按 B 站明码标价的电池价值折算。
 * 免费、0 价格、低于 1 电池，以及会四舍五入成 1 但不是恰好 1 电池的价格，都返回 0。
 */
const getBiliGiftLotteryCoinsForBatteryValue = (batteries: number | undefined) => {
  if (batteries === undefined || !Number.isFinite(batteries) || batteries <= 0) {
    return 0;
  }
  const coins = Math.round(batteries);
  if (coins < 1) {
    return 0;
  }
  // 1 迷币必须是 B 站明码标价的 1 电池礼物，不能由 0.5~1.49 电池的近似价格兜底。
  if (coins === 1 && batteries !== 1) {
    return 0;
  }
  return coins;
};

type BiliGiftLotteryCandidate = Readonly<{
  gift: BiliGift;
  batteryValue: number;
  rarity: BiliGiftRarity;
  coins: number;
}>;

const createBiliGiftLotteryCandidate = (
  gifts: readonly BiliGift[],
): BiliGiftLotteryCandidate | undefined => {
  // 同名礼物展示最新版本，但计价取所有版本中的最高电池价值。
  const gift = gifts[0]!;
  const batteryValue = gifts.reduce<number | undefined>((highest, version) => {
    const batteries = getBiliGiftBatteryValue(version);
    if (batteries === undefined) return highest;
    return highest === undefined || batteries > highest ? batteries : highest;
  }, undefined);
  // 免费、0 价格等没有正电池价值的礼物不进入抽奖池。
  if (batteryValue === undefined || batteryValue <= 0) {
    return undefined;
  }
  const coins = getBiliGiftLotteryCoinsForBatteryValue(batteryValue);
  // 1 迷币只给恰好标价 1 电池的礼物，不能用保底兜底。
  if (coins < 1) {
    return undefined;
  }
  return {
    gift,
    batteryValue,
    rarity: getBiliGiftRarityForBatteryValue(batteryValue),
    coins,
  };
};

const toBiliGiftLotteryDraw = (
  candidate: BiliGiftLotteryCandidate,
): BiliGiftLotteryDraw => ({
  gift: candidate.gift,
  rarity: candidate.rarity,
  media: resolveBiliGiftMedia(candidate.gift),
  batteryValue: candidate.batteryValue,
  coins: candidate.coins,
});

/**
 * 抽一款礼物：先按稀有度概率决定档位，再在该档位里随机取一款。
 * 同名礼物只保留 ID 最大的一版展示，计价取同名版本中的最高电池价值。
 * 免费、0 价格和不能按明码标价合法折算的礼物不会进入奖池。
 * 1 迷币只对应恰好标价 1 电池的礼物。
 */
export const drawBiliGiftLottery = (
  gifts: readonly BiliGift[],
  options: BiliGiftLotteryOptions = {},
): BiliGiftLotteryDraw | undefined => {
  const random = options.random ?? Math.random;
  const pool = groupBiliGiftsByName(gifts)
    .map((group) => createBiliGiftLotteryCandidate(group.gifts))
    .filter((candidate): candidate is BiliGiftLotteryCandidate => candidate !== undefined);
  const roll = random();
  let cursor = 0;

  for (const rarity of BILI_GIFT_RARITIES) {
    cursor += rarity.probability;
    if (roll < cursor) {
      const candidates = pool.filter((candidate) => candidate.rarity.key === rarity.key);
      const candidate = pickRandom(candidates, random);
      if (candidate) {
        return toBiliGiftLotteryDraw(candidate);
      }
    }
  }

  // 随机数落在边界或对应档位暂时没货时，整池兜底。
  const candidate = pickRandom(pool, random);
  return candidate ? toBiliGiftLotteryDraw(candidate) : undefined;
};

/** 迷币：只有 B 站明码标价的电池价值才折算；免费、0 价格或不能合法折算时返回 0。 */
export const getBiliGiftLotteryCoins = (gift: BiliGift) =>
  getBiliGiftLotteryCoinsForBatteryValue(getBiliGiftBatteryValue(gift));

/** 稀有度星级：emoji 个数就是档位。 */
export const formatBiliGiftLotteryStars = (rarity: BiliGiftRarity) =>
  `${rarity.emoji.repeat(rarity.level)} ${rarity.label}`;

/** 揭晓文案：稀有度越高，emoji 越多。 */
export const formatBiliGiftLotteryReveal = (rarity: BiliGiftRarity) =>
  `${formatBiliGiftLotteryStars(rarity)}！`;

/** 奖品行：这次拿到多少迷币，以及在这个群累计多少。 */
export const formatBiliGiftLotteryPrizeLine = (coins: number, totalCoins: number) =>
  `💰 获得 ${coins} 迷币 · 累计 ${totalCoins}`;

export type BiliGiftLotteryCardOptions = Readonly<{
  /** 抽奖人这个群的迷币总量（已包含本次获得）。 */
  totalCoins: number;
  /** 中奖群友的昵称；取不到时卡片用「你」称呼。 */
  winnerName?: string;
}>;

/** 抽奖结果卡片：独立小游戏的揭晓文案，不展示礼物台账数据。 */
export const formatBiliGiftLotteryCard = (
  draw: BiliGiftLotteryDraw,
  options: BiliGiftLotteryCardOptions,
) => {
  const { gift, rarity } = draw;
  // 中奖人放在最前面，合并转发的卡片预览里就能看见是谁抽的。
  const winner = options.winnerName?.trim();
  return [
    winner ? `🎰 ${winner} 的礼物抽奖` : BILI_GIFT_LOTTERY_TITLE,
    "",
    formatBiliGiftLotteryReveal(rarity),
    winner ? `抽到了「${gift.name}」` : `你抽到了「${gift.name}」`,
    "",
    formatBiliGiftLotteryPrizeLine(draw.coins, options.totalCoins),
    `🎉 ${rarity.flavor}`,
  ].join("\n");
};

export const BILI_GIFT_LOTTERY_LEADERBOARD_SIZE = 10;
const LEADERBOARD_MEDALS = ["🥇", "🥈", "🥉"];

export type BiliGiftLotteryLeaderboardEntry = Readonly<{
  userId: string;
  coins: number;
  /** 群名片或昵称；取不到时榜单退回显示 QQ 号。 */
  name?: string;
}>;

export type BiliGiftLotteryLeaderboardOptions = Readonly<{
  /** 空榜单提示里用的命令前缀。 */
  commandPrefix?: string;
}>;

/** 迷币榜：纯文本榜单，不 at 人，按顺序列出群昵称与迷币。 */
export const createBiliGiftLotteryLeaderboardMessage = (
  entries: readonly BiliGiftLotteryLeaderboardEntry[],
  options: BiliGiftLotteryLeaderboardOptions = {},
): string => {
  const prefix = options.commandPrefix ?? "miz";
  const top = entries.slice(0, BILI_GIFT_LOTTERY_LEADERBOARD_SIZE);
  if (top.length === 0) {
    return "🏆 本群迷币榜\n\n本群还没有人抽过奖，第一个发 " + prefix + " 抽奖 的就是榜一～";
  }

  return [
    "🏆 本群迷币榜 · 前 " + BILI_GIFT_LOTTERY_LEADERBOARD_SIZE + " 名",
    "",
    ...top.map((entry, index) => {
      const medal = LEADERBOARD_MEDALS[index] ?? (index + 1) + ".";
      const label = entry.name?.trim() || entry.userId;
      return medal + " " + label + " · " + entry.coins + " 迷币";
    }),
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
