import dayjs from "dayjs";
import { XMLParser } from "fast-xml-parser";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Reminder, type ScheduleEvent } from "@/generated/prisma/client";
import { z } from "zod";
import type { MizConfig, VtbConfig } from "@/config";
import { fetchWithRetry } from "@/http";
import { partitionVtbSubscriptionsByGroup } from "@/vtb-subscriptions";

const FETCH_TIMEOUT_MS = 15_000;
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
  data: z.unknown().optional(),
});
const cardSchema = z.looseObject({
  mid: z.union([z.string(), z.number()]),
  fans: z.union([z.string(), z.number()]).optional(),
  name: z.string().min(1).optional(),
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
export type LiveSession = { startedAt: Date; startFans?: number; roomId?: string };
export type VtbCardInfo = { fans?: number; name?: string };
type ReminderClaim = Reminder & { claimedAt: Date; nextRemindAt?: Date };
type ScheduleEventClaim = ScheduleEvent & { claimedAt: Date };

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (_name, jPath) => jPath === "rss.channel.item",
});

let repositoryPromise: Promise<VtbRepository> | undefined;

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
  const response = userResponseSchema.parse(
    await fetchJson(
      `${config.userApiUrl}${encodeURIComponent(name)}`,
      config.bilibiliCookie ? { Cookie: config.bilibiliCookie } : undefined,
    ),
  );
  if (response.code !== 0) {
    throw new Error(`Bilibili user API failed: code ${response.code}`);
  }

  const user = response.data.result.find((item) => item.uname === name);
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
    const live = liveInfos.get(streamer.mid)!;
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
  return (await getVtbCardInfos([mid], config)).get(mid) ?? {};
};

export const getVtbCardInfos = async (mids: readonly string[], config: VtbConfig) => {
  const uniqueMids = Array.from(new Set(mids));
  const cards = new Map<string, VtbCardInfo>();
  for (const batch of chunk(uniqueMids, 50)) {
    const response = cardResponseSchema.parse(
      await fetchJson(
        createCardApiUrl(config.cardApiUrl, batch),
        config.bilibiliCookie ? { Cookie: config.bilibiliCookie } : undefined,
      ),
    );
    if (response.code !== 0) {
      throw new Error(
        response.code === -101
          ? "Bilibili card API rejected the configured cookie: code -101"
          : `Bilibili card API failed: code ${response.code}`,
      );
    }

    for (const rawCard of extractCardRecords(response.data)) {
      const parsedCard = cardSchema.safeParse(rawCard);
      if (!parsedCard.success) {
        continue;
      }

      const fans = Number(parsedCard.data.fans);
      cards.set(String(parsedCard.data.mid), {
        fans: Number.isFinite(fans) ? fans : undefined,
        name: parsedCard.data.name?.trim() || undefined,
      });
    }
  }

  return cards;
};

export const getVtbLiveInfo = async (streamer: VtbStreamer, config: VtbConfig): Promise<VtbLiveInfo> => {
  return (await getVtbLiveInfos([streamer], config)).get(streamer.mid)!;
};

export const getVtbLiveInfos = async (streamers: readonly VtbStreamer[], config: VtbConfig) => {
  const results = new Map<string, VtbLiveInfo>();
  const uniqueStreamers = Array.from(
    new Map(streamers.map((streamer) => [streamer.mid, streamer])).values(),
  );
  for (const batch of chunk(uniqueStreamers, 50)) {
    const response = liveResponseSchema.parse(
      await fetchJson(config.liveApiUrl, config.bilibiliCookie ? { Cookie: config.bilibiliCookie } : undefined, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uids: batch.map((streamer) => streamer.mid) }),
      }),
    );
    if (response.code !== 0) throw new Error(`Bilibili live API failed: code ${response.code}`);

    for (const streamer of batch) {
      results.set(streamer.mid, toVtbLiveInfo(streamer, findLiveInfo(response.data, streamer.mid)));
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

export type VtbRepository = ReturnType<typeof createVtbRepository>;

/** The persistence adapter is a closure over Prisma, not an object with mutable instance state. */
const createVtbRepository = (prisma: PrismaClient) => {
  const initialize = async () => {
    await prisma.vtbLiveSession.deleteMany({ where: { endedAt: null } });
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
    return session && !session.endedAt
      ? {
          startedAt: session.startedAt,
          startFans: session.startFans ?? undefined,
          roomId: session.liveRoom?.toString(),
        }
      : undefined;
  };

  const startLiveSession = async (streamer: VtbStreamer, live: VtbLiveInfo, fans?: number) => {
    await prisma.vtbLiveSession.upsert({
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
  };

  const stopLiveSession = async (mid: string, fans?: number, endedAt = new Date()) => {
    await prisma.vtbLiveSession.update({
      where: { streamerMid: toMid(mid) },
      data: { endedAt, endFans: fans },
    });
  };

  const getLastDynamicTime = async (mid: string) =>
    (await prisma.vtbDynamicState.findUnique({ where: { streamerMid: toMid(mid) } }))?.lastPublishedAt;

  const setLastDynamicTime = async (mid: string, publishedAt: Date) => {
    await prisma.vtbDynamicState.upsert({
      where: { streamerMid: toMid(mid) },
      create: { streamerMid: toMid(mid), lastPublishedAt: publishedAt },
      update: { lastPublishedAt: publishedAt },
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

  const close = () => prisma.$disconnect();

  return {
    initialize, findStreamerByName, listStreamers, deleteStreamersNotInNames, deleteStreamerByName,
    upsertStreamer, getLiveSession, startLiveSession, stopLiveSession, getLastDynamicTime, setLastDynamicTime,
    getDeliveredNewsIds, recordNewsDeliveries, ensureReminderStorage, createReminder, claimDueReminders,
    releaseReminderClaim, listPendingReminders, findPendingReminder, cancelPendingReminder, editPendingReminder,
    ensureScheduleStorage, createScheduleEvent, listUpcomingScheduleEvents, cancelUpcomingScheduleEvent,
    claimDueScheduleEvents, releaseScheduleEventClaim, cleanupFinishedScheduleEvents, close,
  };
};

const getNextReminderTime = (current: Date, intervalMinutes: number, now: Date) => {
  const intervalMs = intervalMinutes * 60_000;
  const elapsedIntervals = Math.floor((now.getTime() - current.getTime()) / intervalMs) + 1;
  return new Date(current.getTime() + Math.max(1, elapsedIntervals) * intervalMs);
};

const formatSyncFailure = (error: unknown) =>
  error instanceof Error ? error.message.replace(/\s+/g, " ").trim().slice(0, 200) : "未知错误";

export const formatLiveMessage = (live: VtbLiveInfo, fans?: number) => [
  "╭─「 B站开播提醒 」",
  `│ 主播 · ${live.name}`,
  `│ 标题 · ${live.title}`,
  ...(live.liveStartedAt ? [`│ 开播 · ${dayjs(live.liveStartedAt).format("YYYY年MM月DD日 HH时mm分")}`] : []),
  ...(fans === undefined ? [] : [`│ 粉丝 · ${fans.toLocaleString("zh-CN")}`]),
  ...(live.roomId ? [`│ 直播间 · ${formatLiveRoomUrl(live.roomId)}`] : []),
  "╰────────────",
].join("\n");

export const formatLiveQueryMessage = (live: VtbLiveInfo, fans?: number) => [
  "╭─「 B站直播信息 」",
  `│ 主播 · ${live.name}`,
  `│ 标题 · ${live.title}`,
  ...(live.liveStartedAt ? [`│ 开播 · ${dayjs(live.liveStartedAt).format("YYYY年MM月DD日 HH时mm分")}`] : []),
  ...(fans === undefined ? [] : [`│ 粉丝 · ${fans.toLocaleString("zh-CN")}`]),
  ...(live.roomId ? [`│ 直播间 · ${formatLiveRoomUrl(live.roomId)}`] : []),
  `╰─ 当前状态 · ${live.isLive ? "直播中" : "未开播"}`,
].join("\n");

export const formatOfflineMessage = (
  name: string,
  startedAt: Date,
  endedAt: Date,
  startFans?: number,
  endFans?: number,
  roomId?: string,
) => {
  const fanChange = startFans === undefined || endFans === undefined ? undefined : endFans - startFans;
  const durationMinutes = Math.max(1, Math.floor((endedAt.getTime() - startedAt.getTime()) / 60_000));
  return [
    "╭─「 B站下播提醒 」",
    `│ ${name} 已下播，辛苦啦～`,
    `│ 下播时间 · ${dayjs(endedAt).format("YYYY年MM月DD日 HH时mm分")}`,
    `│ 直播时长 · ${durationMinutes.toLocaleString("zh-CN")} 分钟`,
    ...(fanChange && fanChange > 0 ? [`│ 本场收获新粉丝 · +${fanChange.toLocaleString("zh-CN")}`] : []),
    ...(roomId ? [`│ 直播间 · ${formatLiveRoomUrl(roomId)}`] : []),
    "╰─ 下次直播见～",
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
    `│ 时间 · ${dayjs(dynamic.publishedAt).format("YYYY年MM月DD日 HH时mm分")}`,
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

const createConfiguredVtbRepository = async (config: MizConfig) => {
  const prisma = new PrismaClient({ adapter: new PrismaPg(getDatabaseUrl(config)) });
  const repository = createVtbRepository(prisma);
  await repository.initialize();
  return repository;
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
  roomId: streamer.liveRoom?.toString(),
});

const toMid = (mid: string) => BigInt(mid);
const toOptionalMid = (value: string | undefined) => (value === undefined ? null : BigInt(value));

const fetchJson = async (url: string, headers?: Record<string, string>, init?: RequestInit) => {
  const response = await fetchWithRetry(url, {
    ...init,
    headers: {
      "user-agent": "Mozilla/5.0",
      referer: "https://www.bilibili.com/",
      ...(headers ?? {}),
      ...(init?.headers ?? {}),
    },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  return response.json();
};

const fetchText = async (url: string) => {
  const response = await fetchWithRetry(url, { timeoutMs: FETCH_TIMEOUT_MS });
  return response.text();
};

const fetchDynamicText = async (url: string, _retryCount: number) => fetchText(url);

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
  title: live?.title?.trim() || "暂无直播标题",
  roomId: live?.room_id === undefined ? streamer.roomId : String(live.room_id),
  liveStartedAt: parseDate(live?.live_time),
  isLive: live?.live_status === 1,
  name: live?.uname?.trim() || streamer.name,
  coverUrl: live?.cover_from_user?.trim() || undefined,
});

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
