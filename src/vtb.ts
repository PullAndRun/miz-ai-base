import dayjs from "dayjs";
import { XMLParser } from "fast-xml-parser";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { z } from "zod";
import type { MizConfig, VtbConfig } from "@/config";

const FETCH_TIMEOUT_MS = 15_000;
const DYNAMIC_RETRY_DELAY_MS = 10_000;
const MAX_DYNAMIC_DESCRIPTION_LENGTH = 1_800;
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
  data: z.looseObject({ card: z.looseObject({ fans: z.union([z.string(), z.number()]).optional() }) }),
});
const liveInfoSchema = z.looseObject({
  title: z.string().optional(),
  room_id: z.union([z.string(), z.number()]).optional(),
  live_time: z.union([z.string(), z.number()]).optional(),
  live_status: z.number().int().optional(),
  uname: z.string().optional(),
  cover_from_user: z.string().optional(),
});
const liveResponseSchema = z.looseObject({
  code: z.number(),
  data: z.record(z.string(), liveInfoSchema).optional().default({}),
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
export type LiveSession = { startedAt: Date; startFans?: number; roomId?: string };

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (_name, jPath) => jPath === "rss.channel.item",
});

let repositoryPromise: Promise<VtbRepository> | undefined;

export const getVtbRepository = async (config: MizConfig) => {
  if (!repositoryPromise) {
    repositoryPromise = createVtbRepository(config);
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
  const response = userResponseSchema.parse(
    await fetchJson(
      `${config.userApiUrl}${encodeURIComponent(name)}`,
      config.bilibiliCookie ? { Cookie: config.bilibiliCookie } : undefined,
    ),
  );
  if (response.code !== 0) {
    throw new Error(`Bilibili user API failed: code ${response.code}`);
  }

  const user = response.data.result.find((item) => item.uname === name) ?? response.data.result[0];
  return user
    ? { name: user.uname, mid: String(user.mid), roomId: user.room_id === undefined ? undefined : String(user.room_id) }
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

export const getVtbFanCount = async (mid: string, config: VtbConfig) => {
  const response = cardResponseSchema.parse(
    await fetchJson(
      `${config.cardApiUrl}${encodeURIComponent(mid)}`,
      config.bilibiliCookie ? { Cookie: config.bilibiliCookie } : undefined,
    ),
  );
  if (response.code !== 0) throw new Error(`Bilibili card API failed: code ${response.code}`);
  const fans = Number(response.data.card.fans);
  return Number.isFinite(fans) ? fans : undefined;
};

export const getVtbLiveInfo = async (streamer: VtbStreamer, config: VtbConfig): Promise<VtbLiveInfo> => {
  const response = liveResponseSchema.parse(
    await fetchJson(config.liveApiUrl, config.bilibiliCookie ? { Cookie: config.bilibiliCookie } : undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uids: [streamer.mid] }),
    }),
  );
  if (response.code !== 0) throw new Error(`Bilibili live API failed: code ${response.code}`);

  const live = response.data[streamer.mid];
  return {
    title: live?.title?.trim() || "暂无直播标题",
    roomId: live?.room_id === undefined ? streamer.roomId : String(live.room_id),
    liveStartedAt: parseDate(live?.live_time),
    isLive: live?.live_status === 1,
    name: live?.uname?.trim() || streamer.name,
    coverUrl: live?.cover_from_user?.trim() || undefined,
  };
};

export const getVtbDynamics = async (
  streamer: VtbStreamer,
  config: VtbConfig,
  retryCount = 0,
): Promise<VtbDynamicFeed> => {
  const dynamicUrl = `${config.dynamicApiUrl}${encodeURIComponent(streamer.mid)}`;
  const channel = dynamicSchema.parse(xmlParser.parse(await fetchDynamicText(dynamicUrl, retryCount))).rss.channel;
  return {
    avatarUrl: channel.image.url,
    items: channel.item
      .map((item) => {
        const description = cleanDynamicText(String(item.description));
        const dynamicUrl = formatDynamicUrl(item.link);
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
};

export class VtbRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async initialize() {
    await this.prisma.vtbLiveSession.deleteMany({ where: { endedAt: null } });
  }

  async findStreamerByName(name: string): Promise<VtbStreamer | undefined> {
    const streamer = await this.prisma.vtbStreamer.findFirst({ where: { name } });
    return streamer ? fromStoredStreamer(streamer) : undefined;
  }

  async upsertStreamer(streamer: VtbStreamer): Promise<VtbStreamer> {
    const storedStreamer = await this.prisma.vtbStreamer.upsert({
      where: { mid: toMid(streamer.mid) },
      create: { mid: toMid(streamer.mid), name: streamer.name, liveRoom: toOptionalMid(streamer.roomId) },
      update: { name: streamer.name, liveRoom: toOptionalMid(streamer.roomId) },
    });
    return fromStoredStreamer(storedStreamer);
  }

  async getLiveSession(mid: string): Promise<LiveSession | undefined> {
    const session = await this.prisma.vtbLiveSession.findUnique({ where: { streamerMid: toMid(mid) } });
    return session && !session.endedAt
      ? {
          startedAt: session.startedAt,
          startFans: session.startFans ?? undefined,
          roomId: session.liveRoom?.toString(),
        }
      : undefined;
  }

  async startLiveSession(streamer: VtbStreamer, live: VtbLiveInfo, fans?: number) {
    await this.prisma.vtbLiveSession.upsert({
      where: { streamerMid: toMid(streamer.mid) },
      create: {
        streamerMid: toMid(streamer.mid),
        streamerName: live.name,
        liveRoom: toOptionalMid(live.roomId),
        startedAt: live.liveStartedAt ?? new Date(),
        startFans: fans,
      },
      update: {
        streamerName: live.name,
        liveRoom: toOptionalMid(live.roomId),
        startedAt: live.liveStartedAt ?? new Date(),
        startFans: fans,
        endedAt: null,
        endFans: null,
      },
    });
  }

  async stopLiveSession(mid: string, fans?: number) {
    await this.prisma.vtbLiveSession.update({
      where: { streamerMid: toMid(mid) },
      data: { endedAt: new Date(), endFans: fans },
    });
  }

  async getLastDynamicTime(mid: string) {
    return (await this.prisma.vtbDynamicState.findUnique({ where: { streamerMid: toMid(mid) } }))?.lastPublishedAt;
  }

  async setLastDynamicTime(mid: string, publishedAt: Date) {
    await this.prisma.vtbDynamicState.upsert({
      where: { streamerMid: toMid(mid) },
      create: { streamerMid: toMid(mid), lastPublishedAt: publishedAt },
      update: { lastPublishedAt: publishedAt },
    });
  }

  close() {
    return this.prisma.$disconnect();
  }
}

export const formatLiveMessage = (live: VtbLiveInfo, fans?: number) => [
  "╭─「 B站开播提醒 」",
  `│ 主播 · ${live.name}`,
  `│ 标题 · ${live.title}`,
  ...(live.liveStartedAt ? [`│ 开播 · ${dayjs(live.liveStartedAt).format("YYYY-MM-DD HH:mm:ss")}`] : []),
  ...(fans === undefined ? [] : [`│ 粉丝 · ${fans.toLocaleString("zh-CN")}`]),
  ...(live.roomId ? [`│ 直播间 · ${formatLiveRoomUrl(live.roomId)}`] : []),
  "╰────────────",
].join("\n");

export const formatLiveQueryMessage = (live: VtbLiveInfo, fans?: number) => [
  "╭─「 B站直播信息 」",
  `│ 主播 · ${live.name}`,
  `│ 标题 · ${live.title}`,
  ...(live.liveStartedAt ? [`│ 开播 · ${dayjs(live.liveStartedAt).format("YYYY-MM-DD HH:mm:ss")}`] : []),
  ...(fans === undefined ? [] : [`│ 粉丝 · ${fans.toLocaleString("zh-CN")}`]),
  ...(live.roomId ? [`│ 直播间 · ${formatLiveRoomUrl(live.roomId)}`] : []),
  `╰─ 当前状态 · ${live.isLive ? "直播中" : "未开播"}`,
].join("\n");

export const formatOfflineMessage = (
  name: string,
  startedAt: Date,
  startFans?: number,
  endFans?: number,
  roomId?: string,
) => {
  const fanChange = startFans === undefined || endFans === undefined ? undefined : endFans - startFans;
  return [
    "╭─「 B站下播提醒 」",
    `│ 主播 · ${name}`,
    `│ 本次开播 · ${dayjs(startedAt).format("YYYY-MM-DD HH:mm:ss")}`,
    ...(fanChange ? [`│ 粉丝变化 · ${fanChange > 0 ? "+" : ""}${fanChange.toLocaleString("zh-CN")}`] : []),
    ...(roomId ? [`│ 直播间 · ${formatLiveRoomUrl(roomId)}`] : []),
    "╰─ 本场直播已结束",
  ].join("\n");
};

export const formatDynamicMessage = (dynamic: VtbDynamic) => {
  const dynamicUrl = formatDynamicUrl(dynamic.link);
  const hasDynamicUrlInDescription =
    dynamic.containsDynamicUrl ||
    dynamic.description.includes(dynamic.link) ||
    dynamic.description.includes(dynamicUrl);

  return [
    "╭─「 B站动态更新 」",
    `│ 主播 · ${dynamic.author}`,
    `│ 时间 · ${dayjs(dynamic.publishedAt).format("YYYY-MM-DD HH:mm:ss")}`,
    `│ 标题 · ${dynamic.title}`,
    "├─ 内容",
    ...(dynamic.description ? dynamic.description.split("\n").map((line) => `│ ${line}`) : ["│ 暂无文字内容"]),
    ...(hasDynamicUrlInDescription ? [] : [`├─ 动态 · ${dynamicUrl}`]),
    "╰────────────",
  ].join("\n");
};

export const formatLiveRoomUrl = (roomId: string) => `https://live.bilibili.com/${roomId}`;

export const formatDynamicUrl = (link: string) => {
  const dynamicId = /(?:opus|dynamic)\/(\d+)/.exec(link)?.[1] ?? /\/(\d+)(?:\?.*)?$/.exec(link)?.[1];
  return dynamicId ? `https://www.bilibili.com/opus/${dynamicId}` : link;
};

const createVtbRepository = async (config: MizConfig) => {
  const prisma = new PrismaClient({ adapter: new PrismaPg(createDatabaseUrl(config)) });
  const repository = new VtbRepository(prisma);
  await repository.initialize();
  return repository;
};

const createDatabaseUrl = (config: MizConfig) => {
  const host = new URL(config.postgresql.url);
  const port = host.port ? `:${host.port}` : "";
  return `postgresql://${encodeURIComponent(config.postgresql.username)}:${encodeURIComponent(config.postgresql.password)}@${host.hostname}${port}/${encodeURIComponent(config.postgresql.database)}`;
};

const fromStoredStreamer = (streamer: { name: string; mid: bigint; liveRoom: bigint | null }): VtbStreamer => ({
  name: streamer.name,
  mid: streamer.mid.toString(),
  roomId: streamer.liveRoom?.toString(),
});

const toMid = (mid: string) => BigInt(mid);
const toOptionalMid = (value: string | undefined) => (value === undefined ? null : BigInt(value));

const fetchJson = async (url: string, headers?: Record<string, string>, init?: RequestInit) => {
  const response = await fetch(url, {
    ...init,
    headers: {
      "user-agent": "Mozilla/5.0",
      referer: "https://www.bilibili.com/",
      ...(headers ?? {}),
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Vtb API request failed: HTTP ${response.status}`);
  return response.json();
};

const fetchText = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Vtb dynamic API request failed: HTTP ${response.status}`);
  return response.text();
};

const fetchDynamicText = async (url: string, retryCount: number) => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      return await fetchText(url);
    } catch (error) {
      lastError = error;
      if (attempt === retryCount) {
        break;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, DYNAMIC_RETRY_DELAY_MS));
    }
  }

  throw lastError;
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
