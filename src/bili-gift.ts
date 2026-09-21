import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { inspectMp4Video } from "@/mp4";
import type { ForwardMessageContent } from "@/plugins";

/** 素材库默认位于项目根目录，可通过参数覆盖（测试或自定义部署）。 */
export const BILI_GIFT_RESOURCE_DIRECTORY = "resource/bili-gift";
export const BILI_GIFT_INDEX_FILE = "素材索引.json";
/**
 * 素材（尤其是全屏特效视频）发送的等待上限：几 MB 的特效上传常常要几十秒，
 * 等太短会把正常发送判成超时，而发送真失败的情况很少，所以给足余量。
 * 注意 NapLink 会丢弃挂起超过 2 × naplink.apiTimeoutMs 的请求，那个阈值必须比这里更大，
 * 否则长发送还没等到回执就先被网关判死（2026-09-15 / 09-20 两次丢迷币都是这么来的）。
 */
export const BILI_GIFT_MEDIA_SEND_TIMEOUT_MS = 15 * 60_000;

const MAX_BILI_GIFT_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_BILI_GIFT_MEDIA_BYTES = 64 * 1024 * 1024;
export const MAX_BILI_GIFT_QUERY_LENGTH = 30;
const MAX_BILI_GIFT_NAME_SUGGESTIONS = 5;
const MAX_BILI_GIFT_ALTERNATIVE_NAMES = 3;
const MAX_BILI_GIFT_DESCRIPTION_LENGTH = 60;

const giftSchema = z.looseObject({
  id: z.number().int().nonnegative(),
  name: z.string().trim().min(1),
  price: z.number().nonnegative().optional(),
  coinType: z.string().optional(),
  desc: z.string().optional(),
  effectId: z.number().int().nonnegative().optional(),
  webp: z.string().optional(),
  gif: z.string().optional(),
  png: z.string().optional(),
  frame: z.string().optional(),
  effectMp4: z.string().optional(),
});

const giftIndexSchema = z.looseObject({
  gifts: z.array(giftSchema).min(1),
});

export type BiliGift = Readonly<{
  id: number;
  name: string;
  price: number;
  coinType: string;
  description: string;
  effectId: number;
  webp: string;
  gif: string;
  png: string;
  frame: string;
  effectMp4: string;
}>;

export type BiliGiftMediaKind = "video" | "image";

export type BiliGiftMedia = Readonly<{
  kind: BiliGiftMediaKind;
  /** 相对素材库根目录的路径，例如 `全屏特效/在用/34998_小电视飞船_2200.mp4`。 */
  relativePath: string;
  /** 面向用户的素材类型名称。 */
  label: string;
}>;

/** `auto` 优先全屏特效、没有特效时改用礼物动图。 */
export type BiliGiftMediaMode = "auto" | "effect" | "animation";

export type BiliGiftMatch = Readonly<{
  /** 同名礼物中礼物 ID 最大的那一版。 */
  gift: BiliGift;
  /** 同名礼物的全部礼物 ID，按从大到小排列。 */
  sameNameGiftIds: readonly number[];
  /** 名称同样匹配、但不是首选的其他礼物名，最多三个。 */
  alternativeNames: readonly string[];
  /** 礼物名与用户输入完全一致（忽略大小写、全半角和首尾空白）。 */
  exactName: boolean;
}>;

export type BiliGiftIndexError = Error & Readonly<{ name: "BiliGiftIndexError" }>;

export const createBiliGiftIndexError = (
  message: string,
  options?: ErrorOptions,
): BiliGiftIndexError => Object.assign(
  new Error(message, options),
  { name: "BiliGiftIndexError" as const },
);


type CachedGiftLibrary = Readonly<{
  mtimeMs: number;
  size: number;
  gifts: readonly BiliGift[];
}>;

const giftLibraryCache = new Map<string, CachedGiftLibrary>();
const pendingGiftLibraryLoads = new Map<string, Promise<readonly BiliGift[]>>();

export const resolveBiliGiftIndexPath = (directory = BILI_GIFT_RESOURCE_DIRECTORY) =>
  path.join(path.resolve(directory), BILI_GIFT_INDEX_FILE);

/**
 * 读取素材库索引，按文件修改时间缓存，重新生成素材库后会自动刷新。
 */
export const loadBiliGiftLibrary = async (
  directory = BILI_GIFT_RESOURCE_DIRECTORY,
): Promise<readonly BiliGift[]> => {
  const indexPath = resolveBiliGiftIndexPath(directory);
  const indexFile = await stat(indexPath).catch(() => undefined);
  if (!indexFile?.isFile()) {
    throw createBiliGiftIndexError(`Bilibili gift index file is missing: ${indexPath}`);
  }
  if (indexFile.size > MAX_BILI_GIFT_INDEX_BYTES) {
    throw createBiliGiftIndexError(
      `Bilibili gift index file is too large: ${indexFile.size} bytes`,
    );
  }

  const cached = giftLibraryCache.get(indexPath);
  if (cached && cached.mtimeMs === indexFile.mtimeMs && cached.size === indexFile.size) {
    return cached.gifts;
  }

  const pending = pendingGiftLibraryLoads.get(indexPath) ?? readBiliGiftLibrary(indexPath, indexFile)
    .finally(() => pendingGiftLibraryLoads.delete(indexPath));
  pendingGiftLibraryLoads.set(indexPath, pending);
  return pending;
};

const readBiliGiftLibrary = async (
  indexPath: string,
  indexFile: Readonly<{ mtimeMs: number; size: number }>,
): Promise<readonly BiliGift[]> => {
  const gifts = await parseBiliGiftIndex(indexPath);
  giftLibraryCache.set(indexPath, {
    mtimeMs: indexFile.mtimeMs,
    size: indexFile.size,
    gifts,
  });
  return gifts;
};

const parseBiliGiftIndex = async (indexPath: string): Promise<readonly BiliGift[]> => {
  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(indexPath, "utf8"));
  } catch (error) {
    throw createBiliGiftIndexError(
      `Bilibili gift index file cannot be read: ${indexPath}`,
      { cause: error },
    );
  }

  const parsed = giftIndexSchema.safeParse(payload);
  if (!parsed.success) {
    throw createBiliGiftIndexError(
      `Bilibili gift index file has an unexpected shape: ${indexPath}`,
      { cause: parsed.error },
    );
  }

  return parsed.data.gifts.map((gift) => ({
    id: gift.id,
    name: gift.name,
    price: gift.price ?? 0,
    coinType: gift.coinType ?? "",
    description: cleanText(gift.desc ?? "", MAX_BILI_GIFT_DESCRIPTION_LENGTH),
    effectId: gift.effectId ?? 0,
    webp: gift.webp ?? "",
    gif: gift.gif ?? "",
    png: gift.png ?? "",
    frame: gift.frame ?? "",
    effectMp4: gift.effectMp4 ?? "",
  }));
};

export const normalizeBiliGiftName = (value: string) =>
  value.normalize("NFKC").trim().toLowerCase();

const cleanText = (value: string, maxLength: number) => {
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength)}…` : flattened;
};

type BiliGiftGroup = Readonly<{
  name: string;
  normalizedName: string;
  /** 同名礼物按礼物 ID 从大到小排列。 */
  gifts: readonly BiliGift[];
}>;

export const groupBiliGiftsByName = (gifts: readonly BiliGift[]): readonly BiliGiftGroup[] => {
  const groups = new Map<string, BiliGift[]>();
  for (const gift of gifts) {
    const normalizedName = normalizeBiliGiftName(gift.name);
    if (normalizedName === "") {
      continue;
    }
    const group = groups.get(normalizedName);
    if (group) {
      group.push(gift);
    } else {
      groups.set(normalizedName, [gift]);
    }
  }

  return [...groups].map(([normalizedName, groupGifts]) => ({
    name: groupGifts[0]!.name.trim(),
    normalizedName,
    gifts: [...groupGifts].sort((left, right) => right.id - left.id),
  }));
};

const matchRank = (normalizedName: string, normalizedQuery: string) => {
  if (normalizedName === normalizedQuery) return 0;
  if (normalizedName.startsWith(normalizedQuery)) return 1;
  if (normalizedName.includes(normalizedQuery)) return 2;
  return undefined;
};

/**
 * 按礼物名查找素材：优先完全同名，其次名称前缀，最后名称包含。
 * 同名礼物可能对应多个礼物 ID，这里始终返回 ID 最大的那一版。
 */
export const findBiliGift = (
  gifts: readonly BiliGift[],
  query: string,
): BiliGiftMatch | undefined => {
  const normalizedQuery = normalizeBiliGiftName(query);
  if (normalizedQuery === "") {
    return undefined;
  }

  const candidates = groupBiliGiftsByName(gifts)
    .map((group) => ({ group, rank: matchRank(group.normalizedName, normalizedQuery) }))
    .filter((candidate): candidate is { group: BiliGiftGroup; rank: number } =>
      candidate.rank !== undefined)
    .sort((left, right) =>
      left.rank - right.rank ||
      left.group.normalizedName.length - right.group.normalizedName.length ||
      (right.group.gifts[0]?.id ?? 0) - (left.group.gifts[0]?.id ?? 0));

  const best = candidates[0];
  if (!best) {
    return undefined;
  }

  return {
    gift: best.group.gifts[0]!,
    sameNameGiftIds: best.group.gifts.map((gift) => gift.id),
    alternativeNames: candidates
      .slice(1)
      .map((candidate) => candidate.group.name)
      .slice(0, MAX_BILI_GIFT_ALTERNATIVE_NAMES),
    exactName: best.rank === 0,
  };
};

/** 没找到礼物时按字符重合度给出候选礼物名。 */
export const suggestBiliGiftNames = (
  gifts: readonly BiliGift[],
  query: string,
  limit = MAX_BILI_GIFT_NAME_SUGGESTIONS,
): readonly string[] => {
  const normalizedQuery = normalizeBiliGiftName(query);
  const queryCharacters = new Set([...normalizedQuery].filter((character) => character.trim() !== ""));
  if (queryCharacters.size === 0 || limit <= 0) {
    return [];
  }

  return groupBiliGiftsByName(gifts)
    .map((group) => ({
      name: group.name,
      score: [...queryCharacters].filter((character) => group.normalizedName.includes(character)).length,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      left.name.length - right.name.length ||
      left.name.localeCompare(right.name, "zh-Hans-CN"))
    .slice(0, limit)
    .map((candidate) => candidate.name);
};

export const resolveBiliGiftMedia = (
  gift: BiliGift,
  mode: BiliGiftMediaMode = "auto",
): BiliGiftMedia | undefined => {
  const effect = gift.effectMp4
    ? { kind: "video" as const, relativePath: gift.effectMp4, label: "全屏特效" }
    : undefined;
  const animation = gift.gif
    ? { kind: "image" as const, relativePath: gift.gif, label: "礼物动图" }
    : gift.webp
      ? { kind: "image" as const, relativePath: gift.webp, label: "礼物动图" }
      : undefined;

  if (mode === "effect") return effect;
  if (mode === "animation") return animation;
  return effect ?? animation;
};

export const resolveBiliGiftMediaPath = (
  media: BiliGiftMedia,
  directory = BILI_GIFT_RESOURCE_DIRECTORY,
) => {
  const root = path.resolve(directory);
  const target = path.resolve(root, media.relativePath);
  const relative = path.relative(root, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw createBiliGiftIndexError(`Bilibili gift media path escapes the resource directory: ${media.relativePath}`);
  }
  return target;
};

export const readBiliGiftMedia = async (
  media: BiliGiftMedia,
  directory = BILI_GIFT_RESOURCE_DIRECTORY,
) => {
  const mediaPath = resolveBiliGiftMediaPath(media, directory);
  const mediaFile = await stat(mediaPath).catch(() => undefined);
  if (!mediaFile?.isFile()) {
    throw createBiliGiftIndexError(`Bilibili gift media file is missing: ${mediaPath}`);
  }
  if (mediaFile.size > MAX_BILI_GIFT_MEDIA_BYTES) {
    throw createBiliGiftIndexError(`Bilibili gift media file is too large: ${mediaPath}`);
  }

  const data = await readFile(mediaPath);
  return {
    path: mediaPath,
    size: mediaFile.size,
    data,
    base64: data.toString("base64"),
  };
};

export type BiliGiftMediaDelivery = Readonly<{
  media: BiliGiftMedia;
  base64: string;
  /** 特效视频坏掉、改用礼物动图时带上原素材路径与原因，供调用方记日志。 */
  fallback?: Readonly<{ relativePath: string; reason: string }>;
}>;

/**
 * 读取准备发送的素材：特效视频结构损坏（QQ 会提示播放失败）时退回礼物动图。
 * 视频和动图都读不出来时抛出 BiliGiftIndexError，由调用方提示管理员检查素材库。
 */
export const loadBiliGiftMediaForDelivery = async (
  gift: BiliGift,
  media: BiliGiftMedia,
  directory = BILI_GIFT_RESOURCE_DIRECTORY,
): Promise<BiliGiftMediaDelivery> => {
  const loaded = await readBiliGiftMedia(media, directory);
  if (media.kind !== "video") {
    return { media, base64: loaded.base64 };
  }

  const inspection = inspectMp4Video(loaded.data);
  if (inspection.playable) {
    return { media, base64: loaded.base64 };
  }

  const animation = resolveBiliGiftMedia(gift, "animation");
  if (!animation) {
    throw createBiliGiftIndexError(
      `Bilibili gift effect video is unplayable and no animation is available: ${media.relativePath} (${inspection.reason})`,
    );
  }
  const fallback = await readBiliGiftMedia(animation, directory);
  return {
    media: animation,
    base64: fallback.base64,
    fallback: { relativePath: media.relativePath, reason: inspection.reason },
  };
};

/** 金瓜子与电池的换算是 100 : 1，10 电池等于 1 元。 */
const RAW_COINS_PER_BATTERY = 100;
const BATTERIES_PER_RMB = 10;

export const formatBiliGiftAmount = (value: number) => value.toFixed(2).replace(/\.?0+$/, "");

/** 金瓜子礼物的电池价值；银瓜子免费礼物和无价格礼物没有电池价值。 */
export const getBiliGiftBatteryValue = (gift: BiliGift) =>
  gift.price > 0 && gift.coinType.toLowerCase() === "gold"
    ? gift.price / RAW_COINS_PER_BATTERY
    : undefined;

/** 付费礼物换算成电池和人民币；免费礼物不显示价格。 */
export const formatBiliGiftPrice = (gift: BiliGift) => {
  const batteries = getBiliGiftBatteryValue(gift);
  if (batteries === undefined) {
    return undefined;
  }
  return `${formatBiliGiftAmount(batteries)} 电池（${formatBiliGiftAmount(batteries / BATTERIES_PER_RMB)} 元）`;
};

/** 礼物台账里的数据行，礼物卡片和抽奖结果共用。 */
export const formatBiliGiftDetails = (gift: BiliGift, media: BiliGiftMedia) => {
  const price = formatBiliGiftPrice(gift);
  return [
    `· 礼物 ID：#${gift.id}`,
    ...(price ? [`· 价格：${price}`] : []),
    ...(gift.effectId > 0 ? [`· 特效 ID：#${gift.effectId}`] : []),
    `· 展示素材：${media.label}`,
  ];
};

/** 转发消息里的礼物介绍：礼物名、ID、价格、特效与展示素材等台账数据。 */
export const formatBiliGiftCard = (match: BiliGiftMatch, media: BiliGiftMedia) => {
  const { gift } = match;

  return [
    `🎁 ${gift.name}`,
    "",
    ...formatBiliGiftDetails(gift, media),
    ...(gift.description ? ["", `「${gift.description}」`] : []),
    ...(!match.exactName && match.alternativeNames.length > 0
      ? ["", `还有：${match.alternativeNames.join("、")}`]
      : []),
  ].join("\n");
};

export const createBiliGiftMediaSegment = (media: BiliGiftMedia, mediaFile: string) => ({
  type: media.kind === "video" ? "video" : "image",
  data: { file: mediaFile },
});

/**
 * 礼物转发消息：第一条是文字内容（礼物介绍或抽奖结果），第二条是礼物的展示效果。
 */
export const createBiliGiftForwardMessage = (
  card: string,
  media: BiliGiftMedia,
  mediaFile: string,
): readonly ForwardMessageContent[] => [
  card,
  [createBiliGiftMediaSegment(media, mediaFile)],
];

export type BiliGiftCommandArguments = Readonly<{
  query: string;
  mode: BiliGiftMediaMode;
}>;

const animationModeTokens = ["动图", "gif", "webp"];
const effectModeTokens = ["特效", "视频", "video", "mp4"];

/** 解析 `礼物名 [动图|特效]`，保留含空格的礼物名。 */
export const parseBiliGiftCommandArguments = (args: string): BiliGiftCommandArguments => {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const lastPart = parts.at(-1);
  const normalizedLastPart = parts.length > 1 && lastPart ? normalizeBiliGiftName(lastPart) : "";
  const mode = animationModeTokens.includes(normalizedLastPart)
    ? "animation" as const
    : effectModeTokens.includes(normalizedLastPart)
      ? "effect" as const
      : undefined;
  const queryParts = mode ? parts.slice(0, -1) : parts;

  return {
    query: queryParts.join(" "),
    mode: mode ?? "auto",
  };
};
