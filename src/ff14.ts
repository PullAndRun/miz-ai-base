import dayjs from "dayjs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { settleWithConcurrency } from "@/concurrency";
import { fetchWithRetry, readResponseJson, readResponseText } from "@/http";

const itemSearchResultSchema = z.looseObject({
  ID: z.number().int().positive(),
  Name: z.string().min(1),
});

const searchResponseSchema = z.looseObject({
  items: z
    .array(
      z.looseObject({
        id: z.number().int().positive(),
        name: z.string().min(1),
      }),
    )
    .optional()
    .default([]),
});

const listingSchema = z.looseObject({
  listingID: z.union([z.string().min(1), z.number()]).nullish(),
  pricePerUnit: z.number().nonnegative(),
  quantity: z.number().int().nonnegative(),
  total: z.number().nonnegative(),
  worldID: z.number().int().nullish(),
  worldName: z.string().optional(),
  retainerID: z.string().nullish(),
  sellerID: z.string().nullish(),
  hq: z.boolean().optional(),
  lastReviewTime: z.number().optional(),
});

const marketResponseSchema = z.looseObject({
  itemID: z.number().int().positive().optional(),
  lastUploadTime: z.number().optional(),
  listings: z.array(listingSchema).optional().default([]),
  listingsCount: z.number().int().nonnegative().optional(),
  unitsForSale: z.number().int().nonnegative().optional(),
  recentHistoryCount: z.number().int().nonnegative().optional(),
  averagePrice: z.number().optional(),
  averagePriceNQ: z.number().optional(),
  averagePriceHQ: z.number().optional(),
  minPrice: z.number().optional(),
  minPriceNQ: z.number().optional(),
  minPriceHQ: z.number().optional(),
  hasData: z.boolean().optional(),
});

type ItemSearchResult = z.infer<typeof itemSearchResultSchema>;
type MarketResponse = z.infer<typeof marketResponseSchema>;
type Listing = z.infer<typeof listingSchema>;
type GroupedListing = {
  quality: "HQ" | "NQ";
  listing: Listing;
};

export const FF14_REGION_NAMES = {
  猫: "猫小胖",
  猪: "莫古力",
  狗: "豆豆柴",
  鸟: "陆行鸟",
} as const;

export type Ff14RegionKey = keyof typeof FF14_REGION_NAMES;

export type Ff14MarketQuery = {
  regionKey: Ff14RegionKey;
  itemName: string;
  itemSearchApiUrl: string;
  marketApiUrl: string;
  proxyUrl?: string;
  maxListingCount?: number;
  itemStore?: Ff14ItemStore;
};

export type Ff14ItemStore = {
  findFf14Item(queryName: string): Promise<{ id: number; name: string } | undefined>;
  upsertFf14Item(queryName: string, item: { id: number; name: string }): Promise<void>;
};

export type Ff14MarketResult = {
  item: ItemSearchResult;
  market: MarketResponse;
  regionName: string;
};

export const createFf14PriceAlertMentionMessage = (
  userIds: readonly (string | number)[],
  notice = "FF14 低价提醒已触发，请查看上方行情。",
) => {
  const uniqueUserIds = [...new Map(userIds.map((userId) => [String(userId), userId])).values()];
  return uniqueUserIds.flatMap((userId, index) => [
    { type: "at", data: { qq: userId } },
    {
      type: "text",
      data: {
        text: index === uniqueUserIds.length - 1
          ? ` ${notice}`
          : " ",
      },
    },
  ]);
};

const DEFAULT_MAX_LISTING_COUNT = 10;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FF14_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_FF14_CN_ITEM_INDEX_BYTES = 32 * 1024 * 1024;
const FF14_CN_ITEM_INDEX_URL =
  "https://raw.githubusercontent.com/thewakingsands/ffxiv-datamining-cn/master/Item.csv";
const FF14_CN_ITEM_INDEX_TIMEOUT_MS = 60_000;
// A proxy that accepts a connection but never completes a request should not
// hold up the whole alert poll through the shared, long HTTP backoff policy.
// Probe it once, then give the direct route a small number of retries.
const FF14_PROXY_RETRY_COUNT = 0;
const FF14_DIRECT_RETRY_COUNT = 2;
const FF14_RETRY_DELAY_MS = 2_000;
export const FF14_REQUEST_INTERVAL_MS = 200;
const waitForFf14RequestSlot = createFf14RequestGate(FF14_REQUEST_INTERVAL_MS);

export const isFf14RegionKey = (value: string | undefined): value is Ff14RegionKey =>
  value !== undefined && value in FF14_REGION_NAMES;

export const queryFf14Market = async ({
  regionKey,
  itemName,
  itemSearchApiUrl,
  marketApiUrl,
  proxyUrl = "",
  maxListingCount = DEFAULT_MAX_LISTING_COUNT,
  itemStore,
}: Ff14MarketQuery): Promise<Ff14MarketResult | undefined> => {
  const queryName = normalizeFf14ItemQueryName(itemName);
  const storedItem = await itemStore?.findFf14Item(queryName);
  const item = storedItem
    ? { ID: storedItem.id, Name: storedItem.name }
    : await searchItem(queryName, itemSearchApiUrl, proxyUrl);
  if (!item) {
    return undefined;
  }
  if (!storedItem) {
    await itemStore?.upsertFf14Item(queryName, { id: item.ID, name: item.Name });
  }

  const regionName = FF14_REGION_NAMES[regionKey];
  const market = await fetchMarket(
    marketApiUrl,
    regionName,
    item.ID,
    proxyUrl,
    maxListingCount,
  );

  return {
    item,
    market,
    regionName,
  };
};

export const getLowestMarketPrice = (market: MarketResponse) => {
  if (typeof market.minPrice === "number" && market.minPrice > 0) {
    return market.minPrice;
  }

  const listings = market.listings.filter((listing) => listing.pricePerUnit > 0);
  if (listings.length === 0) {
    return undefined;
  }

  return Math.min(...listings.map((listing) => listing.pricePerUnit));
};

export const getFf14LowPriceListingKeys = (
  market: MarketResponse,
  maximumPrice: number,
) => {
  const listingKeys = market.listings
    .filter((listing) => listing.pricePerUnit > 0 && listing.pricePerUnit <= maximumPrice)
    .map((listing) => {
      if (listing.listingID !== undefined && listing.listingID !== null) {
        return `listing:${String(listing.listingID)}`;
      }

      // Universalis normally supplies listingID. Keep a stable fallback for
      // incomplete responses without using review time, which changes while
      // the actual market-board listing remains the same.
      return `fallback:${hashFf14ListingKey([
        listing.worldID,
        listing.worldName,
        listing.retainerID,
        listing.sellerID,
        listing.hq === true,
        listing.pricePerUnit,
        listing.quantity,
        listing.total,
      ])}`;
    });

  if (listingKeys.length > 0) {
    return [...new Set(listingKeys)].sort();
  }

  const lowestPrice = getLowestMarketPrice(market);
  if (lowestPrice === undefined || lowestPrice > maximumPrice) {
    return [];
  }

  // A summary-only response can still trigger the existing price check. Give
  // that market snapshot a persistent identity so it is not sent every hour.
  return [`summary:${hashFf14ListingKey([
    market.minPrice,
    market.minPriceNQ,
    market.minPriceHQ,
    market.listingsCount,
    market.unitsForSale,
  ])}`];
};

const hashFf14ListingKey = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("base64url");

export const FF14_BATCH_SAMPLE_SIZE = 5;
const FF14_BATCH_QUERY_CONCURRENCY = 3;
const FF14_BATCH_NODE_ITEM_COUNT = 6;

export type Ff14BatchItemStatus = "ready" | "empty" | "missing" | "failed";

export type Ff14BatchSample = {
  price: number;
  hq: boolean;
};

export type Ff14BatchItemResult = {
  /** 配置里写的道具名，用于对回配置。 */
  itemName: string;
  /** 查询到的官方道具名与 ID；道具库没有它时为 undefined。 */
  item?: ItemSearchResult;
  status: Ff14BatchItemStatus;
  /** 市场板上最低的在售单价。 */
  lowestPrice?: number;
  /** 用作上架参考的价格。 */
  referencePrice?: number;
  /** 参与参考价计算的挂单，从低到高。 */
  samples: Ff14BatchSample[];
  /** 配置了售卖线时表示参考价是否达到售卖线。 */
  sellable?: boolean;
};

export type Ff14BatchQuery = {
  regionKey: Ff14RegionKey;
  itemNames: readonly string[];
  itemSearchApiUrl: string;
  marketApiUrl: string;
  proxyUrl?: string;
  /** 参考价达到这个价格就值得上线挂单。 */
  sellPrice?: number;
  sampleSize?: number;
  maxListingCount?: number;
  itemStore?: Ff14ItemStore;
};

export type Ff14BatchResult = {
  regionKey: Ff14RegionKey;
  regionName: string;
  sellPrice?: number;
  sampleSize: number;
  items: readonly Ff14BatchItemResult[];
};

/**
 * 批量查询同一分区里的多个商品，每个商品取最低的若干条挂单。
 * 参考价取这些挂单的中位数：单条超低挂单不会把整条行情带偏。
 */
export const queryFf14Batch = async ({
  regionKey,
  itemNames,
  itemSearchApiUrl,
  marketApiUrl,
  proxyUrl = "",
  sellPrice,
  sampleSize = FF14_BATCH_SAMPLE_SIZE,
  maxListingCount = DEFAULT_MAX_LISTING_COUNT,
  itemStore,
}: Ff14BatchQuery): Promise<Ff14BatchResult> => {
  const effectiveSampleSize = Math.max(1, Math.floor(sampleSize));
  const listingCount = Math.max(effectiveSampleSize, Math.floor(maxListingCount));
  const settled = await settleWithConcurrency(
    itemNames,
    FF14_BATCH_QUERY_CONCURRENCY,
    async (itemName) => {
      const result = await queryFf14Market({
        regionKey,
        itemName,
        itemSearchApiUrl,
        marketApiUrl,
        proxyUrl,
        maxListingCount: listingCount,
        itemStore,
      });
      return createFf14BatchItemResult(itemName, result, effectiveSampleSize, sellPrice);
    },
  );

  return {
    regionKey,
    regionName: FF14_REGION_NAMES[regionKey],
    sellPrice,
    sampleSize: effectiveSampleSize,
    items: settled.map((entry, index) => entry.status === "fulfilled"
      ? entry.value
      : { itemName: itemNames[index], status: "failed", samples: [] }),
  };
};

const createFf14BatchItemResult = (
  itemName: string,
  result: Ff14MarketResult | undefined,
  sampleSize: number,
  sellPrice: number | undefined,
): Ff14BatchItemResult => {
  if (!result) {
    return { itemName, status: "missing", samples: [] };
  }

  const samples = selectFf14BatchSamples(result.market.listings, sampleSize);
  const referencePrice = getFf14ReferencePrice(samples.map((sample) => sample.price));
  if (referencePrice === undefined) {
    return { itemName, item: result.item, status: "empty", samples };
  }

  return {
    itemName,
    item: result.item,
    status: "ready",
    lowestPrice: samples[0]?.price,
    referencePrice,
    samples,
    sellable: sellPrice === undefined ? undefined : referencePrice >= sellPrice,
  };
};

// 交易板默认按单件价格升序排列，这里也照单件价取最低的若干条挂单：
// 不按挂单件数加权，1 件散卖的超低价挂单和整叠挂单在同一张榜单上比较。
export const selectFf14BatchSamples = (
  listings: readonly Listing[],
  sampleSize: number,
): Ff14BatchSample[] =>
  sortListingsByPrice(listings.filter((listing) => listing.pricePerUnit > 0))
    .slice(0, Math.max(1, Math.floor(sampleSize)))
    .map((listing) => ({ price: listing.pricePerUnit, hq: listing.hq === true }));

/**
 * 挑出这次该提醒的商品：参考价达到售卖线，而且和上次提醒过的价位不一样。
 * 同一个价位只提醒一次，价格变了才会再提醒。
 */
export const selectFf14BatchAlertItems = (
  batch: Ff14BatchResult,
  notifiedPrices: ReadonlyMap<number, number>,
): Ff14BatchItemResult[] =>
  batch.items.filter((item) => {
    const itemId = item.item?.ID;
    const referencePrice = item.referencePrice;
    return item.status === "ready"
      && item.sellable === true
      && itemId !== undefined
      && referencePrice !== undefined
      && notifiedPrices.get(itemId) !== referencePrice;
  });

/** 取中位价；偶数条挂单时取中间两条的平均值。 */
export const getFf14ReferencePrice = (prices: readonly number[]): number | undefined => {
  if (prices.length === 0) {
    return undefined;
  }

  const sorted = [...prices].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

export const formatFf14MarketMessages = ({
  item,
  market,
  maxListingCount = DEFAULT_MAX_LISTING_COUNT,
  minimumPrice,
  regionName,
}: Ff14MarketResult & {
  maxListingCount?: number;
  minimumPrice?: number;
}) => {
  const listings = selectDisplayListings(market.listings, maxListingCount);

  if (market.hasData === false || listings.length === 0) {
    return [
      [
        `🪙 ${item.Name} · ${regionName}`,
        `道具 ID · ${item.ID}`,
        ...(minimumPrice === undefined ? [] : [`提醒线 · ${formatGil(minimumPrice)}`]),
        "市场板现在空空的，可能暂时没人出售，也可能数据还在赶来。",
      ].join("\n"),
    ];
  }

  return [
    formatSummary({ item, market, minimumPrice, regionName }),
    ...formatListingMessages(listings),
  ];
};

const searchItem = async (itemName: string, itemSearchApiUrl: string, proxyUrl: string) => {
  const url = new URL(itemSearchApiUrl);
  url.search = new URLSearchParams({
    sheets: "Items",
    query: itemName,
    language: "chs",
    limit: "10",
    field: "Name,ItemSearchCategory.Name,Icon,LevelItem.todo,Rarity",
  }).toString();

  const data = await fetchJson(url, searchResponseSchema, {
    ...(proxyUrl ? { proxy: proxyUrl } : {}),
    headers: {
      Origin: "https://universalis.app",
      Referer: "https://universalis.app/",
    },
  });
  const normalizedItemName = normalizeFf14ItemQueryName(itemName);
  const item = data.items.find((candidate) => normalizeFf14ItemQueryName(candidate.name) === normalizedItemName)
    ?? data.items[0];
  if (item) {
    return { ID: item.id, Name: item.name };
  }

  // The public search index can lag behind the CN game data for newly added
  // items. Resolve misses against the current CN game-data export instead.
  return findFf14ItemInCnIndex(normalizedItemName, proxyUrl);
};

// NFKC makes full-width punctuation searchable, but it also changes the
// Chinese colon used by some official item names into an ASCII colon. Keep
// the canonical item name's punctuation while treating both input forms as
// the same item for lookup and alert management.
export const normalizeFf14ItemQueryName = (itemName: string) =>
  itemName.trim().normalize("NFKC").replace(/:/g, "：");

let ff14CnItemIndexPromise: Promise<ReadonlyMap<string, ItemSearchResult>> | undefined;

const findFf14ItemInCnIndex = async (itemName: string, proxyUrl: string) => {
  const index = await loadFf14CnItemIndex(proxyUrl);
  return index.get(normalizeFf14ItemQueryName(itemName));
};

const loadFf14CnItemIndex = async (proxyUrl: string) => {
  const current = ff14CnItemIndexPromise ??= downloadFf14CnItemIndex(proxyUrl);
  try {
    return await current;
  } catch (error) {
    if (ff14CnItemIndexPromise === current) {
      ff14CnItemIndexPromise = undefined;
    }
    throw error;
  }
};

const downloadFf14CnItemIndex = async (proxyUrl: string) => {
  const request = (proxy?: string) => fetchWithRetry(FF14_CN_ITEM_INDEX_URL, {
    ...(proxy ? { proxy } : {}),
    timeoutMs: FF14_CN_ITEM_INDEX_TIMEOUT_MS,
    retryCount: proxy ? FF14_PROXY_RETRY_COUNT : FF14_DIRECT_RETRY_COUNT,
    retryDelayMs: FF14_RETRY_DELAY_MS,
  });
  let response: Response;
  try {
    response = await request(proxyUrl || undefined);
  } catch (error) {
    if (!proxyUrl || isHttpResponseError(error)) {
      throw error;
    }
    response = await request();
  }

  return parseFf14CnItemIndex(await readResponseText(response, MAX_FF14_CN_ITEM_INDEX_BYTES));
};

const parseFf14CnItemIndex = (csv: string) => {
  const items = new Map<string, ItemSearchResult>();
  const itemRow = /(?:^|\n)(\d+),(?:"((?:[^"]|"")*)"|([^,\r\n]*)),/g;
  for (const match of csv.matchAll(itemRow)) {
    const id = Number(match[1]);
    const name = (match[2] ?? match[3] ?? "").replace(/""/g, "\"").trim();
    if (Number.isSafeInteger(id) && id > 0 && name) {
      items.set(normalizeFf14ItemQueryName(name), { ID: id, Name: name });
    }
  }
  return items;
};

export const createFf14PriceAlertKey = (groupId: string | number, itemName: string) =>
  `${String(groupId)}\0${normalizeFf14ItemQueryName(itemName)}`;

const fetchMarket = (
  marketApiUrl: string,
  regionName: string,
  itemId: number,
  proxyUrl: string,
  maxListingCount: number,
) => {
  const url = new URL(
    `${marketApiUrl.replace(/\/+$/, "")}/${encodeURIComponent(regionName)}/${itemId}`,
  );
  url.search = new URLSearchParams({
    listings: String(Math.max(1, Math.floor(maxListingCount))),
    entries: "0",
  }).toString();
  return fetchJson(url, marketResponseSchema, proxyUrl ? { proxy: proxyUrl } : {});
};

const fetchJsonOnce = async <T>(
  url: string | URL,
  schema: z.ZodType<T>,
  init: RequestInit & { proxy?: string } = {},
): Promise<T> => {
  await waitForFf14RequestSlot();
  // Bun's proxy option is useful in the container, but a stale/unavailable
  // proxy can close the socket before the upstream request is established.
  // Keep the configured proxy as the primary route and retry the same request
  // directly when that route fails at the transport layer. HTTP responses and
  // response parsing errors are deliberately not retried through another route.
  const { proxy, ...requestInit } = init;
  let response: Response;
  try {
    response = await fetchJsonResponse(url, requestInit, proxy);
  } catch (error) {
    if (!proxy || isHttpResponseError(error)) {
      throw error;
    }

    response = await fetchJsonResponse(url, requestInit);
  }

  return schema.parse(await readResponseJson(response, MAX_FF14_RESPONSE_BYTES));
};

const fetchJsonResponse = (
  url: string | URL,
  requestInit: RequestInit,
  proxy?: string,
) => fetchWithRetry(url, {
  ...requestInit,
  ...(proxy ? { proxy } : {}),
  timeoutMs: FETCH_TIMEOUT_MS,
  retryCount: proxy ? FF14_PROXY_RETRY_COUNT : FF14_DIRECT_RETRY_COUNT,
  retryDelayMs: FF14_RETRY_DELAY_MS,
});

const isHttpResponseError = (error: unknown) =>
  error instanceof Error &&
  typeof (error as Error & { status?: unknown }).status === "number";

const fetchJson = fetchJsonOnce;

function createFf14RequestGate(intervalMs: number) {
  let queue = Promise.resolve();
  let nextRequestAt = 0;
  return () => {
    const slot = queue.then(async () => {
      const waitMs = Math.max(0, nextRequestAt - Date.now());
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
      nextRequestAt = Date.now() + intervalMs;
    });
    queue = slot.catch(() => undefined);
    return slot;
  };
}

const selectDisplayListings = (listings: Listing[], maxListingCount: number): GroupedListing[] => [
  ...sortListingsByPrice(listings.filter((listing) => listing.hq === true)).map((listing) => ({
    quality: "HQ" as const,
    listing,
  })),
  ...sortListingsByPrice(listings.filter((listing) => listing.hq !== true)).map((listing) => ({
    quality: "NQ" as const,
    listing,
  })),
].slice(0, maxListingCount);

const sortListingsByPrice = (listings: Listing[]) =>
  [...listings].sort((left, right) => left.pricePerUnit - right.pricePerUnit);

const formatListingMessages = (listings: GroupedListing[]) => {
  const messages: string[] = [];
  const groupIndexes = {
    HQ: 0,
    NQ: 0,
  };
  let currentQuality: GroupedListing["quality"] | undefined;

  for (const groupedListing of listings) {
    if (groupedListing.quality !== currentQuality) {
      currentQuality = groupedListing.quality;
      messages.push(`✨ ${currentQuality} 低价挂单`);
    }

    groupIndexes[groupedListing.quality] += 1;
    messages.push(formatListing(groupedListing.listing, groupIndexes[groupedListing.quality]));
  }

  return messages;
};

const formatSummary = ({
  item,
  market,
  minimumPrice,
  regionName,
}: Ff14MarketResult & {
  minimumPrice?: number;
}) =>
  [
    `🪙 ${item.Name} · ${regionName}`,
    `道具 ID · ${item.ID}`,
    ...(minimumPrice === undefined ? [] : [`提醒线 · ${formatGil(minimumPrice)}`]),
    "",
    ...formatPriceLine("💰 最低单价", market.minPrice),
    ...formatPriceLine("NQ 最低", market.minPriceNQ),
    ...formatPriceLine("HQ 最低", market.minPriceHQ),
    ...formatPriceLine("平均单价", market.averagePrice),
    ...formatPriceLine("NQ 平均", market.averagePriceNQ),
    ...formatPriceLine("HQ 平均", market.averagePriceHQ),
    "",
    `📦 挂单 ${formatCount(market.listingsCount)} · 在售 ${formatCount(market.unitsForSale)} · 近期成交 ${formatCount(market.recentHistoryCount)}`,
    `🕒 更新于 ${formatUploadTime(market.lastUploadTime)}`,
  ].join("\n");

const formatPriceLine = (label: string, value: number | undefined) =>
  typeof value === "number" && value > 0 ? [`${label} · ${formatGil(value)}`] : [];

const formatListing = (listing: Listing, index: number) =>
  [
    `#${index} · ${listing.worldName ?? "未知服务器"}`,
    `💰 ${formatGil(listing.pricePerUnit)} / 件`,
    `📦 ${listing.quantity.toLocaleString("zh-CN")} 件 · 合计 ${formatGil(listing.total)}`,
    `🕒 最近复查 ${formatReviewTime(listing.lastReviewTime)}`,
  ].join("\n");

const formatGil = (value: number | undefined) => {
  if (typeof value !== "number" || value <= 0) {
    return "还没有报价";
  }

  return `${formatGilAmount(value)} gil`;
};

const formatGilAmount = (value: number) => Math.round(value).toLocaleString("zh-CN");

const formatCount = (value: number | undefined) =>
  typeof value === "number" ? value.toLocaleString("zh-CN") : "还没有数据";

const formatUploadTime = (value: number | undefined) => {
  if (typeof value !== "number" || value <= 0) {
    return "还没有数据";
  }

  return dayjs(value).format("YYYY年MM月DD日 HH:mm");
};

const formatReviewTime = (value: number | undefined) => {
  if (typeof value !== "number" || value <= 0) {
    return "还没有数据";
  }

  return dayjs.unix(value).format("YYYY年MM月DD日 HH:mm");
};

export const formatFf14BatchMessages = (
  batch: Ff14BatchResult,
  { now = new Date() }: { now?: Date } = {},
): string[] => [
  formatFf14BatchSummary(batch, now),
  ...chunkFf14BatchItems(batch.items, FF14_BATCH_NODE_ITEM_COUNT)
    .map((items) => items.map((item) => formatFf14BatchItem(item)).join("\n\n")),
];

/** 定时售卖提醒：只带这次价位有变化的商品。 */
export const formatFf14BatchAlertMessages = (
  batch: Ff14BatchResult,
  { now = new Date() }: { now?: Date } = {},
): string[] => [
  formatFf14BatchAlertSummary(batch, now),
  ...chunkFf14BatchItems(batch.items, FF14_BATCH_NODE_ITEM_COUNT)
    .map((items) => items.map((item) => formatFf14BatchItem(item)).join("\n\n")),
];

const formatFf14BatchAlertSummary = (batch: Ff14BatchResult, now: Date) =>
  [
    `🪙 FF14 售卖提醒 · ${batch.regionName}`,
    `有 ${batch.items.length} 个商品参考价达到售卖线，而且价位和上次提醒不一样`,
    ...(batch.sellPrice === undefined
      ? []
      : [`售卖线 ${formatGil(batch.sellPrice)} · 参考价取最低 ${batch.sampleSize} 条挂单的中位价`]),
    "",
    ...batch.items.map((item) => `· ${formatFf14BatchItemName(item)} · 参考 ${formatGil(item.referencePrice)}`),
    "",
    `🕒 ${dayjs(now).format("YYYY年MM月DD日 HH:mm")}`,
  ].join("\n");

const formatFf14BatchSummary = (batch: Ff14BatchResult, now: Date) => {
  const readyItems = batch.items.filter((item) => item.status === "ready");
  const sellableItems = readyItems.filter((item) => item.sellable === true);
  const waitingItems = readyItems.filter((item) => item.sellable === false);
  const headlineItems = batch.sellPrice === undefined ? readyItems : sellableItems;
  const unavailableItems = batch.items.filter((item) => item.status !== "ready");

  return [
    batch.sellPrice === undefined
      ? `🪙 ${batch.regionName} 批量查价 · ${batch.items.length} 个商品`
      : `🪙 ${batch.regionName} 批量查价 · ${batch.items.length} 个商品 · 达到售卖线 ${sellableItems.length} 个`,
    `按交易板单件价取最低 ${batch.sampleSize} 条挂单，参考价取它们的中位价`,
    ...(batch.sellPrice === undefined
      ? []
      : [`售卖线 ${formatGil(batch.sellPrice)} · 参考价达到它就值得上线挂单`]),
    "",
    ...(headlineItems.length === 0
      ? [batch.sellPrice === undefined
        ? "😴 这次没有拿到可参考的价格。"
        : "😴 暂时没有达到售卖线的商品，先不急着上线。"]
      : [
        batch.sellPrice === undefined
          ? `💰 行情参考（${headlineItems.length} 个）`
          : `✅ 达到售卖线（${headlineItems.length} 个）`,
        ...headlineItems.map(formatFf14BatchSummaryItem),
      ]),
    ...(waitingItems.length === 0
      ? []
      : ["", `⏸️ 还没到售卖线（${waitingItems.length} 个）`, ...waitingItems.map(formatFf14BatchSummaryItem)]),
    ...(unavailableItems.length === 0
      ? []
      : [
        "",
        `⚠️ 没查到（${unavailableItems.length} 个）`,
        ...unavailableItems.map((item) =>
          `· ${formatFf14BatchItemName(item)} · ${getFf14BatchUnavailableText(item.status)}`),
      ]),
    "",
    `🕒 查询于 ${dayjs(now).format("YYYY年MM月DD日 HH:mm")}`,
  ].join("\n");
};

const formatFf14BatchSummaryItem = (item: Ff14BatchItemResult) =>
  `· ${formatFf14BatchItemName(item)} · 参考 ${formatGil(item.referencePrice)}`;

const formatFf14BatchItem = (item: Ff14BatchItemResult) => {
  const displayName = formatFf14BatchItemName(item);
  if (item.status !== "ready") {
    return `⚠️ ${displayName}\n${getFf14BatchDetailText(item.status)}`;
  }

  return [
    `${formatFf14BatchBadge(item)} ${displayName} · 参考 ${formatGil(item.referencePrice)}`,
    `📉 前 ${item.samples.length} 条 ${formatFf14BatchSamplePrices(item.samples)} · 最低 ${formatGil(item.lowestPrice)}`,
  ].join("\n");
};

const formatFf14BatchBadge = (item: Ff14BatchItemResult) => {
  if (item.sellable === undefined) {
    return "💰";
  }

  return item.sellable ? "✅" : "⏸️";
};

const formatFf14BatchSamplePrices = (samples: readonly Ff14BatchSample[]) =>
  samples
    .map((sample) => `${formatGilAmount(sample.price)}${sample.hq ? "HQ" : ""}`)
    .join(" / ");

const formatFf14BatchItemName = (item: Ff14BatchItemResult) => item.item?.Name ?? item.itemName;

const getFf14BatchUnavailableText = (status: Ff14BatchItemStatus) => {
  if (status === "empty") return "市场板没有在售挂单";
  if (status === "failed") return "这次没查到";
  return "道具库里没找到这个名字";
};

const getFf14BatchDetailText = (status: Ff14BatchItemStatus) => {
  if (status === "empty") return "市场板暂时没有在售挂单，可能还没人卖，也可能数据还在路上。";
  if (status === "failed") return "这次没有查到行情，稍后再试一次就好。";
  return "道具库里没找到这个名字，检查一下 config/ff14.toml 里的写法。";
};

const chunkFf14BatchItems = (items: readonly Ff14BatchItemResult[], size: number) =>
  Array.from(
    { length: Math.ceil(items.length / size) },
    (_, index) => items.slice(index * size, (index + 1) * size),
  );
