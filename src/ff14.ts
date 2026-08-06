import dayjs from "dayjs";
import { z } from "zod";
import { fetchWithRetry, readResponseJson } from "@/http";

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
  pricePerUnit: z.number().nonnegative(),
  quantity: z.number().int().nonnegative(),
  total: z.number().nonnegative(),
  worldName: z.string().optional(),
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
) => {
  const uniqueUserIds = [...new Map(userIds.map((userId) => [String(userId), userId])).values()];
  return uniqueUserIds.flatMap((userId, index) => [
    { type: "at", data: { qq: userId } },
    {
      type: "text",
      data: {
        text: index === uniqueUserIds.length - 1
          ? " FF14 低价提醒已触发，请查看上方行情。"
          : " ",
      },
    },
  ]);
};

const DEFAULT_MAX_LISTING_COUNT = 10;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FF14_RESPONSE_BYTES = 5 * 1024 * 1024;
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
  const normalizedItemName = itemName.trim().normalize();
  const item = data.items.find((candidate) => candidate.name.trim().normalize() === normalizedItemName)
    ?? data.items[0];
  return item ? { ID: item.id, Name: item.name } : undefined;
};

export const normalizeFf14ItemQueryName = (itemName: string) => itemName.trim().normalize("NFKC");

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
  const response = await fetchWithRetry(url, {
    ...init,
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  return schema.parse(await readResponseJson(response, MAX_FF14_RESPONSE_BYTES));
};

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

  return `${Math.round(value).toLocaleString("zh-CN")} gil`;
};

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
