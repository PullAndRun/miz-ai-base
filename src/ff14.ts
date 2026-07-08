import dayjs from "dayjs";
import { z } from "zod";

const itemSearchResultSchema = z.looseObject({
  ID: z.number().int().positive(),
  Name: z.string().min(1),
});

const searchResponseSchema = z.looseObject({
  Results: z.array(itemSearchResultSchema).optional().default([]),
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
};

export type Ff14MarketResult = {
  item: ItemSearchResult;
  market: MarketResponse;
  regionName: string;
};

const DEFAULT_MAX_LISTING_COUNT = 10;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_RETRY_COUNT = 3;
const FETCH_RETRY_DELAY_MS = 500;

export const isFf14RegionKey = (value: string | undefined): value is Ff14RegionKey =>
  value !== undefined && value in FF14_REGION_NAMES;

export const queryFf14Market = async ({
  regionKey,
  itemName,
}: Ff14MarketQuery): Promise<Ff14MarketResult | undefined> => {
  const item = await searchItem(itemName);
  if (!item) {
    return undefined;
  }

  const regionName = FF14_REGION_NAMES[regionKey];
  const market = await fetchMarket(regionName, item.ID);

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
        `道具: ${item.Name} (${item.ID})`,
        `分区: ${regionName}`,
        ...(minimumPrice === undefined ? [] : [`提醒价格: ${formatGil(minimumPrice)}`]),
        "结果: 当前没有可用市场挂单数据",
      ].join("\n"),
    ];
  }

  return [
    formatSummary({ item, market, minimumPrice, regionName }),
    ...formatListingMessages(listings),
  ];
};

const searchItem = async (itemName: string) => {
  const url = new URL("https://cafemaker.wakingsands.com/search");
  url.search = new URLSearchParams({
    indexes: "item",
    sort_order: "asc",
    limit: "1",
    columns: "ID,Name",
    string: itemName,
  }).toString();

  const data = await fetchJson(url, searchResponseSchema);
  return data.Results[0];
};

const fetchMarket = (regionName: string, itemId: number) =>
  fetchJson(
    `https://universalis.app/api/v2/${encodeURIComponent(regionName)}/${itemId}`,
    marketResponseSchema,
  );

const fetchJson = async <T>(url: string | URL, schema: z.ZodType<T>): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= FETCH_RETRY_COUNT; attempt += 1) {
    try {
      return await fetchJsonOnce(url, schema);
    } catch (error) {
      lastError = error;
      if (attempt === FETCH_RETRY_COUNT || !isRetryableFetchError(error)) {
        throw error;
      }

      await delay(FETCH_RETRY_DELAY_MS * 2 ** attempt);
    }
  }

  throw lastError;
};

const fetchJsonOnce = async <T>(url: string | URL, schema: z.ZodType<T>): Promise<T> => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new HttpStatusError(response.status, response.statusText);
  }

  return schema.parse(await response.json());
};

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
  ) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = "HttpStatusError";
  }
}

const isRetryableFetchError = (error: unknown) => {
  if (error instanceof z.ZodError) {
    return false;
  }

  if (error instanceof HttpStatusError) {
    return error.status === 429 || error.status >= 500;
  }

  return error instanceof Error;
};

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

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
      messages.push(`${currentQuality} 挂单（按单价从低到高）`);
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
    `道具: ${item.Name} (${item.ID})`,
    `分区: ${regionName}`,
    ...(minimumPrice === undefined ? [] : [`提醒价格: ${formatGil(minimumPrice)}`]),
    `最低单价: ${formatGil(market.minPrice)}`,
    `最低 NQ: ${formatGil(market.minPriceNQ)}`,
    `最低 HQ: ${formatGil(market.minPriceHQ)}`,
    `平均单价: ${formatGil(market.averagePrice)}`,
    `平均 NQ: ${formatGil(market.averagePriceNQ)}`,
    `平均 HQ: ${formatGil(market.averagePriceHQ)}`,
    `挂单数量: ${formatCount(market.listingsCount)}`,
    `在售件数: ${formatCount(market.unitsForSale)}`,
    `近期成交: ${formatCount(market.recentHistoryCount)}`,
    `数据时间: ${formatUploadTime(market.lastUploadTime)}`,
  ].join("\n");

const formatListing = (listing: Listing, index: number) =>
  [
    `挂单 ${index}`,
    `服务器: ${listing.worldName ?? "未知"}`,
    `单价: ${formatGil(listing.pricePerUnit)}`,
    `数量: ${listing.quantity.toLocaleString("zh-CN")}`,
    `总价: ${formatGil(listing.total)}`,
    `复查时间: ${formatReviewTime(listing.lastReviewTime)}`,
  ].join("\n");

const formatGil = (value: number | undefined) => {
  if (typeof value !== "number" || value <= 0) {
    return "暂无";
  }

  return `${Math.round(value).toLocaleString("zh-CN")} gil`;
};

const formatCount = (value: number | undefined) =>
  typeof value === "number" ? value.toLocaleString("zh-CN") : "未知";

const formatUploadTime = (value: number | undefined) => {
  if (typeof value !== "number" || value <= 0) {
    return "未知";
  }

  return dayjs(value).format("YYYY-MM-DD HH:mm:ss");
};

const formatReviewTime = (value: number | undefined) => {
  if (typeof value !== "number" || value <= 0) {
    return "未知";
  }

  return dayjs.unix(value).format("YYYY-MM-DD HH:mm:ss");
};
