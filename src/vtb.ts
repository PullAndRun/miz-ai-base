import dayjs from "dayjs";
import { XMLParser } from "fast-xml-parser";
import { PrismaPg } from "@prisma/adapter-pg";
import { createHash } from "node:crypto";
import {
  PrismaClient,
  type Activity,
  type ActivityRegistration,
  type GroupTodo,
  type Reminder,
  type ScheduleEvent,
} from "@/generated/prisma/client";
import { z } from "zod";
import { createExpiringCache, readExpiringCache, writeExpiringCache } from "@/cache";
import type { MizConfig, VtbConfig } from "@/config";
import { fetchWithRetry, readResponseBytes, readResponseJson, readResponseText } from "@/http";
import { partitionVtbSubscriptionsByGroup } from "@/vtb-subscriptions";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_DYNAMIC_DESCRIPTION_LENGTH = 1_800;
const VTB_RISK_COOLDOWN_MS = 30 * 60_000;
const VTB_TRANSIENT_COOLDOWN_MS = 15 * 60_000;
const VTB_TRANSIENT_FAILURE_THRESHOLD = 3;
const VTB_JSON_REQUEST_INTERVAL_MS = 250;
const VTB_DYNAMIC_REQUEST_INTERVAL_MS = 750;
const VTB_LIVE_QUERY_CACHE_MS = 60_000;
const VTB_IMAGE_CACHE_MS = 10 * 60_000;
const MAX_VTB_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VTB_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_VTB_IMAGE_CACHE_ENTRIES = 16;
const MAX_VTB_QUERY_CACHE_ENTRIES = 1_000;
const VTB_RISK_CODES = new Set([-352, -412, -509, -799]);
const textValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const userSchema = z.looseObject({
  uname: z.string().min(1),
  mid: z.union([z.string(), z.number()]),
  room_id: z.union([z.string(), z.number()]).optional(),
});
const userResponseSchema = z.looseObject({
  code: z.number(),
  data: z.looseObject({ result: z.array(userSchema).optional().default([]) }),
});
const cardResponseSchema = z.looseObject({
  code: z.number(),
  data: z.unknown().optional(),
});
const cardSchema = z.looseObject({
  mid: z.union([z.string(), z.number()]),
  fans: z.union([z.string(), z.number()]).optional(),
  name: z.string().min(1).optional(),
  face: z.string().nullish(),
  avatar: z.string().nullish(),
  avatar_url: z.string().nullish(),
});
const liveInfoSchema = z.looseObject({
  title: z.string().optional(),
  room_id: z.union([z.string(), z.number()]).optional(),
  live_time: z.union([z.string(), z.number()]).optional(),
  live_status: z.number().int().optional(),
  uname: z.string().optional(),
  cover_from_user: z.string().nullish(),
  keyframe: z.string().nullish(),
  user_cover: z.string().nullish(),
  cover: z.string().nullish(),
});
const liveResponseSchema = z.looseObject({
  code: z.number(),
  data: z.unknown().optional(),
});
const dynamicSchema = z.object({
  rss: z.object({
    channel: z.object({
      image: z.object({ url: z.string() }),
      item: z
        .array(
          z.object({
            title: textValueSchema,
            description: textValueSchema,
            pubDate: z.string(),
            link: z.string(),
            author: z.string(),
          }),
        )
        .min(1),
    }),
  }),
});

export type VtbStreamer = { name: string; mid: string; roomId?: string };
export type VtbLiveInfo = {
  title: string;
  roomId?: string;
  liveStartedAt?: Date;
  isLive: boolean;
  name: string;
  coverUrl?: string;
};
export type VtbDynamic = {
  title: string;
  description: string;
  containsDynamicUrl: boolean;
  publishedAt: Date;
  link: string;
  author: string;
};
export type VtbDynamicFeed = { avatarUrl: string; items: VtbDynamic[] };
export type LiveSession = {
  startedAt: Date;
  startFans?: number;
  roomId?: string;
  deliveredGroupIds: string[];
  endedAt?: Date;
  endFans?: number;
  endDeliveredGroupIds: string[];
};
export type VtbDynamicDeliveryState = {
  publishedAt: Date;
  deliveredGroupIds: string[];
};
export type VtbCardInfo = { fans?: number; name?: string; avatarUrl?: string };
type ReminderClaim = Reminder & { claimedAt: Date; nextRemindAt?: Date };
type ScheduleEventClaim = ScheduleEvent & { claimedAt: Date };
type ActivityClaim = Activity & { claimedAt: Date; registrations: ActivityRegistration[] };
type GroupTodoClaim = GroupTodo & { claimedAt: Date };

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (_name, jPath) => jPath === "rss.channel.item",
});

let repositoryPromise: Promise<VtbRepository> | undefined;
const vtbRequestStates = new Map<string, {
  consecutiveFailures: number;
  cooldownUntil: number;
  lastRequestAt: number;
  queue: Promise<void>;
}>();
const vtbInFlightRequests = new Map<string, Promise<unknown>>();
let vtbLiveQueryCache = createExpiringCache<string, VtbLiveInfo>(MAX_VTB_QUERY_CACHE_ENTRIES);
let vtbCardQueryCache = createExpiringCache<string, VtbCardInfo>(MAX_VTB_QUERY_CACHE_ENTRIES);
let vtbDynamicQueryCache = createExpiringCache<string, VtbDynamicFeed>(MAX_VTB_QUERY_CACHE_ENTRIES);
let vtbImageCache = createExpiringCache<string, string>(MAX_VTB_IMAGE_CACHE_ENTRIES);

export const getVtbRepository = async (config: MizConfig) => {
  if (!repositoryPromise) {
    repositoryPromise = createConfiguredVtbRepository(config);
  }

  try {
    return await repositoryPromise;
  } catch (error) {
    repositoryPromise = undefined;
    throw error;
  }
};

export const closeVtbRepository = async () => {
  const currentRepository = repositoryPromise;
  repositoryPromise = undefined;
  if (currentRepository) {
    await (await currentRepository).close();
  }
};

export const resolveVtbStreamer = async (name: string, config: VtbConfig): Promise<VtbStreamer | undefined> => {
  const url = `${config.userApiUrl}${encodeURIComponent(name)}`;
  const response = userResponseSchema.parse(
    await fetchJson(
      url,
      config.webUrl,
      config.bilibiliCookie ? { Cookie: config.bilibiliCookie } : undefined,
    ),
  );
  assertVtbApiSuccess(url, "user", response.code);

  const user = response.data.result.find((item) => item.uname === name);
  return user
    ? { name: user.uname, mid: String(user.mid), roomId: normalizeRoomId(user.room_id) }
    : undefined;
};

export const resolveTrackedVtbStreamer = async (
  name: string,
  config: VtbConfig,
  repository: VtbRepository,
) => {
  const storedStreamer = await repository.findStreamerByName(name);
  if (storedStreamer) {
    return storedStreamer;
  }

  const fetchedStreamer = await resolveVtbStreamer(name, config);
  return fetchedStreamer ? repository.upsertStreamer(fetchedStreamer) : undefined;
};

export const syncConfiguredVtbStreamers = async (config: MizConfig) => {
  const names = Array.from(
    new Set(config.vtb.subscriptions.flatMap((subscription) => subscription.streamers)),
  );
  const added: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  const repository = await getVtbRepository(config);
  const removed = await repository.deleteStreamersNotInNames(names);
  let nextIndex = 0;
  const workerCount = Math.min(4, names.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < names.length) {
        const name = names[nextIndex];
        nextIndex += 1;
        try {
          if (await repository.findStreamerByName(name)) {
            continue;
          }

          const streamer = await resolveVtbStreamer(name, config.vtb);
          if (!streamer) {
            skipped.push(name);
            continue;
          }

          await repository.upsertStreamer(streamer);
          added.push(name);
        } catch (error) {
          failed.push({ name, reason: formatSyncFailure(error) });
        }
      }
    }),
  );

  return { added, skipped, removed, failed };
};

export const partitionAvailableVtbSubscriptions = (
  subscriptions: MizConfig["vtb"]["subscriptions"],
  availableGroupIds: ReadonlySet<string>,
) => partitionVtbSubscriptionsByGroup(subscriptions, availableGroupIds);

export const syncVtbSubscriptionNames = async (config: MizConfig) => {
  const renamed: Array<{ previousName: string; name: string; mid: string }> = [];
  const roomUpdated: Array<{ name: string; mid: string; roomId: string }> = [];
  const failed: Array<{ name: string; reason: string }> = [];

  const databaseSync = await syncConfiguredVtbStreamers(config);
  const repository = await getVtbRepository(config);
  const streamers = await repository.listStreamers();
  if (streamers.length === 0) {
    return { databaseSync, renamed, roomUpdated, failed };
  }

  let cardInfos: Map<string, VtbCardInfo>;
  try {
    cardInfos = await getVtbCardInfos(streamers.map((streamer) => streamer.mid), config.vtb);
  } catch (error) {
    return {
      databaseSync,
      renamed,
      roomUpdated,
      failed: streamers.map((streamer) => ({ name: streamer.name, reason: formatSyncFailure(error) })),
    };
  }

  const matchedStreamers: Array<{ streamer: VtbStreamer; card: VtbCardInfo & { name: string } }> = [];
  for (const streamer of streamers) {
    const card = cardInfos.get(streamer.mid);
    if (!card?.name) {
      failed.push({ name: streamer.name, reason: `名片接口未返回 MID ${streamer.mid} 的昵称` });
      continue;
    }

    if (card.name !== streamer.name) {
      renamed.push({ previousName: streamer.name, name: card.name, mid: streamer.mid });
    }

    matchedStreamers.push({ streamer, card: { ...card, name: card.name } });
  }

  // Persist nickname changes before querying room IDs. A room API failure must
  // not leave the database and vtb.toml out of sync after the caller writes
  // the confirmed card nickname back to configuration.
  for (const { streamer, card } of matchedStreamers) {
    if (card.name !== streamer.name) {
      await repository.upsertStreamer({ ...streamer, name: card.name });
    }
  }

  let liveInfos: Map<string, VtbLiveInfo>;
  try {
    liveInfos = await getVtbLiveInfos(
      matchedStreamers.map((item) => item.streamer),
      config.vtb,
    );
  } catch (error) {
    const reason = formatSyncFailure(error);
    failed.push(...matchedStreamers.map(({ streamer }) => ({ name: streamer.name, reason })));
    return { databaseSync, renamed, roomUpdated, failed };
  }

  for (const { streamer, card } of matchedStreamers) {
    const live = liveInfos.get(streamer.mid);
    if (!live) {
      failed.push({ name: streamer.name, reason: `直播接口未返回 MID ${streamer.mid}` });
      continue;
    }
    if (card.name !== streamer.name || (live.roomId && live.roomId !== streamer.roomId)) {
      await repository.upsertStreamer({
        ...streamer,
        name: card.name,
        roomId: live.roomId,
      });
    }
    if (live.roomId && live.roomId !== streamer.roomId) {
      roomUpdated.push({ name: card.name, mid: streamer.mid, roomId: live.roomId });
    }
  }

  return { databaseSync, renamed, roomUpdated, failed };
};

export const getVtbFanCount = async (mid: string, config: VtbConfig) => {
  return (await getVtbCardInfo(mid, config)).fans;
};

export const getVtbCardInfo = async (mid: string, config: VtbConfig): Promise<VtbCardInfo> => {
  const cacheKey = getVtbCardCacheKey(config, mid);
  const cacheRead = readExpiringCache(vtbCardQueryCache, cacheKey, Date.now());
  vtbCardQueryCache = cacheRead.cache;
  const cached = cacheRead.value;
  if (cached) {
    return cached;
  }
  return (await getVtbCardInfos([mid], config)).get(mid) ?? {};
};

export const getVtbCardInfos = async (mids: readonly string[], config: VtbConfig) => {
  const uniqueMids = Array.from(new Set(mids));
  const cards = new Map<string, VtbCardInfo>();
  for (const batch of chunk(uniqueMids, 50)) {
    const url = createCardApiUrl(config.cardApiUrl, batch);
    const response = cardResponseSchema.parse(
      await fetchJson(
        url,
        config.webUrl,
        config.bilibiliCookie ? { Cookie: config.bilibiliCookie } : undefined,
      ),
    );
    if (response.code !== 0) {
      recordVtbBusinessFailure(url, response.code);
      throw new Error(
        response.code === -101
          ? "Bilibili card API rejected the configured cookie: code -101"
          : `Bilibili card API failed: code ${response.code}`,
      );
    }
    recordVtbRequestSuccess(url);

    for (const rawCard of extractCardRecords(response.data)) {
      const parsedCard = cardSchema.safeParse(rawCard);
      if (!parsedCard.success) {
        continue;
      }

      const fans = Number(parsedCard.data.fans);
      cards.set(String(parsedCard.data.mid), {
        fans: Number.isFinite(fans) ? fans : undefined,
        name: parsedCard.data.name?.trim() || undefined,
        avatarUrl: pickImageUrl(
          parsedCard.data.face,
          parsedCard.data.avatar,
          parsedCard.data.avatar_url,
        ),
      });
    }
    const cacheTimeToLiveMs = (config.cardCacheMinutes ?? 30) * 60_000;
    for (const mid of batch) {
      vtbCardQueryCache = writeExpiringCache(
        vtbCardQueryCache,
        getVtbCardCacheKey(config, mid),
        cards.get(mid) ?? {},
        cacheTimeToLiveMs,
        Date.now(),
      );
    }
  }

  return cards;
};

export const getVtbLiveInfo = async (streamer: VtbStreamer, config: VtbConfig): Promise<VtbLiveInfo> => {
  const cacheKey = getVtbLiveCacheKey(config, streamer.mid);
  const cacheRead = readExpiringCache(vtbLiveQueryCache, cacheKey, Date.now());
  vtbLiveQueryCache = cacheRead.cache;
  const cached = cacheRead.value;
  if (cached) {
    return cached;
  }
  const live = (await getVtbLiveInfos([streamer], config)).get(streamer.mid);
  if (!live) {
    throw new Error(`Bilibili live API omitted streamer ${streamer.mid}`);
  }
  return live;
};

export const getVtbLiveInfos = async (streamers: readonly VtbStreamer[], config: VtbConfig) => {
  const results = new Map<string, VtbLiveInfo>();
  const uniqueStreamers = Array.from(
    new Map(streamers.map((streamer) => [streamer.mid, streamer])).values(),
  );
  for (const batch of chunk(uniqueStreamers, 50)) {
    const url = config.liveApiUrl;
    const response = liveResponseSchema.parse(
      await fetchJson(url, config.webUrl, config.bilibiliCookie ? { Cookie: config.bilibiliCookie } : undefined, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uids: batch.map((streamer) => streamer.mid) }),
      }),
    );
    assertVtbApiSuccess(url, "live", response.code);

    for (const streamer of batch) {
      const live = findLiveInfo(response.data, streamer.mid);
      if (live) {
        results.set(streamer.mid, toVtbLiveInfo(streamer, live));
      } else if (!normalizeRoomId(streamer.roomId)) {
        // Bilibili omits users without a live room from this batch endpoint.
        // That is a normal offline state, not a failed lookup.
        results.set(streamer.mid, toVtbLiveInfo({ ...streamer, roomId: undefined }, undefined));
      }
      const result = results.get(streamer.mid);
      if (result) {
        vtbLiveQueryCache = writeExpiringCache(
          vtbLiveQueryCache,
          getVtbLiveCacheKey(config, streamer.mid),
          result,
          VTB_LIVE_QUERY_CACHE_MS,
          Date.now(),
        );
      }
    }
  }

  return results;
};

export const getVtbDynamics = async (
  streamer: VtbStreamer,
  config: VtbConfig,
  retryCount = 0,
): Promise<VtbDynamicFeed> => {
  const dynamicUrl = `${config.dynamicApiUrl}${encodeURIComponent(streamer.mid)}`;
  const cacheRead = readExpiringCache(vtbDynamicQueryCache, dynamicUrl, Date.now());
  vtbDynamicQueryCache = cacheRead.cache;
  const cached = cacheRead.value;
  if (cached) {
    return cached;
  }
  const channel = dynamicSchema.parse(xmlParser.parse(await fetchDynamicText(dynamicUrl, retryCount))).rss.channel;
  const feed = {
    avatarUrl: channel.image.url,
    items: channel.item
      .map((item) => {
        const description = cleanDynamicText(String(item.description));
        const dynamicUrl = formatDynamicUrl(item.link, config.webUrl);
        return {
          title: String(item.title),
          description: truncateDynamicText(description),
          containsDynamicUrl: description.includes(item.link) || description.includes(dynamicUrl),
          publishedAt: parseRssDate(item.pubDate),
          link: item.link,
          author: item.author,
        };
      })
      .filter((item): item is VtbDynamic => item.publishedAt !== undefined)
      .sort((left, right) => right.publishedAt.getTime() - left.publishedAt.getTime()),
  };
  vtbDynamicQueryCache = writeExpiringCache(
    vtbDynamicQueryCache,
    dynamicUrl,
    feed,
    getVtbDynamicQueryCacheMs(config),
    Date.now(),
  );
  return feed;
};

export const getVtbImageFile = async (imageUrl: string | undefined, config: VtbConfig) => {
  const url = cleanImageUrl(imageUrl);
  if (!url) {
    return undefined;
  }

  const cacheKey = `${url}\n${config.webUrl}\n${getVtbCredentialKey(config.bilibiliCookie)}`;
  const cacheRead = readExpiringCache(vtbImageCache, cacheKey, Date.now());
  vtbImageCache = cacheRead.cache;
  const cached = cacheRead.value;
  if (cached) {
    return cached;
  }

  const requestHeaders = createVtbRequestHeaders(
    config.webUrl,
    config.bilibiliCookie ? { Cookie: config.bilibiliCookie } : undefined,
  );
  const requestInit = { headers: requestHeaders } satisfies RequestInit;
  const file = await runProtectedVtbRequest(
    url,
    requestInit,
    VTB_JSON_REQUEST_INTERVAL_MS,
    async () => {
      const response = await fetchWithRetry(url, {
        ...requestInit,
        timeoutMs: FETCH_TIMEOUT_MS,
        retryCount: 1,
        retryDelayMs: 2_000,
        retryJitterMs: 2_000,
        retryRateLimited: false,
      });
      const contentType = response.headers.get("content-type")?.toLowerCase();
      if (contentType && !contentType.startsWith("image/") && contentType !== "application/octet-stream") {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`VTB image response has unsupported content type: ${contentType}`);
      }
      const bytes = await readResponseBytes(response, MAX_VTB_IMAGE_BYTES);
      if (bytes.length === 0) {
        throw new Error("VTB image response is empty");
      }
      return `base64://${bytes.toString("base64")}`;
    },
  );
  recordVtbRequestSuccess(url);
  vtbImageCache = writeExpiringCache(
    vtbImageCache,
    cacheKey,
    file,
    VTB_IMAGE_CACHE_MS,
    Date.now(),
  );
  return file;
};

export type VtbRepository = ReturnType<typeof createVtbRepository>;

/** The persistence adapter is a closure over Prisma, not an object with mutable instance state. */
const createVtbRepository = (prisma: PrismaClient) => {
  const initialize = async () => {
    // Validate the connection without discarding delivery state. Active and
    // partially delivered sessions must survive restarts and hot reloads.
    await prisma.vtbStreamer.findFirst({ select: { mid: true } });
  };

  const findStreamerByName = async (name: string): Promise<VtbStreamer | undefined> => {
    const streamer = await prisma.vtbStreamer.findFirst({ where: { name } });
    return streamer ? fromStoredStreamer(streamer) : undefined;
  };

  const listStreamers = async (): Promise<VtbStreamer[]> => {
    const streamers = await prisma.vtbStreamer.findMany({ orderBy: { updatedAt: "asc" } });
    return streamers.map(fromStoredStreamer);
  };

  const deleteStreamersNotInNames = async (names: readonly string[]) => {
    const staleStreamers = await prisma.vtbStreamer.findMany({
      where: names.length > 0 ? { name: { notIn: [...names] } } : {},
      select: { mid: true, name: true },
    });
    if (staleStreamers.length === 0) {
      return [];
    }

    const mids = staleStreamers.map((streamer) => streamer.mid);
    await prisma.$transaction([
      prisma.vtbLiveSession.deleteMany({ where: { streamerMid: { in: mids } } }),
      prisma.vtbDynamicState.deleteMany({ where: { streamerMid: { in: mids } } }),
      prisma.vtbStreamer.deleteMany({ where: { mid: { in: mids } } }),
    ]);
    return staleStreamers.map((streamer) => streamer.name);
  };

  const deleteStreamersByMids = async (mids: readonly bigint[]) => {
    if (mids.length === 0) return;
    await prisma.$transaction([
      prisma.vtbLiveSession.deleteMany({ where: { streamerMid: { in: [...mids] } } }),
      prisma.vtbDynamicState.deleteMany({ where: { streamerMid: { in: [...mids] } } }),
      prisma.vtbStreamer.deleteMany({ where: { mid: { in: [...mids] } } }),
    ]);
  };

  const deleteStreamerByName = async (name: string) => {
    const streamer = await prisma.vtbStreamer.findFirst({
      where: { name },
      select: { mid: true },
    });
    if (!streamer) {
      return false;
    }

    await deleteStreamersByMids([streamer.mid]);
    return true;
  };

  const upsertStreamer = async (streamer: VtbStreamer): Promise<VtbStreamer> => {
    const storedStreamer = await prisma.vtbStreamer.upsert({
      where: { mid: toMid(streamer.mid) },
      create: { mid: toMid(streamer.mid), name: streamer.name, liveRoom: toOptionalMid(streamer.roomId) },
      update: { name: streamer.name, liveRoom: toOptionalMid(streamer.roomId) },
    });
    return fromStoredStreamer(storedStreamer);
  };

  const getLiveSession = async (mid: string): Promise<LiveSession | undefined> => {
    const session = await prisma.vtbLiveSession.findUnique({ where: { streamerMid: toMid(mid) } });
    return session
      ? {
          startedAt: session.startedAt,
          startFans: session.startFans ?? undefined,
          roomId: session.liveRoom?.toString(),
          deliveredGroupIds: session.deliveredGroupIds,
          endedAt: session.endedAt ?? undefined,
          endFans: session.endFans ?? undefined,
          endDeliveredGroupIds: session.endDeliveredGroupIds,
        }
      : undefined;
  };

  const startLiveSession = async (
    streamer: VtbStreamer,
    live: VtbLiveInfo,
    fans?: number,
    deliveredGroupIds: readonly string[] = [],
  ) => {
    await prisma.vtbLiveSession.upsert({
      where: { streamerMid: toMid(streamer.mid) },
      create: {
        streamerMid: toMid(streamer.mid),
        streamerName: live.name,
        liveRoom: toOptionalMid(live.roomId),
        startedAt: live.liveStartedAt ?? new Date(),
        startFans: fans,
        deliveredGroupIds: [...deliveredGroupIds],
        endDeliveredGroupIds: [],
      },
      update: {
        streamerName: live.name,
        liveRoom: toOptionalMid(live.roomId),
        startedAt: live.liveStartedAt ?? new Date(),
        startFans: fans,
        deliveredGroupIds: [...deliveredGroupIds],
        endDeliveredGroupIds: [],
        endedAt: null,
        endFans: null,
      },
    });
  };

  const recordLiveDelivery = async (mid: string, groupIds: readonly string[]) => {
    if (groupIds.length === 0) return;
    await prisma.vtbLiveSession.update({
      where: { streamerMid: toMid(mid) },
      data: { deliveredGroupIds: { push: [...groupIds] } },
    });
  };

  const markLiveSessionEnded = async (mid: string, fans?: number, endedAt = new Date()) => {
    await prisma.vtbLiveSession.update({
      where: { streamerMid: toMid(mid) },
      data: { endedAt, endFans: fans },
    });
  };

  const recordLiveEndDelivery = async (mid: string, groupIds: readonly string[]) => {
    if (groupIds.length === 0) return;
    await prisma.vtbLiveSession.update({
      where: { streamerMid: toMid(mid) },
      data: { endDeliveredGroupIds: { push: [...groupIds] } },
    });
  };

  const getDynamicDeliveryState = async (mid: string): Promise<VtbDynamicDeliveryState | undefined> => {
    const state = await prisma.vtbDynamicState.findUnique({ where: { streamerMid: toMid(mid) } });
    return state ? { publishedAt: state.lastPublishedAt, deliveredGroupIds: state.deliveredGroupIds } : undefined;
  };

  const startDynamicDelivery = async (mid: string, publishedAt: Date, deliveredGroupIds: readonly string[] = []) => {
    await prisma.vtbDynamicState.upsert({
      where: { streamerMid: toMid(mid) },
      create: { streamerMid: toMid(mid), lastPublishedAt: publishedAt, deliveredGroupIds: [...deliveredGroupIds] },
      update: { lastPublishedAt: publishedAt, deliveredGroupIds: [...deliveredGroupIds] },
    });
  };

  const recordDynamicDelivery = async (mid: string, groupIds: readonly string[]) => {
    if (groupIds.length === 0) return;
    await prisma.vtbDynamicState.update({
      where: { streamerMid: toMid(mid) },
      data: { deliveredGroupIds: { push: [...groupIds] } },
    });
  };

  const getDeliveredNewsIds = async (targetKey: string, maximumCount: number) => {
    const deliveries = await prisma.newsDelivery.findMany({
      where: { targetKey },
      orderBy: { deliveredAt: "desc" },
      take: maximumCount,
      select: { newsId: true },
    });
    return deliveries.map((delivery) => delivery.newsId);
  };

  const recordNewsDeliveries = async (targetKey: string, newsIds: readonly string[], maximumCount: number) => {
    if (newsIds.length === 0) {
      return;
    }

    await prisma.$transaction(async (transaction) => {
      await transaction.newsDelivery.createMany({
        data: newsIds.map((newsId) => ({ targetKey, newsId })),
        skipDuplicates: true,
      });
      const retained = await transaction.newsDelivery.findMany({
        where: { targetKey },
        orderBy: { deliveredAt: "desc" },
        take: maximumCount,
        select: { newsId: true },
      });
      await transaction.newsDelivery.deleteMany({
        where: {
          targetKey,
          newsId: { notIn: retained.map((delivery) => delivery.newsId) },
        },
      });
    });
  };

  const ensureReminderStorage = async () => prisma.reminder.findFirst({ select: { id: true } });

  const createReminder = async ({
    groupId,
    creatorId,
    targetId,
    content,
    remindAt,
    repeatIntervalMinutes,
  }: {
    groupId: string | number; creatorId: string | number; targetId: string | number; content: string; remindAt: Date; repeatIntervalMinutes?: number;
  }) => {
    return prisma.reminder.create({
      data: {
        groupId: String(groupId),
        creatorId: String(creatorId),
        targetId: String(targetId),
        content,
        remindAt,
        repeatIntervalMinutes: repeatIntervalMinutes ?? null,
      },
    });
  };

  const claimDueReminders = async (now: Date, maximumCount: number) => {
    const candidates = await prisma.reminder.findMany({
      where: { sentAt: null, remindAt: { lte: now } },
      orderBy: { remindAt: "asc" },
      take: maximumCount,
    });
    const claimed: ReminderClaim[] = [];

    for (const reminder of candidates) {
      const nextRemindAt = reminder.repeatIntervalMinutes
        ? getNextReminderTime(reminder.remindAt, reminder.repeatIntervalMinutes, now)
        : undefined;
      const result = await prisma.reminder.updateMany({
        where: { id: reminder.id, sentAt: null, remindAt: reminder.remindAt },
        data: reminder.repeatIntervalMinutes
          ? { remindAt: nextRemindAt, lastSentAt: now }
          : { sentAt: now, lastSentAt: now },
      });
      if (result.count === 1) {
        claimed.push({ ...reminder, claimedAt: now, nextRemindAt });
      }
    }

    return claimed;
  };

  const releaseReminderClaim = async (reminder: ReminderClaim) => {
    if (reminder.repeatIntervalMinutes) {
      return prisma.reminder.updateMany({
        where: {
          id: reminder.id,
          sentAt: null,
          remindAt: reminder.nextRemindAt,
          lastSentAt: reminder.claimedAt,
        },
        data: { remindAt: reminder.remindAt, lastSentAt: null },
      });
    }

    return prisma.reminder.updateMany({
      where: { id: reminder.id, sentAt: reminder.claimedAt },
      data: { sentAt: null, lastSentAt: null },
    });
  };

  const listPendingReminders = async (groupId: string | number, creatorId?: string | number) => {
    return prisma.reminder.findMany({
      where: {
        groupId: String(groupId),
        sentAt: null,
        ...(creatorId === undefined ? {} : { creatorId: String(creatorId) }),
      },
      orderBy: { remindAt: "asc" },
    });
  };

  const findPendingReminder = async (id: number, groupId: string | number) => {
    return prisma.reminder.findFirst({
      where: { id, groupId: String(groupId), sentAt: null },
    });
  };

  const cancelPendingReminder = async (id: number, groupId: string | number) => {
    return prisma.reminder.deleteMany({
      where: { id, groupId: String(groupId), sentAt: null },
    });
  };

  const editPendingReminder = async ({
    id,
    groupId,
    targetId,
    content,
    remindAt,
    repeatIntervalMinutes,
  }: {
    id: number; groupId: string | number; targetId: string | number; content: string; remindAt: Date; repeatIntervalMinutes?: number;
  }) => {
    return prisma.reminder.updateMany({
      where: { id, groupId: String(groupId), sentAt: null },
      data: {
        targetId: String(targetId),
        content,
        remindAt,
        repeatIntervalMinutes: repeatIntervalMinutes ?? null,
      },
    });
  };

  const ensureScheduleStorage = async () => prisma.scheduleEvent.findFirst({ select: { id: true } });

  const createScheduleEvent = async ({
    groupId,
    creatorId,
    content,
    eventAt,
    remindAt,
  }: { groupId: string | number; creatorId: string | number; content: string; eventAt: Date; remindAt: Date }) => {
    return prisma.$transaction(async (transaction) => {
      // Schedule IDs are user-facing and independent for each group.
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${String(groupId)}))`;
      await transaction.scheduleEvent.deleteMany({
        where: { groupId: String(groupId), eventAt: { lte: new Date() }, remindedAt: { not: null } },
      });
      const previous = await transaction.scheduleEvent.findFirst({
        where: { groupId: String(groupId) },
        orderBy: { displayId: "desc" },
        select: { displayId: true },
      });

      return transaction.scheduleEvent.create({
        data: {
          groupId: String(groupId),
          displayId: (previous?.displayId ?? 0) + 1,
          creatorId: String(creatorId),
          content,
          eventAt,
          remindAt,
        },
      });
    });
  };

  const listUpcomingScheduleEvents = async (groupId: string | number) => {
    return prisma.scheduleEvent.findMany({
      where: { groupId: String(groupId), eventAt: { gte: new Date() } },
      orderBy: { eventAt: "asc" },
    });
  };

  const cancelUpcomingScheduleEvent = async (displayId: number, groupId: string | number) => {
    return prisma.scheduleEvent.deleteMany({
      where: { displayId, groupId: String(groupId), eventAt: { gt: new Date() }, remindedAt: null },
    });
  };

  const claimDueScheduleEvents = async (now: Date, maximumCount: number) => {
    const candidates = await prisma.scheduleEvent.findMany({
      where: { remindedAt: null, remindAt: { lte: now } },
      orderBy: { remindAt: "asc" },
      take: maximumCount,
    });
    const claimed: ScheduleEventClaim[] = [];

    for (const event of candidates) {
      const result = await prisma.scheduleEvent.updateMany({
        where: { id: event.id, remindedAt: null },
        data: { remindedAt: now },
      });
      if (result.count === 1) {
        claimed.push({ ...event, claimedAt: now });
      }
    }

    return claimed;
  };

  const releaseScheduleEventClaim = async (event: ScheduleEventClaim) => {
    return prisma.scheduleEvent.updateMany({
      where: { id: event.id, remindedAt: event.claimedAt },
      data: { remindedAt: null },
    });
  };

  const cleanupFinishedScheduleEvents = async (now = new Date()) => {
    return prisma.scheduleEvent.deleteMany({
      where: { eventAt: { lte: now }, remindedAt: { not: null } },
    });
  };

  const ensureActivityStorage = async () => prisma.activity.findFirst({ select: { id: true } });

  const createActivity = async ({
    groupId,
    creatorId,
    content,
    eventAt,
    remindAt,
  }: { groupId: string | number; creatorId: string | number; content: string; eventAt: Date; remindAt: Date }) => {
    return prisma.$transaction(async (transaction) => {
      const groupKey = String(groupId);
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`activity:${groupKey}`}))`;
      await transaction.activity.deleteMany({ where: { groupId: groupKey, eventAt: { lte: new Date() } } });
      const previous = await transaction.activity.findFirst({
        where: { groupId: groupKey },
        orderBy: { displayId: "desc" },
        select: { displayId: true },
      });

      return transaction.activity.create({
        data: {
          groupId: groupKey,
          displayId: (previous?.displayId ?? 0) + 1,
          creatorId: String(creatorId),
          content,
          eventAt,
          remindAt,
        },
      });
    });
  };

  const listUpcomingActivities = async (groupId: string | number) => {
    return prisma.activity.findMany({
      where: { groupId: String(groupId), eventAt: { gt: new Date() } },
      include: { _count: { select: { registrations: true } } },
      orderBy: { eventAt: "asc" },
    });
  };

  const joinActivity = async (
    displayId: number,
    groupId: string | number,
    userId: string | number,
    maximumParticipants: number,
  ) => {
    return prisma.$transaction(async (transaction) => {
      const candidate = await transaction.activity.findFirst({
        where: { displayId, groupId: String(groupId), eventAt: { gt: new Date() } },
      });
      if (!candidate) {
        return { status: "not_found" as const };
      }

      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`activity-registration:${candidate.id}`}))`;
      const activity = await transaction.activity.findFirst({
        where: { id: candidate.id, eventAt: { gt: new Date() } },
      });
      if (!activity) {
        return { status: "not_found" as const };
      }
      const normalizedUserId = String(userId);
      const existing = await transaction.activityRegistration.findUnique({
        where: { activityId_userId: { activityId: activity.id, userId: normalizedUserId } },
      });
      if (existing) {
        return { status: "already_joined" as const, activity };
      }

      const participantCount = await transaction.activityRegistration.count({ where: { activityId: activity.id } });
      if (participantCount >= maximumParticipants) {
        return { status: "full" as const, activity, participantCount };
      }

      await transaction.activityRegistration.create({
        data: { activityId: activity.id, userId: normalizedUserId },
      });
      return { status: "joined" as const, activity, participantCount: participantCount + 1 };
    });
  };

  const leaveActivity = async (displayId: number, groupId: string | number, userId: string | number) => {
    const activity = await prisma.activity.findFirst({
      where: { displayId, groupId: String(groupId), eventAt: { gt: new Date() } },
      select: { id: true },
    });
    if (!activity) {
      return { status: "not_found" as const };
    }

    const result = await prisma.activityRegistration.deleteMany({
      where: { activityId: activity.id, userId: String(userId) },
    });
    return { status: result.count === 1 ? "left" as const : "not_joined" as const };
  };

  const cancelUpcomingActivity = async (displayId: number, groupId: string | number) => {
    return prisma.$transaction(async (transaction) => {
      const activity = await transaction.activity.findFirst({
        where: { displayId, groupId: String(groupId), eventAt: { gt: new Date() } },
        select: { id: true },
      });
      if (!activity) return { count: 0 };
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`activity-registration:${activity.id}`}))`;
      return transaction.activity.deleteMany({
        where: { id: activity.id, eventAt: { gt: new Date() } },
      });
    });
  };

  const claimDueActivities = async (now: Date, maximumCount: number) => {
    const candidates = await prisma.activity.findMany({
      where: { remindedAt: null, remindAt: { lte: now }, eventAt: { gt: now } },
      include: { registrations: { orderBy: { joinedAt: "asc" } } },
      orderBy: { remindAt: "asc" },
      take: maximumCount,
    });
    const claimed: ActivityClaim[] = [];

    for (const activity of candidates) {
      const result = await prisma.activity.updateMany({
        where: { id: activity.id, remindedAt: null },
        data: { remindedAt: now },
      });
      if (result.count === 1) {
        const registrations = await prisma.activityRegistration.findMany({
          where: { activityId: activity.id },
          orderBy: { joinedAt: "asc" },
        });
        claimed.push({ ...activity, registrations, claimedAt: now });
      }
    }

    return claimed;
  };

  const releaseActivityClaim = async (activity: ActivityClaim) => {
    return prisma.activity.updateMany({
      where: { id: activity.id, remindedAt: activity.claimedAt },
      data: { remindedAt: null },
    });
  };

  const cleanupFinishedActivities = async (now = new Date()) => {
    return prisma.activity.deleteMany({ where: { eventAt: { lte: now } } });
  };

  const ensureFaqStorage = async () => prisma.faqEntry.findFirst({ select: { id: true } });

  const listFaqEntries = async (groupId: string | number) => {
    return prisma.faqEntry.findMany({
      where: { groupId: String(groupId) },
      orderBy: { keyword: "asc" },
    });
  };

  const findFaqEntry = async (groupId: string | number, keyword: string) => {
    return prisma.faqEntry.findUnique({
      where: { groupId_keyword: { groupId: String(groupId), keyword } },
    });
  };

  const createFaqEntry = async ({
    groupId,
    keyword,
    answer,
    creatorId,
    maximumEntries,
  }: {
    groupId: string | number; keyword: string; answer: string; creatorId: string | number; maximumEntries: number;
  }) => {
    return prisma.$transaction(async (transaction) => {
      const groupKey = String(groupId);
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`faq:${groupKey}`}))`;
      const existing = await transaction.faqEntry.findUnique({
        where: { groupId_keyword: { groupId: groupKey, keyword } },
      });
      if (existing) {
        return { status: "exists" as const, entry: existing };
      }

      const entryCount = await transaction.faqEntry.count({ where: { groupId: groupKey } });
      if (entryCount >= maximumEntries) {
        return { status: "full" as const, entryCount };
      }

      const entry = await transaction.faqEntry.create({
        data: { groupId: groupKey, keyword, answer, creatorId: String(creatorId) },
      });
      return { status: "created" as const, entry };
    });
  };

  const updateFaqEntry = async (groupId: string | number, keyword: string, answer: string) => {
    return prisma.faqEntry.updateMany({
      where: { groupId: String(groupId), keyword },
      data: { answer },
    });
  };

  const deleteFaqEntry = async (groupId: string | number, keyword: string) => {
    return prisma.faqEntry.deleteMany({ where: { groupId: String(groupId), keyword } });
  };

  const ensureTodoStorage = async () => prisma.groupTodo.findFirst({ select: { id: true } });

  const createTodo = async ({
    groupId,
    creatorId,
    assigneeId,
    content,
    dueAt,
    remindAt,
  }: {
    groupId: string | number; creatorId: string | number; assigneeId?: string | number; content: string;
    dueAt?: Date; remindAt?: Date;
  }) => {
    return prisma.$transaction(async (transaction) => {
      const groupKey = String(groupId);
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`todo:${groupKey}`}))`;
      const previous = await transaction.groupTodo.findFirst({
        where: { groupId: groupKey },
        orderBy: { displayId: "desc" },
        select: { displayId: true },
      });
      return transaction.groupTodo.create({
        data: {
          groupId: groupKey,
          displayId: (previous?.displayId ?? 0) + 1,
          creatorId: String(creatorId),
          assigneeId: assigneeId === undefined ? null : String(assigneeId),
          content,
          dueAt: dueAt ?? null,
          remindAt: remindAt ?? null,
        },
      });
    });
  };

  const listPendingTodos = async (groupId: string | number) => {
    const todos = await prisma.groupTodo.findMany({
      where: { groupId: String(groupId), completedAt: null },
    });
    return todos.sort((left, right) => {
      if (left.dueAt && right.dueAt) return left.dueAt.getTime() - right.dueAt.getTime();
      if (left.dueAt) return -1;
      if (right.dueAt) return 1;
      return left.createdAt.getTime() - right.createdAt.getTime();
    });
  };

  const findPendingTodo = async (displayId: number, groupId: string | number) => {
    return prisma.groupTodo.findFirst({
      where: { displayId, groupId: String(groupId), completedAt: null },
    });
  };

  const completeTodo = async (displayId: number, groupId: string | number, completedBy: string | number) => {
    return prisma.groupTodo.updateMany({
      where: { displayId, groupId: String(groupId), completedAt: null },
      data: { completedAt: new Date(), completedBy: String(completedBy) },
    });
  };

  const cancelTodo = async (displayId: number, groupId: string | number) => {
    return prisma.groupTodo.deleteMany({
      where: { displayId, groupId: String(groupId), completedAt: null },
    });
  };

  const claimDueTodos = async (now: Date, maximumCount: number) => {
    const candidates = await prisma.groupTodo.findMany({
      where: { completedAt: null, remindedAt: null, remindAt: { lte: now } },
      orderBy: { remindAt: "asc" },
      take: maximumCount,
    });
    const claimed: GroupTodoClaim[] = [];
    for (const todo of candidates) {
      const result = await prisma.groupTodo.updateMany({
        where: { id: todo.id, completedAt: null, remindedAt: null },
        data: { remindedAt: now },
      });
      if (result.count === 1) {
        claimed.push({ ...todo, claimedAt: now });
      }
    }
    return claimed;
  };

  const releaseTodoClaim = async (todo: GroupTodoClaim) => {
    return prisma.groupTodo.updateMany({
      where: { id: todo.id, completedAt: null, remindedAt: todo.claimedAt },
      data: { remindedAt: null },
    });
  };

  const cleanupFinishedTodos = async (now = new Date()) => {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    return prisma.groupTodo.deleteMany({ where: { completedAt: { lte: cutoff } } });
  };

  const close = () => prisma.$disconnect();

  return {
    initialize, findStreamerByName, listStreamers, deleteStreamersNotInNames, deleteStreamerByName,
    upsertStreamer, getLiveSession, startLiveSession, recordLiveDelivery, markLiveSessionEnded, recordLiveEndDelivery,
    getDynamicDeliveryState, startDynamicDelivery, recordDynamicDelivery,
    getDeliveredNewsIds, recordNewsDeliveries, ensureReminderStorage, createReminder, claimDueReminders,
    releaseReminderClaim, listPendingReminders, findPendingReminder, cancelPendingReminder, editPendingReminder,
    ensureScheduleStorage, createScheduleEvent, listUpcomingScheduleEvents, cancelUpcomingScheduleEvent,
    claimDueScheduleEvents, releaseScheduleEventClaim, cleanupFinishedScheduleEvents, close,
    ensureActivityStorage, createActivity, listUpcomingActivities, joinActivity, leaveActivity,
    cancelUpcomingActivity, claimDueActivities, releaseActivityClaim, cleanupFinishedActivities,
    ensureFaqStorage, listFaqEntries, findFaqEntry, createFaqEntry, updateFaqEntry, deleteFaqEntry,
    ensureTodoStorage, createTodo, listPendingTodos, findPendingTodo, completeTodo, cancelTodo,
    claimDueTodos, releaseTodoClaim, cleanupFinishedTodos,
  };
};

const getNextReminderTime = (current: Date, intervalMinutes: number, now: Date) => {
  const intervalMs = intervalMinutes * 60_000;
  const elapsedIntervals = Math.floor((now.getTime() - current.getTime()) / intervalMs) + 1;
  return new Date(current.getTime() + Math.max(1, elapsedIntervals) * intervalMs);
};

const formatSyncFailure = (error: unknown) =>
  error instanceof Error ? error.message.replace(/\s+/g, " ").trim().slice(0, 200) : "没有返回具体原因";

export const formatLiveMessage = (live: VtbLiveInfo, fans: number | undefined, liveWebUrl: string) => [
  `🔴 ${live.name} 的直播间开门啦！`,
  "",
  "今天播的是——",
  `「${live.title}」`,
  "",
  ...(live.liveStartedAt ? [`⏰ ${dayjs(live.liveStartedAt).format("MM月DD日 HH:mm")} 开播`] : []),
  ...(fans === undefined ? [] : [`✨ ${fans.toLocaleString("zh-CN")} 位粉丝`]),
  ...(live.roomId ? [`🔗 ${formatLiveRoomUrl(live.roomId, liveWebUrl)}`] : []),
  "",
  "来得正好，一起去看看吧！",
].join("\n");

export const formatLiveQueryMessage = (live: VtbLiveInfo, fans: number | undefined, liveWebUrl: string) => [
  `📺 ${live.name} 的直播小窗`,
  live.isLive ? "🔴 现在正在直播" : "🌙 现在还没开播",
  "",
  `「${live.title}」`,
  ...(live.liveStartedAt ? ["", `⏰ ${dayjs(live.liveStartedAt).format("MM月DD日 HH:mm")} 开播`] : []),
  ...(fans === undefined ? [] : [`✨ ${fans.toLocaleString("zh-CN")} 位粉丝`]),
  ...(live.roomId ? [`🔗 ${formatLiveRoomUrl(live.roomId, liveWebUrl)}`] : []),
  "",
  live.isLive ? "直播间正热闹，来得及的话就去看看吧！" : "今天还在蓄力，等下次开播再见。",
].join("\n");

export const formatOfflineMessage = (
  name: string,
  startedAt: Date,
  endedAt: Date,
  startFans?: number,
  endFans?: number,
  roomId?: string,
  liveWebUrl = "",
) => {
  const fanChange = startFans === undefined || endFans === undefined ? undefined : endFans - startFans;
  const durationMinutes = Math.max(1, Math.floor((endedAt.getTime() - startedAt.getTime()) / 60_000));
  return [
    `🌙 ${name} 今天收工啦`,
    "",
    `这次和大家一起度过了 ${formatLiveDuration(durationMinutes)}`,
    `⏰ ${dayjs(endedAt).format("MM月DD日 HH:mm")} 结束`,
    ...(fanChange && fanChange > 0 ? [`✨ 本场新关注 +${fanChange.toLocaleString("zh-CN")}`] : []),
    ...(roomId ? [`🔗 ${formatLiveRoomUrl(roomId, liveWebUrl)}`] : []),
    "",
    "辛苦啦，也谢谢大家一路陪到下播。充好电，我们下次见！",
  ].join("\n");
};

export const formatDynamicMessage = (dynamic: VtbDynamic, webUrl: string) => {
  const dynamicUrl = formatDynamicUrl(dynamic.link, webUrl);
  const hasDynamicUrlInDescription =
    dynamic.containsDynamicUrl ||
    dynamic.description.includes(dynamic.link) ||
    dynamic.description.includes(dynamicUrl);

  return [
    `📮 ${dynamic.author} 发来一条新动态`,
    "",
    `「${dynamic.title}」`,
    ...(dynamic.description ? ["", ...dynamic.description.split("\n")] : ["", "只留下了标题，点进原文看看吧。"]),
    "",
    `⏰ ${dayjs(dynamic.publishedAt).format("MM月DD日 HH:mm")} 发布`,
    ...(hasDynamicUrlInDescription ? [] : [`🔗 完整动态 · ${dynamicUrl}`]),
  ].join("\n");
};

export const createVtbNotificationMessage = (text: string, imageFile?: string) => [
  { type: "text", data: { text } },
  ...(imageFile ? [{ type: "image", data: { file: imageFile } }] : []),
];

export const prependVtbAtAllMention = (message: unknown) => Array.isArray(message)
  ? [
      { type: "at", data: { qq: "all" } },
      { type: "text", data: { text: "\n\n" } },
      ...message,
    ]
  : message;

const formatLiveDuration = (durationMinutes: number) => {
  if (durationMinutes < 60) {
    return `${durationMinutes.toLocaleString("zh-CN")} 分钟`;
  }

  const hours = Math.floor(durationMinutes / 60);
  const minutes = durationMinutes % 60;
  return minutes === 0
    ? `${hours.toLocaleString("zh-CN")} 小时`
    : `${hours.toLocaleString("zh-CN")} 小时 ${minutes.toLocaleString("zh-CN")} 分钟`;
};

export const formatLiveRoomUrl = (roomId: string, liveWebUrl: string) =>
  `${liveWebUrl.replace(/\/+$/, "")}/${roomId}`;

export const formatDynamicUrl = (link: string, webUrl: string) => {
  const dynamicId = /(?:opus|dynamic)\/(\d+)/.exec(link)?.[1] ?? /\/(\d+)(?:\?.*)?$/.exec(link)?.[1];
  return dynamicId ? `${webUrl.replace(/\/+$/, "")}/opus/${dynamicId}` : link;
};

const createConfiguredVtbRepository = async (config: MizConfig) => {
  const prisma = new PrismaClient({ adapter: new PrismaPg(getDatabaseUrl(config)) });
  try {
    const repository = createVtbRepository(prisma);
    await repository.initialize();
    return repository;
  } catch (error) {
    await prisma.$disconnect().catch(() => undefined);
    throw error;
  }
};

export const getDatabaseUrl = (config: MizConfig) => {
  const host = new URL(config.postgresql.url);
  return [
    "postgresql://",
    encodeURIComponent(config.postgresql.username),
    ":",
    encodeURIComponent(config.postgresql.password),
    "@",
    host.host,
    "/",
    encodeURIComponent(config.postgresql.database),
    host.search,
  ].join("");
};

const fromStoredStreamer = (streamer: { name: string; mid: bigint; liveRoom: bigint | null }): VtbStreamer => ({
  name: streamer.name,
  mid: streamer.mid.toString(),
  roomId: normalizeRoomId(streamer.liveRoom),
});

const toMid = (mid: string) => BigInt(mid);
const toOptionalMid = (value: string | undefined) => {
  const roomId = normalizeRoomId(value);
  return roomId === undefined ? null : BigInt(roomId);
};

const fetchJson = async (
  url: string,
  webUrl: string,
  headers?: Record<string, string>,
  init?: RequestInit,
) => {
  const requestInit: RequestInit = {
    ...init,
    headers: createVtbRequestHeaders(webUrl, headers, init?.headers),
  };
  return runProtectedVtbRequest(
    url,
    requestInit,
    VTB_JSON_REQUEST_INTERVAL_MS,
    async () => {
      const response = await fetchWithRetry(url, {
        ...requestInit,
        timeoutMs: FETCH_TIMEOUT_MS,
        retryCount: 1,
        retryDelayMs: 2_000,
        retryJitterMs: 3_000,
        retryRateLimited: false,
      });
      return readResponseJson(response, MAX_VTB_RESPONSE_BYTES);
    },
  );
};

const fetchText = async (url: string) => {
  const text = await runProtectedVtbRequest(
    url,
    undefined,
    VTB_DYNAMIC_REQUEST_INTERVAL_MS,
    async () => {
      const response = await fetchWithRetry(url, {
        timeoutMs: FETCH_TIMEOUT_MS,
        retryCount: 0,
        retryRateLimited: false,
      });
      return readResponseText(response, MAX_VTB_RESPONSE_BYTES);
    },
  );
  recordVtbRequestSuccess(url);
  return text;
};

const fetchDynamicText = async (url: string, _retryCount: number) => fetchText(url);

const runProtectedVtbRequest = async <T>(
  url: string,
  init: RequestInit | undefined,
  minimumIntervalMs: number,
  request: () => Promise<T>,
): Promise<T> => {
  const requestKey = [
    init?.method?.toUpperCase() ?? "GET",
    url,
    getRequestHeadersKey(init?.headers),
    typeof init?.body === "string" ? init.body : "",
  ].join("\n");
  const existingRequest = vtbInFlightRequests.get(requestKey);
  if (existingRequest) {
    return existingRequest as Promise<T>;
  }

  const pendingRequest = (async () => {
    const host = getVtbRequestHost(url);
    assertVtbRequestAvailable(host);
    await reserveVtbRequestSlot(host, minimumIntervalMs);
    assertVtbRequestAvailable(host);
    try {
      return await request();
    } catch (error) {
      recordVtbTransportFailure(host, error);
      throw error;
    }
  })();
  vtbInFlightRequests.set(requestKey, pendingRequest);
  try {
    return await pendingRequest;
  } finally {
    if (vtbInFlightRequests.get(requestKey) === pendingRequest) {
      vtbInFlightRequests.delete(requestKey);
    }
  }
};

const reserveVtbRequestSlot = async (host: string, minimumIntervalMs: number) => {
  const state = getVtbRequestState(host);
  const queued = state.queue.catch(() => undefined).then(async () => {
    assertVtbRequestAvailable(host);
    const jitterMs = minimumIntervalMs > 0 ? Math.random() * minimumIntervalMs : 0;
    const waitMs = state.lastRequestAt + minimumIntervalMs + jitterMs - Date.now();
    if (waitMs > 0) {
      await waitForVtbRequest(waitMs);
    }
    assertVtbRequestAvailable(host);
    state.lastRequestAt = Date.now();
  });
  state.queue = queued.catch(() => undefined);
  await queued;
};

const assertVtbApiSuccess = (url: string, apiName: string, code: number) => {
  if (code === 0) {
    recordVtbRequestSuccess(url);
    return;
  }

  recordVtbBusinessFailure(url, code);
  throw new Error(`Bilibili ${apiName} API failed: code ${code}`);
};

const recordVtbRequestSuccess = (url: string) => {
  const state = getVtbRequestState(getVtbRequestHost(url));
  state.consecutiveFailures = 0;
};

const recordVtbBusinessFailure = (url: string, code: number) => {
  const host = getVtbRequestHost(url);
  const state = getVtbRequestState(host);
  state.consecutiveFailures += 1;
  if (VTB_RISK_CODES.has(code)) {
    state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + VTB_RISK_COOLDOWN_MS);
  } else if (state.consecutiveFailures >= VTB_TRANSIENT_FAILURE_THRESHOLD) {
    state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + VTB_TRANSIENT_COOLDOWN_MS);
  }
};

const recordVtbTransportFailure = (host: string, error: unknown) => {
  if (isVtbCooldownError(error)) {
    return;
  }

  const state = getVtbRequestState(host);
  const status = getHttpErrorStatus(error);
  if (status === 412 || status === 429) {
    const retryAfterMs = getHttpRetryAfterMs(error);
    state.consecutiveFailures += 1;
    state.cooldownUntil = Math.max(
      state.cooldownUntil,
      Date.now() + Math.max(VTB_RISK_COOLDOWN_MS, retryAfterMs ?? 0),
    );
    return;
  }

  if (status === undefined || status === 408 || status >= 500) {
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= VTB_TRANSIENT_FAILURE_THRESHOLD) {
      state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + VTB_TRANSIENT_COOLDOWN_MS);
    }
  }
};

const assertVtbRequestAvailable = (host: string) => {
  const cooldownUntil = getVtbRequestState(host).cooldownUntil;
  if (cooldownUntil <= Date.now()) {
    return;
  }

  throw Object.assign(
    new Error(`VTB upstream ${host} is cooling down until ${new Date(cooldownUntil).toISOString()}`),
    { name: "VtbCooldownError", cooldownUntil },
  );
};

const getVtbRequestState = (host: string) => {
  const existing = vtbRequestStates.get(host);
  if (existing) {
    return existing;
  }

  const state = {
    consecutiveFailures: 0,
    cooldownUntil: 0,
    lastRequestAt: 0,
    queue: Promise.resolve(),
  };
  vtbRequestStates.set(host, state);
  return state;
};

const getVtbRequestHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const getHttpErrorStatus = (error: unknown) => {
  const status = error instanceof Error
    ? (error as Error & { status?: unknown }).status
    : undefined;
  return typeof status === "number" ? status : undefined;
};

const getHttpRetryAfterMs = (error: unknown) => {
  const retryAfterMs = error instanceof Error
    ? (error as Error & { retryAfterMs?: unknown }).retryAfterMs
    : undefined;
  return typeof retryAfterMs === "number" ? retryAfterMs : undefined;
};

const isVtbCooldownError = (error: unknown) =>
  error instanceof Error && error.name === "VtbCooldownError";

const waitForVtbRequest = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const createVtbRequestHeaders = (webUrl: string, ...sources: Array<HeadersInit | undefined>) => {
  const headers = new Headers({
    "user-agent": "Mozilla/5.0",
    referer: `${webUrl.replace(/\/+$/, "")}/`,
  });
  for (const source of sources) {
    if (!source) {
      continue;
    }
    new Headers(source).forEach((value, key) => headers.set(key, value));
  }
  return headers;
};

const getRequestHeadersKey = (headers: HeadersInit | undefined) => {
  if (!headers) {
    return "";
  }

  const serializedHeaders = Array.from(new Headers(headers).entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("\n");
  return createHash("sha256").update(serializedHeaders).digest("base64url");
};

const getVtbLiveCacheKey = (config: VtbConfig, mid: string) =>
  `${config.liveApiUrl}\n${getVtbCredentialKey(config.bilibiliCookie)}\n${mid}`;

const getVtbCardCacheKey = (config: VtbConfig, mid: string) =>
  `${config.cardApiUrl}\n${getVtbCredentialKey(config.bilibiliCookie)}\n${mid}`;

const getVtbCredentialKey = (cookie: string) =>
  cookie ? createHash("sha256").update(cookie).digest("base64url") : "";

const getVtbDynamicQueryCacheMs = (config: VtbConfig) =>
  Math.max(60_000, Math.min(10 * 60_000, (config.dynamicPollMinutes ?? 15) * 30_000));

const createCardApiUrl = (apiUrl: string, mids: readonly string[]) => {
  const url = new URL(apiUrl);
  if (!url.searchParams.has("uids")) {
    throw new Error("Bilibili card API URL must include the uids query parameter");
  }
  url.searchParams.set("uids", mids.join(","));
  return url.href;
};

const chunk = <T>(items: readonly T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const extractCardRecords = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value.flatMap(extractCardRecords);
  }

  if (!isRecord(value)) {
    return [];
  }

  if ("mid" in value) {
    return [value];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    if (isRecord(child) && !("mid" in child) && /^\d+$/.test(key)) {
      return [{ ...child, mid: key }];
    }
    return extractCardRecords(child);
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeRoomId = (value: string | number | bigint | null | undefined) => {
  if (value === undefined || value === null) return undefined;
  const roomId = String(value);
  return roomId === "0" ? undefined : roomId;
};

const findLiveInfo = (value: unknown, mid: string) => {
  if (isRecord(value)) {
    const parsed = liveInfoSchema.safeParse(value[mid]);
    return parsed.success ? parsed.data : undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) {
        continue;
      }
      const itemMid = item.uid ?? item.mid;
      if (String(itemMid) !== mid) {
        continue;
      }
      const parsed = liveInfoSchema.safeParse(item);
      return parsed.success ? parsed.data : undefined;
    }
  }

  return undefined;
};

const toVtbLiveInfo = (streamer: VtbStreamer, live: z.infer<typeof liveInfoSchema> | undefined): VtbLiveInfo => ({
  title: live?.title?.trim() || "还没有直播标题",
  roomId: live?.room_id === undefined ? normalizeRoomId(streamer.roomId) : normalizeRoomId(live.room_id),
  liveStartedAt: parseDate(live?.live_time),
  isLive: live?.live_status === 1,
  name: live?.uname?.trim() || streamer.name,
  coverUrl: pickImageUrl(live?.cover_from_user, live?.keyframe, live?.user_cover, live?.cover),
});

const pickImageUrl = (...values: Array<string | null | undefined>) => {
  for (const value of values) {
    const url = cleanImageUrl(value);
    if (url) {
      return url;
    }
  }
  return undefined;
};

const cleanImageUrl = (value: string | null | undefined) => {
  const url = value?.trim();
  if (!url) {
    return undefined;
  }
  return url.startsWith("//") ? `https:${url}` : url;
};

const parseDate = (value: string | number | undefined) => {
  if (!value || value === "0000-00-00 00:00:00") return undefined;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const parseRssDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const cleanDynamicText = (value: string) =>
  value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();

const truncateDynamicText = (value: string) =>
  value.length > MAX_DYNAMIC_DESCRIPTION_LENGTH
    ? `${value.slice(0, MAX_DYNAMIC_DESCRIPTION_LENGTH - 1)}…`
    : value;
