import dayjs from "dayjs";
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
import { getBilibiliCredentialHeader } from "@/bilibili-credential";
import type { MizConfig, VtbConfig } from "@/config";
import { createDatabaseClient, getDatabaseUrl } from "@/database";
import { fetchWithRiskControlProxy, fetchWithRetry, readResponseBytes, readResponseJson } from "@/http";
import { partitionVtbSubscriptionsByGroup } from "@/vtb-subscriptions";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_DYNAMIC_DESCRIPTION_LENGTH = 1_800;
// Explicit Bilibili risk-control responses pause requests long enough to skip
// one normal polling cycle. Retry-After is honored up to a bounded probe delay.
const VTB_RISK_COOLDOWN_MS = 5 * 60_000;
const VTB_MAX_RISK_COOLDOWN_MS = 30 * 60_000;
// Ordinary network and 5xx failures are not risk control. A short circuit
// breaker avoids a retry storm without taking live polling offline for 15 min.
const VTB_TRANSIENT_COOLDOWN_MS = 60_000;
const VTB_TRANSIENT_FAILURE_THRESHOLD = 3;
const VTB_JSON_REQUEST_INTERVAL_MS = 250;
// User-name search is the most sensitive endpoint and is only needed when a
// streamer is not already present in the local VTB repository.
const VTB_USER_SEARCH_REQUEST_INTERVAL_MS = 5_000;
const VTB_USER_SEARCH_CACHE_MS = 6 * 60 * 60_000;
const VTB_USER_SEARCH_MISS_CACHE_MS = 10 * 60_000;
// Dynamic feeds are the most numerous VTB requests. Keep a deliberately
// conservative per-host interval and add jitter in the shared request queue.
const VTB_DYNAMIC_REQUEST_INTERVAL_MS = 2_000;
const VTB_GUARD_REQUEST_INTERVAL_MS = 1_000;
const VTB_STATS_REQUEST_INTERVAL_MS = 1_000;
const VTB_FAN_CLUB_REQUEST_INTERVAL_MS = 1_000;
const VTB_STATS_CACHE_MS = 60_000;
const VTB_LIVE_QUERY_CACHE_MS = 60_000;
const VTB_IMAGE_CACHE_MS = 10 * 60_000;
const MAX_VTB_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VTB_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_VTB_IMAGE_CACHE_ENTRIES = 16;
const MAX_VTB_QUERY_CACHE_ENTRIES = 1_000;
// Unlike ambiguous validation/rejection codes such as -352 and -799, -509
// specifically means that requests are too frequent. HTTP 412/429 are handled
// separately as transport-level protection signals.
const VTB_RATE_LIMIT_CODES = new Set([-509]);
const BILIBILI_DYNAMIC_FEATURES = [
  "itemOpusStyle",
  "listOnlyfans",
  "opusBigCover",
  "onlyfansVote",
  "forwardListHidden",
  "decorationCard",
  "commentsNewVersion",
  "onlyfansAssetsV2",
  "ugcDelete",
  "onlyfansQaCard",
].join(",");

// Bilibili normally serializes these values as JSON numbers, but a few
// gateway variants and compatibility endpoints return numeric strings. Keep
// the transport parser strict for everything else while accepting that
// harmless representation difference.
const numericSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
    ? Number(value)
    : value,
  z.number(),
);
const integerSchema = numericSchema.pipe(z.number().int());

const legacyUserSchema = z.looseObject({
  uname: z.string().min(1),
  mid: z.union([z.string(), z.number()]),
  room_id: z.union([z.string(), z.number()]).optional(),
});
const userResponseSchema = z.looseObject({
  code: integerSchema,
  data: z.unknown().optional(),
});
const cardResponseSchema = z.looseObject({
  code: integerSchema,
  data: z.unknown().optional(),
});
const liveMasterInfoResponseSchema = z.looseObject({
  code: integerSchema,
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
  live_status: integerSchema.optional(),
  uname: z.string().optional(),
  cover_from_user: z.string().nullish(),
  keyframe: z.string().nullish(),
  user_cover: z.string().nullish(),
  cover: z.string().nullish(),
});
const liveResponseSchema = z.looseObject({
  code: integerSchema,
  data: z.unknown().optional(),
});
const dynamicResponseSchema = z.looseObject({
  code: integerSchema,
  data: z.looseObject({
    items: z.array(z.unknown()).optional().default([]),
  }).nullish(),
});

export type VtbStreamer = {
  name: string;
  mid: string;
  roomId?: string;
};
export type VtbLiveInfo = {
  title: string;
  roomId?: string;
  liveStartedAt?: Date;
  isLive: boolean;
  name: string;
  coverUrl?: string;
  fans?: number;
  fanClub?: number;
  guards?: number;
};
export type VtbLiveStats = {
  fans?: number;
  fanClub?: number;
  guards?: number;
};
export type VtbGuardSnapshot = { ids: string[]; names: string[]; captured: boolean };
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
  startFanClub?: number;
  startGuards?: number;
  startGuardSnapshot?: VtbGuardSnapshot;
  roomId?: string;
  deliveredGroupIds: string[];
  endedAt?: Date;
  endFans?: number;
  endFanClub?: number;
  endGuards?: number;
  endGuardSnapshot?: VtbGuardSnapshot;
  endDeliveredGroupIds: string[];
};
export type VtbDynamicDeliveryState = {
  publishedAt: Date;
  deliveredGroupIds: string[];
};
export type VtbCardInfo = VtbLiveStats & { name?: string; avatarUrl?: string; roomId?: string };
export type VtbNameChange = { previousName: string; name: string; mid: string };
type ReminderClaim = Reminder & { claimedAt: Date; nextRemindAt?: Date };
type ScheduleEventClaim = ScheduleEvent & { claimedAt: Date };
type ActivityClaim = Activity & { claimedAt: Date; registrations: ActivityRegistration[] };
type GroupTodoClaim = GroupTodo & { claimedAt: Date };

let repositoryPromise: Promise<VtbRepository> | undefined;
const vtbRequestStates = new Map<string, {
  consecutiveFailures: number;
  cooldownUntil: number;
  cooldownReason?: "risk" | "transient";
  lastRequestAt: number;
  lastMinimumIntervalMs: number;
  queue: Promise<void>;
}>();
const vtbInFlightRequests = new Map<string, Promise<unknown>>();
let vtbLiveQueryCache = createExpiringCache<string, VtbLiveInfo>(MAX_VTB_QUERY_CACHE_ENTRIES);
let vtbCardQueryCache = createExpiringCache<string, VtbCardInfo>(MAX_VTB_QUERY_CACHE_ENTRIES);
let vtbDynamicQueryCache = createExpiringCache<string, VtbDynamicFeed>(MAX_VTB_QUERY_CACHE_ENTRIES);
let vtbUserSearchCache = createExpiringCache<string, VtbStreamer | null>(MAX_VTB_QUERY_CACHE_ENTRIES);
let vtbImageCache = createExpiringCache<string, string>(MAX_VTB_IMAGE_CACHE_ENTRIES);
let vtbLiveStatsCache = createExpiringCache<string, VtbCardInfo>(MAX_VTB_QUERY_CACHE_ENTRIES);
const vtbLiveStatsInFlight = new Map<string, Promise<VtbCardInfo>>();
let vtbWbiKeys: { mixinKey: string; expiresAt: number } | undefined;
let vtbWbiKeysPromise: Promise<string> | undefined;

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
  const cacheKey = `${config.userApiUrl}\n${name}`;
  const cacheRead = readExpiringCache(vtbUserSearchCache, cacheKey, Date.now());
  vtbUserSearchCache = cacheRead.cache;
  if (cacheRead.value !== undefined) {
    return cacheRead.value ?? undefined;
  }

  const url = createUserSearchApiUrl(config.userApiUrl, name);
  // Bilibili's legacy search endpoint is technically callable anonymously,
  // but its web risk-control layer commonly returns HTTP 412 unless the
  // browser-like login cookies are present. Reuse the saved QR-login
  // credential for both search variants; when no credential is configured the
  // request remains anonymous.
  const credential = await getBilibiliCredentialHeader().catch(() => undefined);
  const signedUrl = isBilibiliWbiSearchUrl(url, config.wbiSearchApiUrl)
    ? await signBilibiliUrl(url, config)
    : url;
  let response = userResponseSchema.parse(
    await fetchJson(
      signedUrl,
      config.webUrl,
      credential ? { Cookie: credential } : undefined,
      undefined,
      config.proxyUrl,
      VTB_USER_SEARCH_REQUEST_INTERVAL_MS,
    ),
  );
  if (response.code === -101) {
    const cookie = await getBilibiliCredentialHeader().catch(() => undefined);
    if (cookie) {
      response = userResponseSchema.parse(
        await fetchJson(
          signedUrl,
          config.webUrl,
          { Cookie: cookie },
          undefined,
          config.proxyUrl,
          VTB_USER_SEARCH_REQUEST_INTERVAL_MS,
        ),
      );
    }
  }
  assertVtbApiSuccess(signedUrl, "user", response.code);

  const streamer = extractVtbSearchUsers(response.data).find((item) => item.name === name);
  vtbUserSearchCache = writeExpiringCache(
    vtbUserSearchCache,
    cacheKey,
    streamer ?? null,
    streamer ? VTB_USER_SEARCH_CACHE_MS : VTB_USER_SEARCH_MISS_CACHE_MS,
    Date.now(),
  );
  return streamer;
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

/** Resolves an interactive query without turning it into a tracked streamer. */
export const resolveVtbStreamerForQuery = async (
  name: string,
  config: VtbConfig,
  repository: Pick<VtbRepository, "findStreamerByName">,
) => (await repository.findStreamerByName(name)) ?? resolveVtbStreamer(name, config);

export const syncConfiguredVtbStreamers = async (config: MizConfig) => {
  const names = Array.from(
    new Set(config.vtb.subscriptions.flatMap((subscription) => [
      ...subscription.streamers,
      ...(subscription.dynamicStreamers ?? []),
    ])),
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
  const renamed: VtbNameChange[] = [];
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
    if (card.name !== streamer.name || live.roomId !== streamer.roomId) {
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

/** Fetch the documented live master profile, preferring the saved login cookie. */
export const getVtbLiveStats = async (mid: string, config: VtbConfig): Promise<VtbCardInfo> => {
  const cacheKey = getVtbLiveStatsCacheKey(mid, config);
  const cacheRead = readExpiringCache(vtbLiveStatsCache, cacheKey, Date.now());
  vtbLiveStatsCache = cacheRead.cache;
  if (cacheRead.value) {
    return cacheRead.value;
  }

  const existingRequest = vtbLiveStatsInFlight.get(cacheKey);
  if (existingRequest) {
    return existingRequest;
  }

  const request = fetchVtbLiveStats(mid, config, cacheKey, cacheRead.value ?? undefined);
  vtbLiveStatsInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (vtbLiveStatsInFlight.get(cacheKey) === request) {
      vtbLiveStatsInFlight.delete(cacheKey);
    }
  }
};

const fetchVtbLiveStats = async (
  mid: string,
  config: VtbConfig,
  cacheKey: string,
  previous: VtbCardInfo | undefined,
): Promise<VtbCardInfo> => {
  const url = new URL(config.liveMasterApiUrl || endpointFromBase(config.liveWebUrl, "/live_user/v1/Master/info"));
  url.searchParams.set("uid", mid);
  const credential = await getBilibiliCredentialHeader().catch(() => undefined);
  const result = await fetchJson(
    url.href,
    config.liveWebUrl,
    credential ? { Cookie: credential } : undefined,
    undefined,
    config.proxyUrl,
    VTB_STATS_REQUEST_INTERVAL_MS,
  );
  const response = liveMasterInfoResponseSchema.parse(result);
  assertVtbApiSuccess(url.href, "live master", response.code);
  const data = isRecord(response.data) ? response.data : undefined;
  const info = isRecord(data?.info) ? data.info : undefined;
  const fans = findCount(data, ["follower_num", "follow_num", "fans"]);
  let fanClub = findCount(data, [
    "fan_club", "fanClub", "fan_club_count", "fanClubCount", "fan_club_num", "fanClubNum",
    "fans_club", "fansClub", "fans_club_num", "fansClubNum", "fans_group_count", "fansGroupCount",
  ]) ?? findCount(info, [
    "fan_club", "fanClub", "fan_club_count", "fanClubCount", "fan_club_num", "fanClubNum",
    "fans_club", "fansClub", "fans_club_num", "fansClubNum", "fans_group_count", "fansGroupCount",
  ]);
  // Master/info does not normally expose the anchor-wide fan-club total.
  // The documented ranking endpoint does, so use it as the authoritative
  // source while keeping the profile request useful when that endpoint is
  // temporarily unavailable.
  if (fanClub === undefined) {
    try {
      const documentedFanClub = await getVtbFanClubCount(mid, config);
      if (documentedFanClub !== undefined) {
        fanClub = documentedFanClub;
      }
    } catch {
      // A partial stats response must not suppress live polling.
    }
  }
  const guards = findCount(data, ["guards", "guard", "guard_num", "guardNum", "guard_count", "guardCount"]);
  const name = firstText(info?.uname, data?.uname, data?.name);
  const avatarUrl = pickImageUrl(firstText(info?.face, data?.face));
  const roomId = normalizeRoomId(firstText(data?.room_id));
  const stats: VtbCardInfo = {
    // Some documented responses are deliberately partial. Preserve the last
    // known fan-club/guard baseline instead of turning a missing field into a
    // false decrease in the live-end notification.
    ...previous,
    ...(fans === undefined ? {} : { fans }),
    ...(fanClub === undefined ? {} : { fanClub }),
    ...(guards === undefined ? {} : { guards }),
    ...(name === undefined ? {} : { name }),
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
    ...(roomId === undefined ? {} : { roomId }),
  };
  vtbLiveStatsCache = writeExpiringCache(vtbLiveStatsCache, cacheKey, stats, VTB_STATS_CACHE_MS, Date.now());
  return stats;
};

/** Fetch the documented aggregate number of members in an anchor's fan club. */
export const getVtbFanClubCount = async (mid: string, config: VtbConfig) => {
  const url = new URL(config.fanClubApiUrl || endpointFromBase(config.liveWebUrl, "/xlive/general-interface/v1/rank/getFansMembersRank"));
  url.searchParams.set("ruid", mid);
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", "30");
  const response = z.looseObject({ code: integerSchema, data: z.unknown().optional() }).parse(
    await fetchJson(
      url.href,
      config.webUrl,
      undefined,
      undefined,
      config.proxyUrl,
      VTB_FAN_CLUB_REQUEST_INTERVAL_MS,
    ),
  );
  assertVtbApiSuccess(url.href, "fan club", response.code);
  const data = isRecord(response.data) ? response.data : undefined;
  const directCount = toFiniteCount(data?.num) ?? toFiniteCount(data?.total);
  return directCount ?? findCount(data?.info, ["num", "total", "count"]);
};

/** Count current captain members from the documented anonymous guard ranking. */
export const getVtbCaptainCount = async (roomId: string, mid: string, config: VtbConfig) => {
  const seen = new Set<string>();
  let captains = 0;
  for (let page = 1; page <= 100; page += 1) {
    const query = new URLSearchParams({
      roomid: roomId,
      ruid: mid,
      page: String(page),
      page_size: "30",
      typ: "3",
    });
    const url = `${config.guardApiUrl || endpointFromBase(config.liveWebUrl, "/xlive/app-room/v2/guardTab/topListNew")}?${query.toString()}`;
    const response = z.looseObject({ code: integerSchema, data: z.unknown().optional() }).parse(
      await fetchJson(url, config.webUrl, undefined, undefined, config.proxyUrl, VTB_GUARD_REQUEST_INTERVAL_MS),
    );
    assertVtbApiSuccess(url, "guard", response.code);
    if (!isRecord(response.data)) throw new Error("Bilibili guard API returned no data");
    const data = response.data;
    const total = findCount(data.info, ["num", "total", "count"]);
    const entries = [
      ...(page === 1 && Array.isArray(data.top3) ? data.top3 : []),
      ...(Array.isArray(data.list) ? data.list : []),
    ];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const id = firstText(entry.uid, entry.mid, isRecord(entry.uinfo) ? entry.uinfo.uid : undefined);
      if (id && !seen.has(id)) {
        seen.add(id);
        if (findCount(entry, ["guard_level", "guardLevel"]) === 3) captains += 1;
      }
    }
    if (entries.length === 0 || (total !== undefined && seen.size >= total) || entries.length < 30) break;
  }
  return captains;
};

export const getVtbCardInfos = async (mids: readonly string[], config: VtbConfig) => {
  const uniqueMids = Array.from(new Set(mids));
  const cards = new Map<string, VtbCardInfo>();
  if (uniqueMids.length === 0) return cards;
  const credential = await getBilibiliCredentialHeader().catch(() => undefined);
  const batchSize = hasCardQueryParameter(config.cardApiUrl, "mid") ? 1 : 50;
  for (const batch of chunk(uniqueMids, batchSize)) {
    if (config.cardApiUrl) {
      const url = createCardApiUrl(config.cardApiUrl, batch);
      try {
        const requestUrl = isBilibiliWbiCardUrl(url, config.cardApiUrl) ? await signBilibiliUrl(url, config) : url;
        const response = cardResponseSchema.parse(
          await fetchJson(
            requestUrl,
            config.webUrl,
            credential ? { Cookie: credential } : undefined,
            undefined,
            config.proxyUrl,
          ),
        );
        if (response.code !== 0) {
          recordVtbBusinessFailure(requestUrl, response.code);
          throw new Error(
            response.code === -101
              ? "Bilibili card API rejected the QR login credential: code -101"
              : `Bilibili card API failed: code ${response.code}`,
          );
        }
        recordVtbRequestSuccess(requestUrl);

        for (const rawCard of extractCardRecords(response.data)) {
          const parsedCard = cardSchema.safeParse(rawCard);
          if (!parsedCard.success) {
            continue;
          }

          const fans = Number(parsedCard.data.fans);
          const fanClub = findCount(rawCard, [
            "fan_club", "fanClub", "fan_club_count", "fanClubCount", "fan_club_num", "fanClubNum",
            "fans_club", "fansClub", "fans_club_num", "fansClubNum", "fans_num", "fansNum",
            "fans_group_count", "fansGroupCount",
          ]);
          const guards = findCount(rawCard, [
            "guards", "guard", "guard_num", "guardNum", "guard_count", "guardCount",
            "guard_info", "guardInfo",
          ]);
          cards.set(String(parsedCard.data.mid), {
            ...(Number.isFinite(fans) ? { fans } : {}),
            ...(fanClub === undefined ? {} : { fanClub }),
            ...(guards === undefined ? {} : { guards }),
            name: parsedCard.data.name?.trim() || undefined,
            avatarUrl: pickImageUrl(
              parsedCard.data.face,
              parsedCard.data.avatar,
              parsedCard.data.avatar_url,
            ),
          });
        }
      } catch {
        // The documented live endpoints below are independent of this
        // optional web-card request, so an expired SESSDATA must not suppress
        // follower and fan-club statistics.
      }
    }

    const documentedStats = await Promise.all(batch.map(async (mid) => {
      try {
        return [mid, await getVtbLiveStats(mid, config)] as const;
      } catch {
        return [mid, {}] as const;
      }
    }));
    for (const [mid, stats] of documentedStats) {
      // Keep the configured card endpoint authoritative when it returned a
      // field; anonymous live endpoints only fill gaps or provide fallback
      // values after an expired/missing web-card credential.
      const previous = cards.get(mid) ?? {};
      cards.set(mid, { ...stats, ...previous });
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

/**
 * Treat the profile returned for a MID as authoritative. Search and live APIs
 * may still expose an old or transient nickname, while the MID remains stable.
 */
export const findVtbNameChanges = (
  streamers: readonly VtbStreamer[],
  cardInfos: ReadonlyMap<string, VtbCardInfo>,
): VtbNameChange[] => streamers.flatMap((streamer) => {
  const latestName = cardInfos.get(streamer.mid)?.name?.trim();
  return latestName && latestName !== streamer.name
    ? [{ previousName: streamer.name, name: latestName, mid: streamer.mid }]
    : [];
});

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
  if (uniqueStreamers.length === 0) return results;
  if (isDocumentedLiveRoomInfoUrl(config.liveApiUrl)) {
    const credential = await getBilibiliCredentialHeader().catch(() => undefined);
    for (const streamer of uniqueStreamers) {
      let roomId = normalizeRoomId(streamer.roomId);
      if (!roomId) {
        try {
          roomId = (await getVtbLiveStats(streamer.mid, config)).roomId;
        } catch {
          roomId = undefined;
        }
      }
      if (!roomId) {
        results.set(streamer.mid, toVtbLiveInfo({ ...streamer, roomId: undefined }, undefined));
        continue;
      }
      const url = createLiveRoomInfoUrl(config.liveApiUrl, roomId);
      const response = z.looseObject({ code: integerSchema, data: z.unknown().optional() }).parse(
        await fetchJson(
          url,
          config.webUrl,
          credential ? { Cookie: credential } : undefined,
          undefined,
          config.proxyUrl,
        ),
      );
      assertVtbApiSuccess(url, "live", response.code);
      const live = liveInfoSchema.safeParse(response.data);
      const result = toVtbLiveInfo(streamer, live.success ? live.data : undefined);
      results.set(streamer.mid, result);
      vtbLiveQueryCache = writeExpiringCache(
        vtbLiveQueryCache,
        getVtbLiveCacheKey(config, streamer.mid),
        result,
        VTB_LIVE_QUERY_CACHE_MS,
        Date.now(),
      );
    }
    return results;
  }
  for (const batch of chunk(uniqueStreamers, 50)) {
    const url = config.liveApiUrl;
    const response = liveResponseSchema.parse(
      await fetchJson(url, config.webUrl, undefined, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uids: batch.map((streamer) => streamer.mid) }),
      }, config.proxyUrl),
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
  _retryCount = 0,
): Promise<VtbDynamicFeed> => {
  const cookie = await getBilibiliCredentialHeader();
  if (!cookie) {
    throw new Error("Bilibili dynamic API requires a logged-in credential");
  }

  const dynamicApiUrl = config.dynamicApiUrl || endpointFromBase(config.webUrl, "/x/polymer/web-dynamic/v1/feed/space");
  const cacheKey = `${dynamicApiUrl}\n${config.webUrl}\n${streamer.mid}`;
  const cacheRead = readExpiringCache(vtbDynamicQueryCache, cacheKey, Date.now());
  vtbDynamicQueryCache = cacheRead.cache;
  const cached = cacheRead.value;
  if (cached) {
    return cached;
  }

  const query = new URLSearchParams({
    offset: "",
    host_mid: streamer.mid,
    platform: "web",
    features: BILIBILI_DYNAMIC_FEATURES,
    web_location: "333.1387",
  });
  const dynamicUrl = `${dynamicApiUrl}?${query.toString()}`;
  const response = dynamicResponseSchema.parse(
    await fetchJson(
      dynamicUrl,
      config.webUrl,
      { Cookie: cookie },
      { headers: { Referer: `https://space.bilibili.com/${streamer.mid}/` } },
      config.proxyUrl,
      VTB_DYNAMIC_REQUEST_INTERVAL_MS,
    ),
  );
  assertVtbApiSuccess(dynamicUrl, "dynamic", response.code);
  const feed = parseBilibiliDynamicFeed(response.data?.items ?? [], streamer.name, config.webUrl);
  vtbDynamicQueryCache = writeExpiringCache(
    vtbDynamicQueryCache,
    cacheKey,
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

  const cacheKey = `${url}\n${config.webUrl}`;
  const cacheRead = readExpiringCache(vtbImageCache, cacheKey, Date.now());
  vtbImageCache = cacheRead.cache;
  const cached = cacheRead.value;
  if (cached) {
    return cached;
  }

  const requestHeaders = createVtbRequestHeaders(
    config.webUrl,
  );
  const requestInit = { headers: requestHeaders } satisfies RequestInit;
  const file = await runProtectedVtbRequest(
    url,
    requestInit,
    VTB_JSON_REQUEST_INTERVAL_MS,
    async () => {
      const response = await fetchWithRiskControlProxy(
        (proxy) => fetchWithRetry(url, {
          ...requestInit,
          timeoutMs: FETCH_TIMEOUT_MS,
          retryCount: 1,
          retryDelayMs: 2_000,
          retryJitterMs: 2_000,
          retryRateLimited: false,
          ...(proxy ? { proxy } : {}),
        }),
        config.proxyUrl,
      );
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
          startFanClub: session.startFanClub ?? undefined,
          startGuards: session.startGuards ?? undefined,
          startGuardSnapshot: {
            ids: session.startGuardIds,
            names: session.startGuardNames,
            captured: session.startGuardSnapshotCaptured,
          },
          roomId: session.liveRoom?.toString(),
          deliveredGroupIds: session.deliveredGroupIds,
          endedAt: session.endedAt ?? undefined,
          endFans: session.endFans ?? undefined,
          endFanClub: session.endFanClub ?? undefined,
          endGuards: session.endGuards ?? undefined,
          endGuardSnapshot: {
            ids: session.endGuardIds,
            names: session.endGuardNames,
            captured: session.endGuardSnapshotCaptured,
          },
          endDeliveredGroupIds: session.endDeliveredGroupIds,
        }
      : undefined;
  };

  const startLiveSession = async (
    streamer: VtbStreamer,
    live: VtbLiveInfo,
    fans?: number,
    deliveredGroupIds: readonly string[] = [],
    stats: VtbLiveStats = {},
    guardSnapshot?: VtbGuardSnapshot,
  ) => {
    await prisma.vtbLiveSession.upsert({
      where: { streamerMid: toMid(streamer.mid) },
      create: {
        streamerMid: toMid(streamer.mid),
        liveRoom: toOptionalMid(live.roomId),
        startedAt: live.liveStartedAt ?? new Date(),
        startFans: stats.fans ?? fans,
        startFanClub: stats.fanClub,
        startGuards: stats.guards ?? (guardSnapshot?.captured ? guardSnapshot.ids.length : undefined),
        startGuardIds: guardSnapshot?.ids ?? [],
        startGuardNames: guardSnapshot?.names ?? [],
        startGuardSnapshotCaptured: guardSnapshot?.captured ?? false,
        deliveredGroupIds: [...deliveredGroupIds],
        endDeliveredGroupIds: [],
      },
      update: {
        liveRoom: toOptionalMid(live.roomId),
        startedAt: live.liveStartedAt ?? new Date(),
        startFans: stats.fans ?? fans,
        startFanClub: stats.fanClub,
        startGuards: stats.guards ?? (guardSnapshot?.captured ? guardSnapshot.ids.length : undefined),
        startGuardIds: guardSnapshot?.ids ?? [],
        startGuardNames: guardSnapshot?.names ?? [],
        startGuardSnapshotCaptured: guardSnapshot?.captured ?? false,
        deliveredGroupIds: [...deliveredGroupIds],
        endDeliveredGroupIds: [],
        endedAt: null,
        endFans: null,
        endFanClub: null,
        endGuards: null,
        endGuardIds: [],
        endGuardNames: [],
        endGuardSnapshotCaptured: false,
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

  const captureLiveSessionStartGuards = async (mid: string, guardSnapshot: VtbGuardSnapshot) => {
    await prisma.vtbLiveSession.updateMany({
      where: { streamerMid: toMid(mid), endedAt: null, startGuardSnapshotCaptured: false },
      data: {
        startGuards: guardSnapshot.captured ? guardSnapshot.ids.length : undefined,
        startGuardIds: guardSnapshot.ids,
        startGuardNames: guardSnapshot.names,
        startGuardSnapshotCaptured: guardSnapshot.captured,
      },
    });
  };

  const markLiveSessionEnded = async (
    mid: string,
    fans?: number,
    endedAt = new Date(),
    stats: VtbLiveStats = {},
    guardSnapshot?: VtbGuardSnapshot,
  ) => {
    await prisma.vtbLiveSession.update({
      where: { streamerMid: toMid(mid) },
      data: {
        endedAt,
        endFans: stats.fans ?? fans,
        endFanClub: stats.fanClub,
        endGuards: stats.guards ?? (guardSnapshot?.captured ? guardSnapshot.ids.length : undefined),
        endGuardIds: guardSnapshot?.ids ?? [],
        endGuardNames: guardSnapshot?.names ?? [],
        endGuardSnapshotCaptured: guardSnapshot?.captured ?? false,
      },
    });
  };

  const findFf14Item = async (queryName: string) => {
    const item = await prisma.ff14Item.findUnique({ where: { queryName } });
    return item ? { id: item.itemId, name: item.name } : undefined;
  };

  const upsertFf14Item = async (queryName: string, item: { id: number; name: string }) => {
    await prisma.ff14Item.upsert({
      where: { queryName },
      create: { queryName, itemId: item.id, name: item.name },
      update: { itemId: item.id, name: item.name },
    });
  };

  const disableFf14PriceAlert = async (
    groupId: string | number,
    itemName: string,
    disabledBy?: string | number,
  ) => {
    const key = { groupId: String(groupId), itemName };
    const existing = await prisma.ff14PriceAlertSuppression.findUnique({
      where: { groupId_itemName: key },
    });
    await prisma.ff14PriceAlertSuppression.upsert({
      where: { groupId_itemName: key },
      create: {
        ...key,
        disabledBy: disabledBy === undefined ? null : String(disabledBy),
      },
      update: {},
    });
    return existing === null;
  };

  const enableFf14PriceAlert = async (groupId: string | number, itemName: string) => {
    const result = await prisma.ff14PriceAlertSuppression.deleteMany({
      where: { groupId: String(groupId), itemName },
    });
    return result.count > 0;
  };

  const listDisabledFf14PriceAlerts = async (groupId?: string | number) =>
    prisma.ff14PriceAlertSuppression.findMany({
      where: groupId === undefined ? undefined : { groupId: String(groupId) },
      orderBy: { createdAt: "asc" },
    });

  const listDeliveredFf14PriceAlertListingKeys = async (
    groupId: string | number,
    region: string,
    itemId: number,
    listingKeys: readonly string[],
  ) => {
    if (listingKeys.length === 0) return [];
    const deliveries = await prisma.ff14PriceAlertDelivery.findMany({
      where: {
        groupId: String(groupId),
        region,
        itemId,
        listingKey: { in: [...listingKeys] },
      },
      select: { listingKey: true },
    });
    if (deliveries.length > 0) {
      await prisma.ff14PriceAlertDelivery.updateMany({
        where: {
          groupId: String(groupId),
          region,
          itemId,
          listingKey: { in: deliveries.map((delivery) => delivery.listingKey) },
        },
        data: { lastSeenAt: new Date() },
      });
    }
    return deliveries.map((delivery) => delivery.listingKey);
  };

  const recordFf14PriceAlertDeliveries = async (
    groupId: string | number,
    region: string,
    itemId: number,
    listingKeys: readonly string[],
  ) => {
    if (listingKeys.length === 0) return;
    await prisma.ff14PriceAlertDelivery.createMany({
      data: [...new Set(listingKeys)].map((listingKey) => ({
        groupId: String(groupId),
        region,
        itemId,
        listingKey,
      })),
      skipDuplicates: true,
    });
  };

  const cleanupExpiredFf14PriceAlertDeliveries = async (lastSeenBefore: Date) =>
    prisma.ff14PriceAlertDelivery.deleteMany({
      where: { lastSeenAt: { lt: lastSeenBefore } },
    });

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
    initialize, findFf14Item, upsertFf14Item,
    disableFf14PriceAlert, enableFf14PriceAlert, listDisabledFf14PriceAlerts,
    listDeliveredFf14PriceAlertListingKeys, recordFf14PriceAlertDeliveries,
    cleanupExpiredFf14PriceAlertDeliveries,
    findStreamerByName, listStreamers, deleteStreamersNotInNames, deleteStreamerByName,
    upsertStreamer, getLiveSession, startLiveSession, captureLiveSessionStartGuards,
    recordLiveDelivery, markLiveSessionEnded,
    recordLiveEndDelivery,
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

const formatSyncFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (error instanceof Error && (error.name === "VtbRateLimitError" || error.name === "VtbCooldownError")) {
    return "B 站这会儿不让查，请等一会儿再试";
  }
  if (/database|prisma|postgres|connection refused|econnrefused/.test(message)) {
    return "数据库没连上，请检查数据库状态再试";
  }
  if (/fetch failed|network|timeout|timed out|socket|dns|bilibili .*api|api failed|http \d/.test(message)) {
    return "B 站接口这会儿没回消息，请检查网络或代理配置再试";
  }
  return "这次同步没处理好，请稍后再试";
};

export const formatLiveMessage = (
  live: VtbLiveInfo,
  fans: number | undefined,
  liveWebUrl: string,
) => [
  `🔴 ${live.name} 的直播间开门啦！`,
  "",
  "今天播的是——",
  `「${live.title}」`,
  "",
  ...(live.liveStartedAt ? [`⏰ ${dayjs(live.liveStartedAt).format("MM月DD日 HH:mm")} 开播`] : []),
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
  startStats: VtbLiveStats = {},
  endStats: VtbLiveStats = {},
  guardNames: readonly string[] = [],
) => {
  const fanChange = positiveCountChange(startFans, endFans);
  const fanClubChange = positiveCountChange(startStats.fanClub, endStats.fanClub);
  const guardChange = positiveCountChange(startStats.guards, endStats.guards);
  const durationMinutes = Math.max(1, Math.floor((endedAt.getTime() - startedAt.getTime()) / 60_000));
  const guardThanks = guardNames.length === 0
    ? []
    : ["感谢本场上舰的观众：", ...guardNames.map((guardName) => `- ${guardName}`), ""];
  return [
    `🌙 ${name} 今天收工啦`,
    "",
    `这次和大家一起度过了 ${formatLiveDuration(durationMinutes)}`,
    `⏰ ${dayjs(endedAt).format("MM月DD日 HH:mm")} 结束`,
    ...(fanChange === undefined ? [] : [`✨ 本场新关注 +${fanChange.toLocaleString("zh-CN")}`]),
    ...(fanClubChange === undefined ? [] : [`💖 本场粉丝团 +${fanClubChange.toLocaleString("zh-CN")}`]),
    ...(guardChange === undefined ? [] : [`⚓ 本场大航海 +${guardChange.toLocaleString("zh-CN")}`]),
    "",
    ...guardThanks,
    "辛苦啦，也谢谢大家一路陪到下播。充好电，我们下次见！",
  ].join("\n");
};

export const getVtbNewGuardNames = (
  start: VtbGuardSnapshot | undefined,
  end: VtbGuardSnapshot | undefined,
) => {
  if (!start?.captured || !end?.captured) return [];
  const startIds = new Set(start.ids);
  const namesById = new Map(end.ids.map((id, index) => [id, end.names[index] || id]));
  const newIds = end.ids.filter((id) => !startIds.has(id));
  if (newIds.length === 0 || newIds.length > 5) return [];
  return newIds.map((id) => namesById.get(id) || id).filter(Boolean);
};

const positiveCountChange = (start: number | undefined, end: number | undefined) => {
  if (start === undefined || end === undefined || end <= start) {
    return undefined;
  }
  return end - start;
};

export const formatDynamicMessage = (dynamic: VtbDynamic, webUrl: string) => {
  const dynamicUrl = formatDynamicUrl(dynamic.link, webUrl);
  const hasDynamicUrlInDescription =
    dynamic.containsDynamicUrl ||
    dynamic.description.includes(dynamic.link) ||
    dynamic.description.includes(dynamicUrl);
  const display = selectDynamicDisplayText(dynamic.title, dynamic.description);
  const content = display.title
    ? [`「${display.title}」`, ...(display.description ? ["", ...display.description.split("\n")] : [])]
    : display.description
      ? display.description.split("\n")
      : ["只留下了标题，点进原文看看吧。"];

  return [
    `📮 ${dynamic.author} 发来一条新动态`,
    "",
    ...content,
    "",
    `⏰ ${dayjs(dynamic.publishedAt).format("MM月DD日 HH:mm")} 发布`,
    ...(hasDynamicUrlInDescription ? [] : [`🔗 完整动态 · ${dynamicUrl}`]),
  ].join("\n");
};

const selectDynamicDisplayText = (title: string, description: string) => {
  const normalizedTitle = normalizeDynamicComparisonText(title);
  const normalizedDescription = normalizeDynamicComparisonText(description);

  if (!normalizedTitle && !normalizedDescription) {
    return { title: "", description: "" };
  }
  // The complete counterpart must be contained; sharing only a fragment does
  // not qualify for de-duplication.
  if (normalizedTitle && normalizedDescription && normalizedTitle.includes(normalizedDescription)) {
    return { title, description: "" };
  }
  if (normalizedTitle && normalizedDescription && normalizedDescription.includes(normalizedTitle)) {
    return { title: "", description };
  }
  return { title, description };
};

const normalizeDynamicComparisonText = (value: string) => value.replace(/\s+/g, " ").trim();

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
  const prisma = createDatabaseClient(getDatabaseUrl(config));
  try {
    const repository = createVtbRepository(prisma);
    await repository.initialize();
    return repository;
  } catch (error) {
    await prisma.$disconnect().catch(() => undefined);
    throw error;
  }
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
  proxyUrl = "",
  minimumIntervalMs = VTB_JSON_REQUEST_INTERVAL_MS,
) => {
  const requestInit: RequestInit = {
    ...init,
    headers: createVtbRequestHeaders(webUrl, headers, init?.headers),
  };
  return runProtectedVtbRequest(
    url,
    requestInit,
    minimumIntervalMs,
    async () => {
      const fetchResponse = (proxy?: string) => fetchWithRetry(url, {
        ...requestInit,
        timeoutMs: FETCH_TIMEOUT_MS,
        retryCount: 1,
        retryDelayMs: 2_000,
        retryJitterMs: 3_000,
        retryRateLimited: false,
        ...(proxy ? { proxy } : {}),
      });
      let usedProxy = false;
      const response = await fetchWithRiskControlProxy((proxy) => {
        usedProxy = Boolean(proxy);
        return fetchResponse(proxy);
      }, proxyUrl);
      const payload = await readResponseJson(response, MAX_VTB_RESPONSE_BYTES);
      if (proxyUrl && !usedProxy && isVtbRiskControlPayload(payload)) {
        const proxyResponse = await fetchResponse(proxyUrl);
        return readResponseJson(proxyResponse, MAX_VTB_RESPONSE_BYTES);
      }
      return payload;
    },
  );
};

const isVtbRiskControlPayload = (payload: unknown) => {
  if (!isRecord(payload)) {
    return false;
  }
  const code = payload.code;
  return (typeof code === "number" ? code : Number(code)) === -509;
};

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
    const protectionKey = getVtbProtectionKey(url);
    assertVtbRequestAvailable(protectionKey);
    await reserveVtbRequestSlot(host, protectionKey, minimumIntervalMs);
    assertVtbRequestAvailable(protectionKey);
    try {
      return await request();
    } catch (error) {
      recordVtbTransportFailure(protectionKey, error);
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

const reserveVtbRequestSlot = async (
  host: string,
  protectionKey: string,
  minimumIntervalMs: number,
) => {
  const state = getVtbRequestState(host);
  const queued = state.queue.catch(() => undefined).then(async () => {
    assertVtbRequestAvailable(protectionKey);
    // Carry a bounded part of a stricter interval across endpoint types. This
    // prevents a sensitive user-search request (5s) from being followed by a
    // dynamic request immediately, without making an interactive query wait
    // for the full search interval again.
    const inheritedIntervalMs = state.lastMinimumIntervalMs > minimumIntervalMs
      ? Math.min(state.lastMinimumIntervalMs, minimumIntervalMs + 1_000)
      : state.lastMinimumIntervalMs;
    const effectiveIntervalMs = Math.max(minimumIntervalMs, inheritedIntervalMs);
    const jitterMs = minimumIntervalMs > 0 ? Math.random() * minimumIntervalMs : 0;
    const waitMs = state.lastRequestAt + effectiveIntervalMs + jitterMs - Date.now();
    if (waitMs > 0) {
      await waitForVtbRequest(waitMs);
    }
    assertVtbRequestAvailable(protectionKey);
    state.lastRequestAt = Date.now();
    state.lastMinimumIntervalMs = minimumIntervalMs;
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
  const error = new Error(`Bilibili ${apiName} API failed: code ${code}`);
  if (!VTB_RATE_LIMIT_CODES.has(code)) {
    throw error;
  }

  const state = getVtbRequestState(getVtbProtectionKey(url));
  throw Object.assign(error, {
    name: "VtbRateLimitError",
    code,
    cooldownUntil: state.cooldownUntil,
  });
};

const recordVtbRequestSuccess = (url: string) => {
  const state = getVtbRequestState(getVtbProtectionKey(url));
  state.consecutiveFailures = 0;
  if (state.cooldownUntil <= Date.now()) {
    state.cooldownReason = undefined;
  }
};

const recordVtbBusinessFailure = (url: string, code: number) => {
  const state = getVtbRequestState(getVtbProtectionKey(url));
  if (!VTB_RATE_LIMIT_CODES.has(code)) {
    // A parsed business response proves transport is healthy. Invalid input or
    // an endpoint-specific rejection must not contribute to a host-wide
    // transient-failure circuit breaker.
    state.consecutiveFailures = 0;
    return;
  }

  state.consecutiveFailures += 1;
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + VTB_RISK_COOLDOWN_MS);
  state.cooldownReason = "risk";
};

const recordVtbTransportFailure = (protectionKey: string, error: unknown) => {
  if (isVtbCooldownError(error)) {
    return;
  }

  const state = getVtbRequestState(protectionKey);
  const status = getHttpErrorStatus(error);
  if (status === 412 || status === 429) {
    const retryAfterMs = getHttpRetryAfterMs(error);
    state.consecutiveFailures += 1;
    const cooldownMs = Math.min(
      VTB_MAX_RISK_COOLDOWN_MS,
      Math.max(VTB_RISK_COOLDOWN_MS, retryAfterMs ?? 0),
    );
    state.cooldownUntil = Math.max(
      state.cooldownUntil,
      Date.now() + cooldownMs,
    );
    state.cooldownReason = "risk";
    if (error instanceof Error) {
      Object.assign(error, {
        cooldownUntil: state.cooldownUntil,
        cooldownReason: state.cooldownReason,
      });
    }
    return;
  }

  if (status === undefined || status === 408 || status >= 500) {
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= VTB_TRANSIENT_FAILURE_THRESHOLD) {
      state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + VTB_TRANSIENT_COOLDOWN_MS);
      state.cooldownReason = "transient";
    }
  }
};

const assertVtbRequestAvailable = (protectionKey: string) => {
  const cooldownUntil = getVtbRequestState(protectionKey).cooldownUntil;
  if (cooldownUntil <= Date.now()) {
    return;
  }

  throw Object.assign(
    new Error(`VTB upstream ${protectionKey} is cooling down until ${new Date(cooldownUntil).toISOString()}`),
    {
      name: "VtbCooldownError",
      cooldownUntil,
      cooldownReason: getVtbRequestState(protectionKey).cooldownReason ?? "transient",
    },
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
    cooldownReason: undefined,
    lastRequestAt: 0,
    lastMinimumIntervalMs: 0,
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

const getVtbProtectionKey = (url: string) => {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "api.bilibili.com") {
      return parsed.host;
    }
    if (parsed.pathname.includes("/search/")) return `${parsed.host}:search`;
    if (parsed.pathname.includes("/web-dynamic/")) return `${parsed.host}:dynamic`;
    if (parsed.pathname.includes("/user/cards")) return `${parsed.host}:card`;
    return `${parsed.host}:${parsed.pathname}`;
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
  `${config.liveApiUrl}\n${mid}`;

const getVtbCardCacheKey = (config: VtbConfig, mid: string) =>
  `${config.cardApiUrl}\n${mid}`;

const getVtbLiveStatsCacheKey = (mid: string, config: VtbConfig) =>
  `${config.liveMasterApiUrl || endpointFromBase(config.liveWebUrl, "/live_user/v1/Master/info")}\n${config.liveWebUrl}\n${config.cardApiUrl}\n${config.proxyUrl}\n${mid}`;

const endpointFromBase = (baseUrl: string, path: string) => {
  try {
    return new URL(path, baseUrl).href;
  } catch {
    return path;
  }
};

const getVtbDynamicQueryCacheMs = (config: VtbConfig) =>
  Math.max(5 * 60_000, Math.min(30 * 60_000, (config.dynamicPollMinutes ?? 15) * 60_000));

const createUserSearchApiUrl = (apiUrl: string, name: string) => {
  const url = new URL(apiUrl);
  // Existing configuration uses an empty query value (usually `keyword=` or
  // `name=`). Setting the value through URLSearchParams preserves unrelated
  // parameters and correctly encodes spaces, fragments and non-ASCII names.
  const parameter = [...url.searchParams.keys()].find((key) => url.searchParams.get(key) === "") ??
    ["keyword", "name", "q", "query"].find((key) => url.searchParams.has(key));
  if (parameter) {
    url.searchParams.set(parameter, name);
  } else if (url.search) {
    url.searchParams.set("keyword", name);
  } else {
    // Keep compatibility with path-based proxy endpoints that intentionally
    // place the search term after the URL rather than in a query parameter.
    return `${apiUrl.replace(/#.*$/, "")}${encodeURIComponent(name)}`;
  }
  url.hash = "";
  return url.href;
};

const isBilibiliWbiSearchUrl = (url: string, configuredUrl: string) => {
  try {
    const parsed = new URL(url);
    return Boolean(configuredUrl) && parsed.pathname === new URL(configuredUrl).pathname;
  } catch {
    return false;
  }
};

const isBilibiliWbiCardUrl = (url: string, configuredUrl: string) => {
  try {
    const parsed = new URL(url);
    return Boolean(configuredUrl) && parsed.pathname === new URL(configuredUrl).pathname && parsed.pathname.includes("/wbi/");
  } catch {
    return false;
  }
};

const extractVtbSearchUsers = (value: unknown): VtbStreamer[] => {
  const users = new Map<string, VtbStreamer>();
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isRecord(candidate)) return;

    const legacy = legacyUserSchema.safeParse(candidate);
    if (legacy.success) {
      users.set(String(legacy.data.mid), {
        name: legacy.data.uname.trim(),
        mid: String(legacy.data.mid),
        roomId: normalizeRoomId(legacy.data.room_id),
      });
    }
    const modern = z.looseObject({
      name: z.string().min(1).optional(),
      uname: z.string().min(1).optional(),
      mid: z.union([z.string(), z.number()]).optional(),
      uid: z.union([z.string(), z.number()]).optional(),
      room_id: z.union([z.string(), z.number()]).optional(),
    }).safeParse(candidate);
    const modernMid = modern.success ? modern.data.mid ?? modern.data.uid : undefined;
    if (modern.success && modernMid !== undefined && (modern.data.name || modern.data.uname)) {
      users.set(String(modernMid), {
        name: (modern.data.name ?? modern.data.uname!).trim(),
        mid: String(modernMid),
        roomId: normalizeRoomId(modern.data.room_id),
      });
    }
    visit(candidate.result);
    visit(candidate.data);
    visit(candidate.uid_list);
  };
  visit(value);
  return [...users.values()];
};

const signBilibiliUrl = async (url: string, config: VtbConfig) => {
  const parsed = new URL(url);
  const mixinKey = await getVtbWbiMixinKey(config);
  const entries = [...parsed.searchParams.entries()]
    .filter(([key]) => key !== "w_rid" && key !== "wts")
    .map(([key, value]) => [key, value.replace(/[!'()*]/g, "")] as const);
  const wts = Math.floor(Date.now() / 1_000).toString();
  const signingQuery = [...entries, ["wts", wts] as const]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const wRid = createHash("md5").update(`${signingQuery}${mixinKey}`).digest("hex");
  const originalQuery = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .concat(`w_rid=${wRid}`, `wts=${wts}`)
    .join("&");
  parsed.search = originalQuery;
  parsed.hash = "";
  return parsed.href;
};

const getVtbWbiMixinKey = async (config: VtbConfig) => {
  if (vtbWbiKeys && vtbWbiKeys.expiresAt > Date.now()) {
    return vtbWbiKeys.mixinKey;
  }
  vtbWbiKeysPromise ??= (async () => {
    const credential = await getBilibiliCredentialHeader().catch(() => undefined);
    const response = z.looseObject({ code: integerSchema, data: z.unknown().optional() }).parse(
      await fetchJson(
        config.navApiUrl || endpointFromBase(config.webUrl, "/x/web-interface/nav"),
        config.webUrl,
        credential ? { Cookie: credential } : undefined,
        undefined,
        config.proxyUrl,
      ),
    );
    if (response.code !== 0 && response.code !== -101) {
      assertVtbApiSuccess(config.navApiUrl || endpointFromBase(config.webUrl, "/x/web-interface/nav"), "nav", response.code);
    }
    const wbiImage = isRecord(response.data) && isRecord(response.data.wbi_img)
      ? response.data.wbi_img
      : undefined;
    const imgUrl = firstText(wbiImage?.img_url);
    const subUrl = firstText(wbiImage?.sub_url);
    const imgKey = imgUrl?.split("/").pop()?.split(".")[0];
    const subKey = subUrl?.split("/").pop()?.split(".")[0];
    if (!imgKey || !subKey) throw new Error("Bilibili nav API returned no WBI keys");
    const mixinKeyEncTab = [
      46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
      27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
      37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
      22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
    ];
    const rawKey = imgKey + subKey;
    const mixinKey = mixinKeyEncTab.map((index) => rawKey[index]).join("").slice(0, 32);
    vtbWbiKeys = { mixinKey, expiresAt: Date.now() + 60 * 60_000 };
    return mixinKey;
  })();
  try {
    return await vtbWbiKeysPromise;
  } finally {
    vtbWbiKeysPromise = undefined;
  }
};

/** Return the complete guard list for a room, including the separately returned top three. */
export const getVtbGuardSnapshot = async (
  roomId: string,
  mid: string,
  config: VtbConfig,
  options: { knownIds?: ReadonlySet<string>; stopAfterNew?: number } = {},
): Promise<VtbGuardSnapshot> => {
  const ids: string[] = [];
  const names: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  let newCount = 0;
  for (let page = 1; page <= 100; page += 1) {
    const query = new URLSearchParams({
      roomid: roomId,
      ruid: mid,
      page: String(page),
      page_size: "30",
      typ: "3",
    });
    const url = `${config.guardApiUrl || endpointFromBase(config.liveWebUrl, "/xlive/app-room/v2/guardTab/topListNew")}?${query.toString()}`;
    const response = z.looseObject({ code: integerSchema, data: z.unknown().optional() }).parse(
      await fetchJson(url, config.webUrl, undefined, undefined, config.proxyUrl, VTB_GUARD_REQUEST_INTERVAL_MS),
    );
    assertVtbApiSuccess(url, "guard", response.code);
    if (!isRecord(response.data)) {
      throw new Error("Bilibili guard API returned no data");
    }
    const data = response.data;
    total = findCount(data.info, ["num", "total", "count"]) ?? total;
    const entries = [
      ...(page === 1 && Array.isArray(data.top3) ? data.top3 : []),
      ...(Array.isArray(data.list) ? data.list : []),
    ];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const uinfo = isRecord(entry.uinfo) ? entry.uinfo : entry;
      const id = firstText(uinfo.uid ?? uinfo.mid);
      const name = firstText(isRecord(uinfo.base) ? uinfo.base.name : uinfo.uname ?? uinfo.name);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
        names.push(name || id);
        if (options.knownIds && !options.knownIds.has(id)) {
          newCount += 1;
        }
      }
    }
    if (options.stopAfterNew !== undefined && newCount >= options.stopAfterNew) break;
    if (entries.length === 0 || (total > 0 && ids.length >= total) || entries.length < 30) break;
  }
  return { ids, names, captured: total === 0 || ids.length >= total };
};

const isDocumentedLiveRoomInfoUrl = (apiUrl: string) => {
  try {
    const parsed = new URL(apiUrl);
    return parsed.hostname === "api.live.bilibili.com" &&
      parsed.pathname === "/room/v1/Room/get_info";
  } catch {
    return false;
  }
};

const createLiveRoomInfoUrl = (apiUrl: string, roomId: string) => {
  const url = new URL(apiUrl);
  url.searchParams.set("room_id", roomId);
  url.hash = "";
  return url.href;
};

const createCardApiUrl = (apiUrl: string, mids: readonly string[]) => {
  const url = new URL(apiUrl);
  const parameter = url.searchParams.has("uids") ? "uids" : url.searchParams.has("mid") ? "mid" : undefined;
  if (!parameter) {
    throw new Error("Bilibili card API URL must include the uids or mid query parameter");
  }
  url.searchParams.set(parameter, mids.join(","));
  return url.href;
};

const hasCardQueryParameter = (apiUrl: string, parameter: "mid" | "uids") => {
  try {
    return new URL(apiUrl).searchParams.has(parameter);
  } catch {
    return false;
  }
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

const asRecord = (value: unknown) => isRecord(value) ? value : undefined;

/** Reads count fields across the slightly different shapes returned by Bilibili APIs. */
const findCount = (value: unknown, keys: readonly string[]): number | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    const count = typeof candidate === "object"
      ? findCount(candidate, ["count", "num", "number", "total"])
      : toFiniteCount(candidate);
    if (count !== undefined) {
      return count;
    }
  }

  for (const child of Object.values(value)) {
    const count = findCount(child, keys);
    if (count !== undefined) {
      return count;
    }
  }
  return undefined;
};

const toFiniteCount = (value: unknown) => {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : undefined;
};

export const parseBilibiliDynamicFeed = (
  items: readonly unknown[],
  fallbackAuthor: string,
  webUrl: string,
): VtbDynamicFeed => {
  const parsed = items
    .map((item) => parseBilibiliDynamicItem(item, fallbackAuthor, webUrl))
    .filter((item): item is { dynamic: VtbDynamic; avatarUrl?: string } => item !== undefined)
    .sort((left, right) => right.dynamic.publishedAt.getTime() - left.dynamic.publishedAt.getTime());
  const unique = new Map<string, { dynamic: VtbDynamic; avatarUrl?: string }>();
  for (const item of parsed) {
    // The feed can contain the same dynamic twice while Bilibili is updating
    // its cache. Deduplicate before the delivery layer sees it.
    const identity = formatDynamicUrl(item.dynamic.link, "https://www.bilibili.com");
    if (!unique.has(identity)) {
      unique.set(identity, item);
    }
  }
  const deduplicated = [...unique.values()];

  return {
    avatarUrl: parsed.find((item) => item.avatarUrl)?.avatarUrl ?? "",
    items: deduplicated.map((item) => item.dynamic),
  };
};

const parseBilibiliDynamicItem = (
  value: unknown,
  fallbackAuthor: string,
  webUrl: string,
): { dynamic: VtbDynamic; avatarUrl?: string } | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const modules = asRecord(value.modules);
  const author = asRecord(modules?.module_author);
  const original = asRecord(value.orig);
  const originalModules = asRecord(original?.modules);
  const dynamic = asRecord(modules?.module_dynamic) ?? asRecord(originalModules?.module_dynamic);
  const major = asRecord(dynamic?.major);
  // Bilibili represents an automatic "live started" notification as a
  // dynamic item too. It is not a user-authored post and must not be sent as
  // a VTB dynamic notification. Keep the structural check as a fallback for
  // responses where the top-level type is omitted by an upstream variant.
  const dynamicType = firstText(value.type)?.toUpperCase();
  if (dynamicType === "DYNAMIC_TYPE_LIVE_RCMD" || major?.live_rcmd != null) {
    return undefined;
  }
  const id = firstText(
    value.id_str,
    value.dynamic_id,
    value.id,
    getTextAt(value.basic, "comment_id"),
    getTextAt(value.basic, "comment_id_str"),
    getTextAt(value.basic, "rid_str"),
  );
  const rawLink = firstText(
    value.uri,
    value.link,
    value.dynamic_url,
    getTextAt(value.basic, "jump_url"),
    getTextAt(major?.opus, "jump_url"),
    getTextAt(major?.archive, "jump_url"),
    getTextAt(major?.article, "jump_url"),
  );
  const link = normalizeBilibiliDynamicLink(rawLink, id);
  const publishedAt = parseBilibiliDate(
    author?.pub_ts ?? author?.pub_time ?? value.pub_ts ?? value.pub_time,
  );
  if (!link || !publishedAt) {
    return undefined;
  }

  const description = truncateDynamicText(cleanDynamicText([
    getTextAt(dynamic?.desc, "text"),
    getTextAt(major?.archive, "desc"),
    getTextAt(major?.article, "desc"),
    getTextAt(major?.article, "summary"),
    getTextAt(major?.opus, "summary", "text"),
    getTextAt(major?.common, "desc"),
    getTextAt(major?.live, "desc_first"),
    getTextAt(major?.live, "desc_second"),
  ].filter(Boolean).join("\n")));
  const formattedLink = formatDynamicUrl(link, webUrl);
  const authorName = firstText(author?.name) || fallbackAuthor;
  const title = firstText(
    getTextAt(major?.archive, "title"),
    getTextAt(major?.article, "title"),
    getTextAt(major?.opus, "title"),
    getTextAt(major?.common, "title"),
    getTextAt(major?.live, "title"),
    getTextAt(major?.opus, "summary", "text"),
    getTextAt(dynamic?.desc, "text"),
  ) || "B站动态";

  return {
    dynamic: {
      title,
      description,
      containsDynamicUrl: description.includes(link) || description.includes(formattedLink),
      publishedAt,
      link,
      author: authorName,
    },
    avatarUrl: cleanImageUrl(firstText(author?.face)),
  };
};

const firstText = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
};

const getTextAt = (value: unknown, ...path: string[]) => {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return firstText(current);
};

const normalizeBilibiliDynamicLink = (value: string | undefined, id: string | undefined) => {
  if (value) {
    if (value.startsWith("//")) return `https:${value}`;
    if (value.startsWith("/")) return `https://www.bilibili.com${value}`;
    if (/^https?:\/\//i.test(value)) return value;
  }
  return id ? `https://t.bilibili.com/${id}` : undefined;
};

const parseBilibiliDate = (value: unknown) => {
  if (typeof value === "number") {
    return parseDate(value);
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? parseDate(numeric > 10_000_000_000 ? numeric / 1_000 : numeric) : undefined;
  }
  return typeof value === "string" ? parseDate(value) : undefined;
};

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

const toVtbLiveInfo = (streamer: VtbStreamer, live: z.infer<typeof liveInfoSchema> | undefined): VtbLiveInfo => {
  const fans = findCount(live, [
    "fans", "fan_count", "fanCount", "follower", "followers", "follower_num", "followerNum",
  ]);
  const fanClub = findCount(live, [
    "fan_club", "fanClub", "fan_club_count", "fanClubCount", "fan_club_num", "fanClubNum",
    "fans_club", "fansClub", "fans_club_num", "fansClubNum", "fans_num", "fansNum",
    "fans_group_count", "fansGroupCount",
  ]);
  const guards = findCount(live, [
    "guards", "guard", "guard_num", "guardNum", "guard_count", "guardCount",
    "guard_info", "guardInfo",
  ]);
  return {
    title: live?.title?.trim() || "还没有直播标题",
    roomId: live?.room_id === undefined ? normalizeRoomId(streamer.roomId) : normalizeRoomId(live.room_id),
    liveStartedAt: parseDate(live?.live_time),
    // The status endpoint uses 1 for an active live stream. Status 2 is a
    // non-live room state (for example replay/rotation) and must not trigger
    // an opening notification.
    isLive: live?.live_status === 1,
    name: live?.uname?.trim() || streamer.name,
    coverUrl: pickImageUrl(live?.cover_from_user, live?.keyframe, live?.user_cover, live?.cover),
    ...(fans === undefined ? {} : { fans }),
    ...(fanClub === undefined ? {} : { fanClub }),
    ...(guards === undefined ? {} : { guards }),
  };
};

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
  const normalized = url.startsWith("//") ? `https:${url}` : url;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? normalized : undefined;
  } catch {
    return undefined;
  }
};

const parseDate = (value: string | number | undefined) => {
  if (!value || value === "0000-00-00 00:00:00") return undefined;
  const numericValue = typeof value === "number"
    ? value
    : /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : undefined;
  const date = numericValue !== undefined
    ? new Date((numericValue > 10_000_000_000 ? numericValue : numericValue * 1_000))
    : new Date(value);
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
