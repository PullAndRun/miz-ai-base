import cron from "node-cron";
import dayjs from "dayjs";
import { updateVtbSubscriptionNames, type MizConfig } from "@/config";
import type { Gateway } from "@/gateway";
import type { Logger } from "@/logger";
import {
  FF14_REGION_NAMES,
  formatFf14MarketMessages,
  getLowestMarketPrice,
  queryFf14Market,
} from "@/ff14";
import { createWallpaperMessage, getDailyWallpaper } from "@/wallpaper";
import { settleWithConcurrency, startWithConcurrency } from "@/concurrency";
import { getGroupIds } from "@/group-ids";
import { deliverUnsentNews, fetchFinanceNews, formatScheduledNewsItems } from "@/news";
import { updateYtDlp } from "@/video";
import {
  closeVtbRepository,
  formatDynamicMessage,
  formatLiveMessage,
  formatOfflineMessage,
  getVtbRepository,
  getVtbCardInfos,
  getVtbDynamics,
  getVtbLiveInfos,
  resolveTrackedVtbStreamer,
  syncVtbSubscriptionNames,
  type VtbDynamicFeed,
  type VtbLiveInfo,
  type VtbStreamer,
} from "@/vtb";

export type TaskRuntime = {
  stop(): Promise<void>;
};

export const startScheduledTasks = async (
  config: MizConfig,
  gateway: Gateway,
  logger: Logger,
): Promise<TaskRuntime> => {
  const startedTasks: TaskRuntime[] = [];
  try {
    startedTasks.push(startFf14PriceAlertTask(config, gateway, logger));
    startedTasks.push(startWallpaperTask(config, gateway, logger));
    startedTasks.push(startNewsTask(config, gateway, logger));
    startedTasks.push(await startReminderTask(config, gateway, logger));
    startedTasks.push(await startScheduleTask(config, gateway, logger));
    startedTasks.push(startYtDlpUpdateTask(config, logger));
    startedTasks.push(startVtbNameSyncTask(config, logger));
    startedTasks.push(await startVtbTask(config, gateway, logger));
    return { stop: () => stopTasks(startedTasks) };
  } catch (error) {
    await stopTasks(startedTasks);
    throw error;
  }
};

const stopTasks = async (tasks: readonly TaskRuntime[]) => {
  let failure: unknown;
  for (const task of tasks) {
    try {
      await task.stop();
    } catch (error) {
      failure ??= error;
    }
  }

  if (failure) {
    throw failure;
  }
};

const startScheduleTask = async (config: MizConfig, gateway: Gateway, logger: Logger): Promise<TaskRuntime> => {
  if (!config.schedule.enabled) {
    logger.info("plugin", "schedule task disabled: config switch is off");
    return createNoopTask();
  }

  const cronExpression = config.schedule.cron;
  if (!cron.validate(cronExpression)) {
    logger.warn("plugin", "schedule task disabled: invalid cron expression", { cronExpression });
    return createNoopTask();
  }

  let repository;
  try {
    repository = await getVtbRepository(config);
    await repository.ensureScheduleStorage();
  } catch (error) {
    logger.error("plugin", "schedule task disabled: database initialization failed", error);
    return createNoopTask();
  }

  let running = false;
  let currentRun: Promise<void> | undefined;
  const runTask = async () => {
    if (running) {
      logger.warn("plugin", "schedule task skipped: previous run is still active");
      return;
    }

    running = true;
    try {
      const events = await repository.claimDueScheduleEvents(new Date(), config.schedule.batchSize);
      for (const event of events) {
        try {
          await gateway.sendGroupMessage(event.groupId, [
            { type: "at", data: { qq: event.creatorId } },
            {
              type: "text",
              data: {
                text: ` 群日程提醒：${event.content}\n开始时间：${dayjs(event.eventAt).format("YYYY年MM月DD日 HH时mm分")}`,
              },
            },
          ]);
          logger.info("plugin", "schedule reminder sent", { displayId: event.displayId, groupId: event.groupId });
        } catch (error) {
          try {
            await repository.releaseScheduleEventClaim(event);
          } catch (releaseError) {
            logger.error("plugin", "schedule reminder claim could not be released", {
              displayId: event.displayId,
              groupId: event.groupId,
              error: normalizeError(releaseError),
            });
          }
          logger.error("plugin", "schedule reminder delivery failed after claiming", {
            displayId: event.displayId,
            groupId: event.groupId,
            error: normalizeError(error),
          });
        }
      }

      await repository.cleanupFinishedScheduleEvents();
    } finally {
      running = false;
    }
  };

  const task = cron.schedule(cronExpression, () => {
    const wasRunning = running;
    const run = runTask();
    if (!wasRunning) {
      currentRun = run;
    }
    void run.catch((error) => logger.error("plugin", "schedule task failed", error));
  });
  logger.info("plugin", "schedule task started", { cronExpression, reminderMinutes: config.schedule.reminderMinutes });
  return {
    stop: async () => {
      task.stop();
      await currentRun?.catch((error) => logger.warn("plugin", "schedule task ended with an error during shutdown", error));
    },
  };
};

const startReminderTask = async (config: MizConfig, gateway: Gateway, logger: Logger): Promise<TaskRuntime> => {
  if (!config.reminder.enabled) {
    logger.info("plugin", "reminder task disabled: config switch is off");
    return createNoopTask();
  }

  const cronExpression = config.reminder.cron;
  if (!cron.validate(cronExpression)) {
    logger.warn("plugin", "reminder task disabled: invalid cron expression", { cronExpression });
    return createNoopTask();
  }

  let repository;
  try {
    repository = await getVtbRepository(config);
    await repository.ensureReminderStorage();
  } catch (error) {
    logger.error("plugin", "reminder task disabled: database initialization failed", error);
    return createNoopTask();
  }

  let running = false;
  let currentRun: Promise<void> | undefined;
  const runTask = async () => {
    if (running) {
      logger.warn("plugin", "reminder task skipped: previous run is still active");
      return;
    }

    running = true;
    try {
      const reminders = await repository.claimDueReminders(new Date(), config.reminder.batchSize);
      for (const reminder of reminders) {
        try {
          await gateway.sendGroupMessage(reminder.groupId, [
            { type: "at", data: { qq: reminder.targetId } },
            { type: "text", data: { text: ` 提醒：${reminder.content}` } },
          ]);
          logger.info("plugin", "reminder sent", { id: reminder.id, groupId: reminder.groupId });
        } catch (error) {
          try {
            await repository.releaseReminderClaim(reminder);
          } catch (releaseError) {
            logger.error("plugin", "reminder claim could not be released", {
              id: reminder.id,
              groupId: reminder.groupId,
              error: normalizeError(releaseError),
            });
          }
          logger.error("plugin", "reminder delivery failed after claiming", {
            id: reminder.id,
            groupId: reminder.groupId,
            error: normalizeError(error),
          });
        }
      }
    } finally {
      running = false;
    }
  };

  const task = cron.schedule(cronExpression, () => {
    const wasRunning = running;
    const run = runTask();
    if (!wasRunning) {
      currentRun = run;
    }
    void run.catch((error) => logger.error("plugin", "reminder task failed", error));
  });
  logger.info("plugin", "reminder task started", { cronExpression });
  return {
    stop: async () => {
      task.stop();
      await currentRun?.catch((error) => logger.warn("plugin", "reminder task ended with an error during shutdown", error));
    },
  };
};

const startVtbNameSyncTask = (config: MizConfig, logger: Logger): TaskRuntime => {
  if (!config.vtb.enabled || config.vtb.subscriptions.length === 0) {
    return createNoopTask();
  }

  if (!hasVtbApiEndpoints(config.vtb)) {
    logger.warn("plugin", "vtb name sync task disabled: required API URLs are missing");
    return createNoopTask();
  }

  const cronExpression = config.vtb.nameSyncCron;
  if (!cron.validate(cronExpression)) {
    logger.warn("plugin", "vtb name sync task disabled: invalid cron expression", { cronExpression });
    return createNoopTask();
  }

  let running = false;
  let currentRun: Promise<void> | undefined;
  const runTask = async () => {
    if (running) {
      logger.warn("plugin", "vtb name sync task skipped: previous run is still active");
      return;
    }

    running = true;
    try {
      const { databaseSync, renamed, roomUpdated, failed } = await syncVtbSubscriptionNames(config);
      if (databaseSync.removed.length > 0) {
        logger.info("plugin", "vtb streamers removed because they are absent from subscription config", {
          streamers: databaseSync.removed,
        });
      }
      if (renamed.length > 0) {
        await updateVtbSubscriptionNames(new Map(renamed.map((item) => [item.previousName, item.name])));
        // Config persistence triggers a reload; the active snapshot stays immutable.
        logger.info("plugin", "vtb subscription names updated", { renamed });
      }
      if (roomUpdated.length > 0) {
        logger.info("plugin", "vtb live room IDs updated", { roomUpdated });
      }
      if (failed.length > 0) {
        logger.warn("plugin", "vtb name sync skipped some streamers", { streamers: failed });
      }
    } finally {
      running = false;
    }
  };

  const task = cron.schedule(cronExpression, () => {
    const wasRunning = running;
    const run = runTask();
    if (!wasRunning) {
      currentRun = run;
    }
    void run.catch((error) => logger.error("plugin", "vtb name sync task failed", error));
  });
  logger.info("plugin", "vtb name sync task started", { cronExpression });
  return {
    stop: async () => {
      task.stop();
      await currentRun?.catch((error) => logger.warn("plugin", "vtb name sync task ended with an error during shutdown", error));
    },
  };
};

const startVtbTask = async (config: MizConfig, gateway: Gateway, logger: Logger): Promise<TaskRuntime> => {
  if (!config.vtb.enabled) {
    logger.info("plugin", "vtb task disabled: config switch is off");
    return createNoopTask();
  }

  if (config.vtb.subscriptions.length === 0) {
    logger.info("plugin", "vtb task disabled: no configured subscriptions");
    return createNoopTask();
  }

  if (!hasVtbApiEndpoints(config.vtb)) {
    logger.warn("plugin", "vtb task disabled: required API URLs are missing");
    return createNoopTask();
  }

  const cronExpression = config.vtb.cron;
  if (!cron.validate(cronExpression)) {
    logger.warn("plugin", "vtb task disabled: invalid cron expression", { cronExpression });
    return createNoopTask();
  }

  let repository;
  try {
    repository = await getVtbRepository(config);
  } catch (error) {
    logger.error("plugin", "vtb task disabled: database initialization failed", error);
    return createNoopTask();
  }

  let running = false;
  let currentRun: Promise<void> | undefined;
  const runTask = async () => {
    if (running) {
      return;
    }

    running = true;
    currentRun = pollVtbSubscriptions(config, gateway, logger, repository).finally(() => {
      running = false;
    });
    await currentRun;
  };

  const task = cron.schedule(cronExpression, () => {
    void runTask().catch((error) => logger.error("plugin", "vtb task failed", error));
  });

  logger.info("plugin", "vtb task started", {
    cronExpression,
    subscriptions: config.vtb.subscriptions.length,
  });

  return {
    stop: async () => {
      task.stop();
      await currentRun?.catch((error) => {
        logger.warn("plugin", "vtb task ended with an error during shutdown", normalizeError(error));
      });
      await closeVtbRepository();
    },
  };
};

const pollVtbSubscriptions = async (
  config: MizConfig,
  gateway: Gateway,
  logger: Logger,
  repository: Awaited<ReturnType<typeof getVtbRepository>>,
) => {
  const streamerGroups = new Map<string, Map<string, { groupId: string | number; atAll: boolean }>>();
  for (const subscription of config.vtb.subscriptions) {
    for (const streamer of subscription.streamers) {
      const groups = streamerGroups.get(streamer) ?? new Map<string, { groupId: string | number; atAll: boolean }>();
      const groupKey = String(subscription.groupId);
      const existing = groups.get(groupKey);
      groups.set(groupKey, {
        groupId: existing?.groupId ?? subscription.groupId,
        atAll: existing?.atAll === true || subscription.atAllStreamers?.includes(streamer) === true,
      });
      streamerGroups.set(streamer, groups);
    }
  }

  const pushCache = new Map<
    string,
    Promise<{
      streamer: VtbStreamer;
      live: VtbLiveInfo;
      fans?: number;
    }>
  >();

  try {
    const resolvedSubscriptions: Array<{
      streamerName: string;
      groups: Map<string, { groupId: string | number; atAll: boolean }>;
      streamer: VtbStreamer;
    }> = [];
    for (const [streamerName, groups] of streamerGroups) {
      try {
        const streamer = await resolveTrackedVtbStreamer(streamerName, config.vtb, repository);
        if (!streamer) {
          logger.warn("plugin", "vtb streamer not found", { streamerName });
          continue;
        }
        resolvedSubscriptions.push({ streamerName, groups, streamer });
      } catch (error) {
        logger.error("plugin", "vtb subscription resolution failed", { streamerName, error: normalizeError(error) });
      }
    }

    let cardInfos = new Map<string, { fans?: number }>();
    try {
      cardInfos = await getVtbCardInfos(
        resolvedSubscriptions.map((subscription) => subscription.streamer.mid),
        config.vtb,
      );
    } catch (error) {
      logger.warn("plugin", "vtb batch card request failed; fan counts will be omitted", normalizeError(error));
    }

    let liveInfos: Map<string, VtbLiveInfo>;
    try {
      liveInfos = await getVtbLiveInfos(
        resolvedSubscriptions.map((subscription) => subscription.streamer),
        config.vtb,
      );
    } catch (error) {
      logger.error("plugin", "vtb batch live request failed", normalizeError(error));
      return;
    }

    // Start dynamic queries together instead of waiting for each streamer in
    // sequence. This prevents retry delays from stretching a poll past the
    // next scheduled run, while each streamer is still requested only once.
    const uniqueDynamicSubscriptions = Array.from(
      new Map(resolvedSubscriptions.map((subscription) => [subscription.streamer.mid, subscription])).values(),
    );
    const dynamicTasks = startWithConcurrency(uniqueDynamicSubscriptions, 8, async (subscription) => {
      try {
        return await getVtbDynamics(subscription.streamer, config.vtb);
      } catch {
        // Dynamic feeds are optional. Network failures, including HTTP 503,
        // must not interrupt live polling or create noisy periodic warnings.
        return undefined;
      }
    });
    const dynamicFeeds = new Map(
      uniqueDynamicSubscriptions.map((subscription, index) => [subscription.streamer.mid, dynamicTasks[index]]),
    );

    for (const { streamerName, groups, streamer } of resolvedSubscriptions) {
      try {
        const groupIds = [...groups.values()].map((group) => group.groupId);
        const atAllGroupIds = new Set(
          [...groups.entries()]
            .filter(([, group]) => group.atAll)
            .map(([groupId]) => groupId),
        );
        const cachedPush =
          pushCache.get(streamer.mid) ??
          Promise.all([
            Promise.resolve(liveInfos.get(streamer.mid)!),
            Promise.resolve(cardInfos.get(streamer.mid)?.fans),
          ]).then(([live, fans]) => ({
            streamer,
            live,
            fans,
          }));
        pushCache.set(streamer.mid, cachedPush);
        const { live, fans } = await cachedPush;
      const session = await repository.getLiveSession(streamer.mid);
      const isRecentLive =
        live.liveStartedAt !== undefined &&
        Date.now() - live.liveStartedAt.getTime() < getVtbPollingIntervalMs(config.vtb.cron);
      if (live.isLive && !session && isRecentLive) {
        await repository.startLiveSession(streamer, live, fans);
        const message = [
          { type: "text", data: { text: formatLiveMessage(live, fans) } },
          ...(live.coverUrl ? [{ type: "image", data: { file: live.coverUrl } }] : []),
        ];
        const deliveredGroups = await sendVtbGroupMessage(
          groupIds,
          message,
          gateway,
          logger,
          "live start",
          live.name,
          atAllGroupIds,
        );
        logger.info("plugin", "vtb live started notification sent", { streamer: live.name, groupIds: deliveredGroups });
      } else if (live.isLive && !session) {
        logger.info("plugin", "vtb live start notification skipped: live is older than polling interval", {
          streamer: live.name,
          liveStartedAt: live.liveStartedAt,
        });
      } else if (!live.isLive && session) {
        const endedAt = new Date();
        await repository.stopLiveSession(streamer.mid, fans, endedAt);
        const message = formatOfflineMessage(
          live.name,
          session.startedAt,
          endedAt,
          session.startFans,
          fans,
          session.roomId,
        );
        const deliveredGroups = await sendVtbGroupMessage(groupIds, message, gateway, logger, "live end", live.name);
        logger.info("plugin", "vtb live ended notification sent", { streamer: live.name, groupIds: deliveredGroups });
      }

        const feed = await dynamicFeeds.get(streamer.mid);
        if (!feed) {
          continue;
        }
          const latestDynamic = feed.items[0];
          if (!latestDynamic) {
            logger.warn("plugin", "vtb dynamic poll skipped: feed contains no valid dated item", {
              streamer: streamer.name,
            });
            continue;
          }
          const lastPublishedAt = await repository.getLastDynamicTime(streamer.mid);
          const isUnseen = !lastPublishedAt || latestDynamic.publishedAt > lastPublishedAt;
          const isRecent = Date.now() - latestDynamic.publishedAt.getTime() < getVtbPollingIntervalMs(config.vtb.cron);
          const isLivePromotion = latestDynamic.description.includes("https://live.bilibili.com");

          if (isUnseen && isRecent && !isLivePromotion) {
            const message = [
              { type: "text", data: { text: formatDynamicMessage(latestDynamic) } },
              ...(feed.avatarUrl ? [{ type: "image", data: { file: feed.avatarUrl } }] : []),
            ];
            const deliveredGroups = await sendVtbGroupMessage(groupIds, message, gateway, logger, "dynamic", streamer.name);
            await repository.setLastDynamicTime(streamer.mid, latestDynamic.publishedAt);
            logger.info("plugin", "vtb dynamic notification sent", {
              streamer: streamer.name,
              groupIds: deliveredGroups,
              dynamics: 1,
            });
          } else if (isUnseen) {
            // Mark stale and live-promotion dynamics as seen so they are never retried.
            await repository.setLastDynamicTime(streamer.mid, latestDynamic.publishedAt);
            if (isLivePromotion) {
              logger.info("plugin", "vtb dynamic notification skipped: live promotion", {
                streamer: streamer.name,
              });
            }
          }
      } catch (error) {
        logger.error("plugin", "vtb subscription poll failed", { streamerName, error: normalizeError(error) });
      }
    }
  } finally {
    pushCache.clear();
  }
};

const sendVtbGroupMessage = async (
  groupIds: readonly (string | number)[],
  message: unknown,
  gateway: Gateway,
  logger: Logger,
  kind: "live start" | "live end" | "dynamic",
  streamer: string,
  atAllGroupIds: ReadonlySet<string> = new Set(),
) => {
  const results = await settleWithConcurrency(
    groupIds,
    5,
    async (groupId) => {
      const shouldMentionAll =
        atAllGroupIds.has(String(groupId)) && await gateway.canMentionAllGroupMembers(groupId);
      return gateway.sendGroupMessage(groupId, shouldMentionAll ? appendAtAllMention(message) : message);
    },
  );
  const deliveredGroups: Array<string | number> = [];
  for (const [index, result] of results.entries()) {
    const groupId = groupIds[index];
    if (result.status === "fulfilled") {
      deliveredGroups.push(groupId);
      continue;
    }

    logger.error("plugin", "vtb notification delivery failed", {
      kind,
      streamer,
      groupId,
      error: normalizeError(result.reason),
    });
  }
  return deliveredGroups;
};

const appendAtAllMention = (message: unknown) => Array.isArray(message)
  ? [
      ...message,
      { type: "text", data: { text: "\n\n「开播集合」" } },
      { type: "at", data: { qq: "all" } },
      { type: "text", data: { text: " 舞台灯光已经亮起，快来用弹幕为 TA 的开场应援吧！" } },
    ]
  : message;

const getVtbPollingIntervalMs = (cronExpression: string) => {
  const minuteInterval = /^\*\/(\d+) \* \* \* \*$/.exec(cronExpression)?.[1];
  return Math.max(1, minuteInterval ? Number(minuteInterval) : 3) * 60_000;
};

const startYtDlpUpdateTask = (config: MizConfig, logger: Logger): TaskRuntime => {
  if (!config.video.enabled) {
    logger.info("plugin", "yt-dlp update task disabled: video plugin is off");
    return createNoopTask();
  }

  const cronExpression = config.video.updateCron;
  if (!cron.validate(cronExpression)) {
    logger.warn("plugin", "yt-dlp update task disabled: invalid cron expression", {
      cronExpression,
    });
    return createNoopTask();
  }

  let running = false;
  const runTask = async () => {
    if (running) {
      logger.warn("plugin", "yt-dlp update task skipped: previous run is still active");
      return;
    }

    running = true;
    try {
      await updateYtDlp(config.video);
      logger.info("plugin", "yt-dlp updated");
    } finally {
      running = false;
    }
  };

  const task = cron.schedule(cronExpression, () => {
    void runTask().catch((error) => logger.error("plugin", "yt-dlp update failed", error));
  });

  logger.info("plugin", "yt-dlp update task started", { cronExpression });
  return { stop: async () => task.stop() };
};

const startNewsTask = (config: MizConfig, gateway: Gateway, logger: Logger): TaskRuntime => {
  if (!config.news.enabled) {
    logger.info("plugin", "news task disabled: config switch is off");
    return createNoopTask();
  }

  if (config.news.groupIds.length === 0) {
    logger.info("plugin", "news task disabled: no configured groups");
    return createNoopTask();
  }

  if (!config.news.apiUrl) {
    logger.warn("plugin", "news task disabled: API URL is missing");
    return createNoopTask();
  }

  const cronExpression = config.news.cron;
  if (!cron.validate(cronExpression)) {
    logger.warn("plugin", "news task disabled: invalid cron expression", { cronExpression });
    return createNoopTask();
  }

  let running = false;
  const runTask = async () => {
    if (running) {
      logger.warn("plugin", "news task skipped: previous run is still active");
      return;
    }

    running = true;
    try {
      await pushNewsToConfiguredGroups(config, gateway, logger);
    } finally {
      running = false;
    }
  };

  const task = cron.schedule(cronExpression, () => {
    void runTask().catch((error) => logger.error("plugin", "news task failed", error));
  });

  logger.info("plugin", "news task started", {
    cronExpression,
    groups: config.news.groupIds.length,
  });

  return { stop: async () => task.stop() };
};

const pushNewsToConfiguredGroups = async (
  config: MizConfig,
  gateway: Gateway,
  logger: Logger,
) => {
  const latestNews = await fetchFinanceNews(config.news.apiUrl);
  const groupIds = Array.from(
    new Map(config.news.groupIds.map((groupId) => [String(groupId), groupId])).values(),
  );
  const results = await settleWithConcurrency(groupIds, 5, async (groupId) => {
    const news = await deliverUnsentNews(
      config,
      config.news.apiUrl,
      `group:${groupId}`,
      async (items) => {
        await gateway.sendGroupMessage(groupId, formatScheduledNewsItems(items).join("\n\n"));
      },
      latestNews,
    );
    return news.length;
  });
  const sentCounts = results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }

    logger.error("plugin", "news delivery failed", {
      groupId: groupIds[index],
      error: normalizeError(result.reason),
    });
    return 0;
  });
  const sentNewsCount = sentCounts.reduce((total, count) => total + count, 0);

  if (sentNewsCount === 0) {
    logger.info("plugin", "news task found no updates", { groups: groupIds.length });
    return;
  }

  logger.info("plugin", "news task sent updates", {
    groups: groupIds.length,
    news: sentNewsCount,
  });
};

const startWallpaperTask = (
  config: MizConfig,
  gateway: Gateway,
  logger: Logger,
): TaskRuntime => {
  if (!config.wallpaper.enabled) {
    logger.info("plugin", "wallpaper task disabled: config switch is off");
    return createNoopTask();
  }

  if (!config.wallpaper.apiUrl || !config.wallpaper.imageBaseUrl) {
    logger.warn("plugin", "wallpaper task disabled: API URL or image base URL is missing");
    return createNoopTask();
  }

  const cronExpression = config.wallpaper.cron;
  if (!cron.validate(cronExpression)) {
    logger.warn("plugin", "wallpaper task disabled: invalid cron expression", {
      cronExpression,
    });
    return createNoopTask();
  }

  let running = false;
  const runTask = async () => {
    if (running) {
      logger.warn("plugin", "wallpaper task skipped: previous run is still active");
      return;
    }

    running = true;
    try {
      await sendDailyWallpaper(config, gateway, logger);
    } finally {
      running = false;
    }
  };

  const task = cron.schedule(cronExpression, () => {
    void runTask().catch((error) => {
      logger.error("plugin", "wallpaper task failed", error);
    });
  });

  logger.info("plugin", "wallpaper task started", { cronExpression });

  return {
    stop: async () => {
      task.stop();
    },
  };
};

const sendDailyWallpaper = async (config: MizConfig, gateway: Gateway, logger: Logger) => {
  const wallpaper = await getDailyWallpaper(
    config.wallpaper.apiUrl,
    config.wallpaper.imageBaseUrl,
  );
  const groupIds = getGroupIds(await gateway.getGroupList());

  if (groupIds.length === 0) {
    logger.warn("plugin", "wallpaper task skipped: no groups found");
    return;
  }

  for (const [index, groupId] of groupIds.entries()) {
    if (index > 0) {
      await wait(2_000);
    }

    try {
      await gateway.sendGroupMessage(groupId, createWallpaperMessage(wallpaper));
      logger.info("plugin", "daily wallpaper sent", { groupId, wallpaperId: wallpaper.id });
    } catch (error) {
      logger.error("plugin", "daily wallpaper delivery failed", {
        groupId,
        error: normalizeError(error),
      });
    }
  }
};

const startFf14PriceAlertTask = (
  config: MizConfig,
  gateway: Gateway,
  logger: Logger,
): TaskRuntime => {
  if (!config.ff14.priceAlertEnabled) {
    logger.info("plugin", "ff14 price alert task disabled: config switch is off");
    return createNoopTask();
  }

  const alerts = config.ff14.priceAlerts;
  if (alerts.length === 0) {
    logger.info("plugin", "ff14 price alert task disabled: no configured alerts");
    return createNoopTask();
  }

  if (!config.ff14.itemSearchApiUrl || !config.ff14.marketApiUrl) {
    logger.warn("plugin", "ff14 price alert task disabled: required API URLs are missing");
    return createNoopTask();
  }

  const cronExpression = config.ff14.priceAlertCron;
  if (!cron.validate(cronExpression)) {
    logger.warn("plugin", "ff14 price alert task disabled: invalid cron expression", {
      cronExpression,
    });
    return createNoopTask();
  }

  let running = false;
  const runTask = async () => {
    if (running) {
      logger.warn("plugin", "ff14 price alert task skipped: previous run is still active");
      return;
    }

    running = true;
    try {
      await runFf14PriceAlerts(config, gateway, logger);
    } finally {
      running = false;
    }
  };

  const task = cron.schedule(cronExpression, () => {
    void runTask().catch((error) => {
      logger.error("plugin", "ff14 price alert task failed", error);
    });
  });

  logger.info("plugin", "ff14 price alert task started", {
    cronExpression,
    alerts: alerts.length,
  });

  return {
    stop: async () => {
      task.stop();
    },
  };
};

const runFf14PriceAlerts = async (
  config: MizConfig,
  gateway: Gateway,
  logger: Logger,
) => {
  for (const alert of config.ff14.priceAlerts) {
    try {
      const result = await queryFf14Market({
        regionKey: alert.region,
        itemName: alert.itemName,
        itemSearchApiUrl: config.ff14.itemSearchApiUrl,
        marketApiUrl: config.ff14.marketApiUrl,
      });

      if (!result) {
        logger.warn("plugin", "ff14 price alert item not found", alert);
        continue;
      }

      const lowestPrice = getLowestMarketPrice(result.market);
      if (lowestPrice === undefined) {
        logger.warn("plugin", "ff14 price alert skipped: no market price", alert);
        continue;
      }

      if (lowestPrice > alert.minimumPrice) {
        logger.info("plugin", "ff14 price alert skipped: price above threshold", {
          ...alert,
          lowestPrice,
        });
        continue;
      }

      await gateway.sendForwardMessage(
        {
          text: "",
          groupId: alert.groupId,
          raw: {},
        },
        formatFf14MarketMessages({
          ...result,
          maxListingCount: config.ff14.maxListingCount,
          minimumPrice: alert.minimumPrice,
        }),
        {
          title: `FF14 价格提醒: ${result.item.Name}`,
          source: "miz ff14",
          summary: `${FF14_REGION_NAMES[alert.region]} / ${result.item.Name} <= ${alert.minimumPrice}`,
        },
      );

      logger.info("plugin", "ff14 price alert sent", {
        ...alert,
        lowestPrice,
      });
    } catch (error) {
      logger.error("plugin", "ff14 price alert failed", {
        alert,
        error: normalizeError(error),
      });
    }
  }
};

const createNoopTask = (): TaskRuntime => ({
  stop: async () => {},
});

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const hasVtbApiEndpoints = (config: MizConfig["vtb"]) =>
  Boolean(config.userApiUrl && config.cardApiUrl && config.liveApiUrl && config.dynamicApiUrl);

const normalizeError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return error;
};
