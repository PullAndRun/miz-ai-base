import { z } from "zod";
import type { MizConfig } from "@/config";
import { fetchWithRetry } from "@/http";
import { getVtbRepository } from "@/vtb";

const FETCH_TIMEOUT_MS = 15_000;
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
  ids: string[];
  idSet: Set<string>;
};

const sentNewsByTarget = new Map<string, SentNewsCache>();
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
    const freshNews = (availableNews ?? await fetchFinanceNews(apiUrl))
      .filter((news) => !sentNews.idSet.has(news.id));
    if (freshNews.length === 0) {
      return [];
    }

    await deliver(freshNews);
    rememberSentNews(sentNews, freshNews);
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
  `财经快讯 · ${news.length} 条更新`,
  ...formatNewsItems(news),
  "市场信息变化较快，以上内容仅供参考。",
];

export const formatNewsItems = (news: readonly News[]) => news.map(formatNews);

export const formatScheduledNewsItems = (news: readonly News[]) =>
  [
    `财经快讯 · ${news.length} 条更新`,
    ...news.map((item, index) => [
      ...(news.length > 1 ? [`#${index + 1}`] : []),
      formatNews(item),
    ].join("\n")),
    "市场信息变化较快，以上内容仅供参考。",
  ];

export const createNoNewsMessage = () => "没有新的财经快讯。";

export const fetchFinanceNews = async (apiUrl: string): Promise<News[]> => {
  const response = await fetchWithRetry(apiUrl, {
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  const payload = financeNewsResponseSchema.parse(await response.json());
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
  const existingCache = sentNewsByTarget.get(targetKey);
  if (existingCache) {
    touchSentNewsCache(targetKey, existingCache);
    return existingCache;
  }

  const cache: SentNewsCache = { ids: [], idSet: new Set<string>() };
  try {
    const ids = await getVtbRepository(config).then((repository) =>
      repository.getDeliveredNewsIds(targetKey, MAX_SAVED_NEWS),
    );
    // Repository results are newest-first, while the in-memory queue evicts
    // from the front. Store oldest-first so freshly delivered IDs survive.
    cache.ids.push(...ids.slice(0, MAX_SAVED_NEWS).reverse());
    cache.idSet = new Set(cache.ids);
  } catch {
    // News remains usable if the optional persistence table has not been migrated yet.
  }
  touchSentNewsCache(targetKey, cache);
  return cache;
};

const touchSentNewsCache = (targetKey: string, cache: SentNewsCache) => {
  sentNewsByTarget.delete(targetKey);
  sentNewsByTarget.set(targetKey, cache);
  while (sentNewsByTarget.size > MAX_SENT_NEWS_TARGET_CACHES) {
    const oldestTarget = sentNewsByTarget.keys().next().value;
    if (oldestTarget === undefined) {
      return;
    }
    sentNewsByTarget.delete(oldestTarget);
  }
};

const rememberSentNews = (cache: SentNewsCache, news: readonly News[]) => {
  for (const item of news) {
    cache.ids.push(item.id);
    cache.idSet.add(item.id);
  }

  while (cache.ids.length > MAX_SAVED_NEWS) {
    const oldestId = cache.ids.shift();
    if (oldestId) {
      cache.idSet.delete(oldestId);
    }
  }
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
