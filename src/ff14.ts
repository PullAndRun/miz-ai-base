import dayjs from "dayjs";
import { z } from "zod";
import { fetchWithRetry } from "@/http";

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
  itemSearchApiUrl: string;
  marketApiUrl: string;
};

export type Ff14MarketResult = {
  item: ItemSearchResult;
  market: MarketResponse;
  regionName: string;
};

const DEFAULT_MAX_LISTING_COUNT = 10;
const FETCH_TIMEOUT_MS = 15_000;

export const isFf14RegionKey = (value: string | undefined): value is Ff14RegionKey =>
  value !== undefined && value in FF14_REGION_NAMES;

export const queryFf14Market = async ({
  regionKey,
  itemName,
  itemSearchApiUrl,
  marketApiUrl,
}: Ff14MarketQuery): Promise<Ff14MarketResult | undefined> => {
  const item = await searchItem(itemName, itemSearchApiUrl);
  if (!item) {
    return undefined;
  }

  const regionName = FF14_REGION_NAMES[regionKey];
  const market = await fetchMarket(marketApiUrl, regionName, item.ID);

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
        `道具：${item.Name}（${item.ID}）`,
        `分区：${regionName}`,
        ...(minimumPrice === undefined ? [] : [`提醒价格：${formatGil(minimumPrice)}`]),
        "当前没有挂单，可能是暂时无人出售或市场数据尚未更新。",
      ].join("\n"),
    ];
  }

  return [
    formatSummary({ item, market, minimumPrice, regionName }),
    ...formatListingMessages(listings),
  ];
};

const searchItem = async (itemName: string, itemSearchApiUrl: string) => {
  const url = new URL(itemSearchApiUrl);
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

const fetchMarket = (marketApiUrl: string, regionName: string, itemId: number) =>
  fetchJson(
    `${marketApiUrl.replace(/\/+$/, "")}/${encodeURIComponent(regionName)}/${itemId}`,
    marketResponseSchema,
  );

const fetchJsonOnce = async <T>(url: string | URL, schema: z.ZodType<T>): Promise<T> => {
  const response = await fetchWithRetry(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  return schema.parse(await response.json());
};

const fetchJson = fetchJsonOnce;

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
      messages.push(`${currentQuality} 低价挂单`);
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
    `道具：${item.Name}（${item.ID}）`,
    `分区：${regionName}`,
    ...(minimumPrice === undefined ? [] : [`提醒价格：${formatGil(minimumPrice)}`]),
    `最低单价：${formatGil(market.minPrice)}`,
    `最低 NQ：${formatGil(market.minPriceNQ)}`,
    `最低 HQ：${formatGil(market.minPriceHQ)}`,
    `平均单价：${formatGil(market.averagePrice)}`,
    `平均 NQ：${formatGil(market.averagePriceNQ)}`,
    `平均 HQ：${formatGil(market.averagePriceHQ)}`,
    `挂单数量：${formatCount(market.listingsCount)}`,
    `在售件数：${formatCount(market.unitsForSale)}`,
    `近期成交：${formatCount(market.recentHistoryCount)}`,
    `更新时间：${formatUploadTime(market.lastUploadTime)}`,
  ].join("\n");

const formatListing = (listing: Listing, index: number) =>
  [
    `#${index} · ${listing.worldName ?? "未知服务器"}`,
    `单价：${formatGil(listing.pricePerUnit)}`,
    `数量：${listing.quantity.toLocaleString("zh-CN")} · 总价：${formatGil(listing.total)}`,
    `最后复查：${formatReviewTime(listing.lastReviewTime)}`,
  ].join("\n");

const formatGil = (value: number | undefined) => {
  if (typeof value !== "number" || value <= 0) {
    return "暂无报价";
  }

  return `${Math.round(value).toLocaleString("zh-CN")} gil`;
};

const formatCount = (value: number | undefined) =>
  typeof value === "number" ? value.toLocaleString("zh-CN") : "未提供";

const formatUploadTime = (value: number | undefined) => {
  if (typeof value !== "number" || value <= 0) {
    return "未提供";
  }

  return dayjs(value).format("YYYY年MM月DD日 HH:mm");
};

const formatReviewTime = (value: number | undefined) => {
  if (typeof value !== "number" || value <= 0) {
    return "未提供";
  }

  return dayjs.unix(value).format("YYYY年MM月DD日 HH:mm");
};
