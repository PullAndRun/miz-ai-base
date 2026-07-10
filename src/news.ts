import dayjs from "dayjs";
import { z } from "zod";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_SAVED_NEWS = 100;
const NEWS_LIMIT = 10;

const financeNewsItemSchema = z.looseObject({
  loc: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  publish_time: z.union([z.string(), z.number()]).optional(),
  third_url: z.string().min(1).optional(),
  content: z
    .looseObject({
      items: z.array(z.looseObject({ data: z.string().min(1).optional() })).optional(),
    })
    .optional(),
});

const financeNewsResponseSchema = z.looseObject({
  Result: z.looseObject({
    content: z.looseObject({
      list: z.array(financeNewsItemSchema).optional(),
    }),
  }),
});

export type News = {
  id: string;
  title: string;
  detail?: string;
  publishedAt?: string;
};

type SentNewsCache = {
  ids: string[];
  idSet: Set<string>;
};

const sentNewsByTarget = new Map<string, SentNewsCache>();
let deliveryQueue = Promise.resolve();

/** Serializes delivery so a story is recorded only after a successful send. */
export const deliverUnsentNews = async (
  apiUrl: string,
  targetKey: string,
  deliver: (news: readonly News[]) => Promise<void>,
): Promise<readonly News[]> => {
  let releaseQueue: (() => void) | undefined;
  const currentDelivery = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const previousDelivery = deliveryQueue;
  deliveryQueue = currentDelivery;

  await previousDelivery;
  try {
    const sentNews = getSentNewsCache(targetKey);
    const freshNews = (await fetchFinanceNews(apiUrl)).filter((news) => !sentNews.idSet.has(news.id));
    if (freshNews.length === 0) {
      return [];
    }

    await deliver(freshNews);
    rememberSentNews(sentNews, freshNews);
    return freshNews;
  } finally {
    releaseQueue?.();
  }
};

export const formatNewsMessages = (news: readonly News[]) => [
  [
    "╭─「 财经速递 」",
    `│ 为你整理 ${news.length} 条财经快讯`,
    "│ 市场动态，快速掌握",
    "╰────────────",
  ].join("\n"),
  ...formatNewsItems(news),
  "资讯瞬息万变，以上内容仅供参考。",
];

export const formatNewsItems = (news: readonly News[]) => news.map(formatNews);

export const createNoNewsMessage = () => "财经新闻雷达刚刚巡检完毕，暂无新的市场快讯。";

const fetchFinanceNews = async (apiUrl: string): Promise<News[]> => {
  const response = await fetch(apiUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`News API request failed: HTTP ${response.status}`);
  }

  const payload = financeNewsResponseSchema.parse(await response.json());
  const items = payload.Result.content.list ?? [];

  return items.slice(0, NEWS_LIMIT).flatMap((item) => {
    const detail = item.content?.items?.map((content) => content.data).find(Boolean);
    const title = item.title ?? detail;
    if (!title) {
      return [];
    }

    return [
      {
        id: `finance:${item.loc ?? item.third_url ?? title}`,
        title,
        detail: detail === title ? undefined : detail,
        publishedAt: formatTimestamp(item.publish_time),
      },
    ];
  });
};

const getSentNewsCache = (targetKey: string) => {
  const existingCache = sentNewsByTarget.get(targetKey);
  if (existingCache) {
    return existingCache;
  }

  const cache: SentNewsCache = { ids: [], idSet: new Set<string>() };
  sentNewsByTarget.set(targetKey, cache);
  return cache;
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

const formatNews = (news: News) =>
  [
    `• 标题：${news.title}`,
    `• 时间：${news.publishedAt ?? "未知"}`,
    "• 内容：",
    news.detail ?? "无",
  ].join("\n");

const formatTimestamp = (value: string | number | undefined) => {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? dayjs.unix(timestamp).format("MM-DD HH:mm")
    : undefined;
};
