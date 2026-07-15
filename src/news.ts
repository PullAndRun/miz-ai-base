import { z } from "zod";
import { createBoundedCache, readBoundedCache, writeBoundedCache } from "@/cache";
import type { MizConfig } from "@/config";
import { fetchWithRetry, readResponseJson } from "@/http";
import { getVtbRepository } from "@/vtb";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_NEWS_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_SAVED_NEWS = 100;
const MAX_SENT_NEWS_TARGET_CACHES = 500;
const NEWS_LIMIT = 10;

const financeNewsItemSchema = z.looseObject({
  loc: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  third_url: z.string().min(1).optional(),
  content: z
    .looseObject({
      // Baidu has returned this as both an array of blocks and an object
      // keyed by provider name. Keep it untyped here and normalize below.
      items: z.unknown().optional(),
    })
    .optional(),
});

const financeNewsResponseSchema = z.looseObject({
  Result: z.unknown().optional(),
  result: z.unknown().optional(),
  data: z.unknown().optional(),
});

export type News = {
  id: string;
  title: string;
  detail?: string;
};

type SentNewsCache = {
  ids: readonly string[];
  idSet: ReadonlySet<string>;
};

let sentNewsByTarget = createBoundedCache<string, SentNewsCache>(MAX_SENT_NEWS_TARGET_CACHES);
const deliveryQueues = new Map<string, Promise<void>>();

/** Serializes delivery so a story is recorded only after a successful send. */
export const deliverUnsentNews = async (
  config: MizConfig,
  apiUrl: string,
  targetKey: string,
  deliver: (news: readonly News[]) => Promise<void>,
  availableNews?: readonly News[],
): Promise<readonly News[]> => {
  let releaseQueue: (() => void) | undefined;
  const currentDelivery = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const previousDelivery = deliveryQueues.get(targetKey) ?? Promise.resolve();
  deliveryQueues.set(targetKey, currentDelivery);

  await previousDelivery;
  try {
    const sentNews = await getSentNewsCache(config, targetKey);
    const seenNewsIds = new Set(sentNews.idSet);
    const freshNews = (availableNews ?? await fetchFinanceNews(apiUrl)).filter((news) => {
      if (seenNewsIds.has(news.id)) {
        return false;
      }
      seenNewsIds.add(news.id);
      return true;
    });
    if (freshNews.length === 0) {
      return [];
    }

    await deliver(freshNews);
    sentNewsByTarget = writeBoundedCache(
      sentNewsByTarget,
      targetKey,
      rememberSentNews(sentNews, freshNews),
    );
    await persistDeliveredNews(config, targetKey, freshNews);
    return freshNews;
  } finally {
    releaseQueue?.();
    if (deliveryQueues.get(targetKey) === currentDelivery) {
      deliveryQueues.delete(targetKey);
    }
  }
};

export const formatNewsMessages = (news: readonly News[]) => [
  `📰 财经快讯送达 · ${news.length} 条新消息`,
  ...formatNewsItems(news),
  "消息跑得很快，做决定前记得再确认一下。",
];

export const formatNewsItems = (news: readonly News[]) => news.map(formatNews);

export const formatScheduledNewsItems = (news: readonly News[]) =>
  [
    `📰 财经快讯送达 · ${news.length} 条新消息`,
    ...news.map((item, index) => [
      ...(news.length > 1 ? [`#${index + 1}`] : []),
      formatNews(item),
    ].join("\n")),
    "消息跑得很快，做决定前记得再确认一下。",
  ];

export const createNoNewsMessage = () => "📰 暂时没有新快讯，消息栏现在很安静。";

export const fetchFinanceNews = async (apiUrl: string): Promise<News[]> => {
  const response = await fetchWithRetry(apiUrl, {
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  const payload = financeNewsResponseSchema.parse(await readResponseJson(response, MAX_NEWS_RESPONSE_BYTES));
  const items = findNewsItems(payload);
  const seenIds = new Set<string>();
  const news: News[] = [];

  for (const rawItem of items) {
    const item = financeNewsItemSchema.safeParse(rawItem);
    if (!item.success) {
      continue;
    }

    const detail = extractNewsDetail(item.data.content?.items);
    const title = item.data.title ?? detail;
    if (!title || title.trimStart().startsWith("简讯")) {
      continue;
    }

    const display = removeOverlappingText(title, detail);
    const id = `finance:${item.data.loc ?? item.data.third_url ?? display.title}`;
    if (seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    news.push({ id, ...display });
    if (news.length === NEWS_LIMIT) {
      break;
    }
  }

  return news;
};

const findNewsItems = (value: unknown, depth = 0): unknown[] => {
  if (depth > 5) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (isRecord(value)) {
    for (const key of ["list", "items"]) {
      const items = findNewsItems(value[key], depth + 1);
      if (items.length > 0) {
        return items;
      }
    }

    for (const key of ["Result", "result", "content", "data"]) {
      const items = findNewsItems(value[key], depth + 1);
      if (items.length > 0) {
        return items;
      }
    }

    for (const child of Object.values(value)) {
      const items = findNewsItems(child, depth + 1);
      if (items.length > 0) {
        return items;
      }
    }
  }

  return [];
};

const extractNewsDetail = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }

  if (Array.isArray(value)) {
    return value.map(extractNewsDetail).find(Boolean);
  }

  if (isRecord(value)) {
    // Prefer the conventional `data` field, then fall back to the first
    // non-empty text value for provider-specific response shapes.
    return extractNewsDetail(value.data) ?? Object.values(value).map(extractNewsDetail).find(Boolean);
  }

  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const removeOverlappingText = (title: string, detail: string | undefined) => {
  if (!detail) {
    return { title };
  }

  if (detail.includes(title)) {
    return { title: detail };
  }

  if (title.includes(detail)) {
    return { title };
  }

  return { title, detail };
};

const getSentNewsCache = async (config: MizConfig, targetKey: string) => {
  const existingCacheRead = readBoundedCache(sentNewsByTarget, targetKey);
  sentNewsByTarget = existingCacheRead.cache;
  const existingCache = existingCacheRead.value;
  if (existingCache) {
    return existingCache;
  }

  let cache: SentNewsCache = { ids: [], idSet: new Set<string>() };
  try {
    const ids = await getVtbRepository(config).then((repository) =>
      repository.getDeliveredNewsIds(targetKey, MAX_SAVED_NEWS),
    );
    // Repository results are newest-first, while the in-memory queue evicts
    // from the front. Store oldest-first so freshly delivered IDs survive.
    const cachedIds = ids.slice(0, MAX_SAVED_NEWS).reverse();
    cache = { ids: cachedIds, idSet: new Set(cachedIds) };
  } catch {
    // News remains usable if the optional persistence table has not been migrated yet.
  }
  sentNewsByTarget = writeBoundedCache(sentNewsByTarget, targetKey, cache);
  return cache;
};

const rememberSentNews = (cache: SentNewsCache, news: readonly News[]): SentNewsCache => {
  const ids = [...cache.ids, ...news.map((item) => item.id)].slice(-MAX_SAVED_NEWS);
  return { ids, idSet: new Set(ids) };
};

const persistDeliveredNews = async (config: MizConfig, targetKey: string, news: readonly News[]) => {
  try {
    const repository = await getVtbRepository(config);
    await repository.recordNewsDeliveries(
      targetKey,
      news.map((item) => item.id),
      MAX_SAVED_NEWS,
    );
  } catch {
    // The in-memory cache has already been updated, so a persistence issue must not resend news immediately.
  }
};

const formatNews = (news: News) =>
  [
    `• ${news.title}`,
    ...(news.detail ? [`  ${news.detail}`] : []),
  ].join("\n");
