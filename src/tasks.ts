import cron from "node-cron";
import type { MizConfig } from "@/config";
import type { Gateway } from "@/gateway";
import type { Logger } from "@/logger";
import {
  FF14_REGION_NAMES,
  formatFf14MarketMessages,
  getLowestMarketPrice,
  queryFf14Market,
} from "@/ff14";
import { createWallpaperMessage, getDailyWallpaper } from "@/wallpaper";
import { deliverUnsentNews, formatScheduledNewsItems } from "@/news";
import { updateYtDlp } from "@/video";
import {
  closeVtbRepository,
  formatDynamicMessage,
  formatLiveMessage,
  formatOfflineMessage,
  getVtbRepository,
  getVtbDynamics,
  getVtbFanCount,
  getVtbLiveInfo,
  resolveTrackedVtbStreamer,
  type VtbDynamicFeed,
  type VtbLiveInfo,
  type VtbStreamer,
} from "@/vtb";

export type TaskRuntime = {
  stop(): void;
};

export const startScheduledTasks = async (
  config: MizConfig,
  gateway: Gateway,
  logger: Logger,
): Promise<TaskRuntime> => {
  const ff14Task = startFf14PriceAlertTask(config, gateway, logger);
  const wallpaperTask = startWallpaperTask(config, gateway, logger);
  const newsTask = startNewsTask(config, gateway, logger);
  const ytDlpUpdateTask = startYtDlpUpdateTask(config, logger);
  const vtbTask = await startVtbTask(config, gateway, logger);

  return {
    stop: () => {
      ff14Task.stop();
      wallpaperTask.stop();
      newsTask.stop();
      ytDlpUpdateTask.stop();
      vtbTask.stop();
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
  const runTask = async () => {
    if (running) {
      logger.warn("plugin", "vtb task skipped: previous run is still active");
      return;
    }

    running = true;
    try {
      await pollVtbSubscriptions(config, gateway, logger, repository);
    } finally {
      running = false;
    }
  };

  const task = cron.schedule(cronExpression, () => {
    void runTask().catch((error) => logger.error("plugin", "vtb task failed", error));
  });

  logger.info("plugin", "vtb task started", {
    cronExpression,
    subscriptions: config.vtb.subscriptions.length,
  });

  return {
    stop: () => {
      task.stop();
      void closeVtbRepository();
    },
  };
};

const pollVtbSubscriptions = async (
  config: MizConfig,
  gateway: Gateway,
  logger: Logger,
  repository: Awaited<ReturnType<typeof getVtbRepository>>,
) => {
  const streamerGroups = new Map<string, Set<string | number>>();
  for (const subscription of config.vtb.subscriptions) {
    for (const streamer of subscription.streamers) {
      const groups = streamerGroups.get(streamer) ?? new Set<string | number>();
      groups.add(subscription.groupId);
      streamerGroups.set(streamer, groups);
    }
  }

  const pushCache = new Map<
    string,
    Promise<{
      streamer: VtbStreamer;
      live: VtbLiveInfo;
      fans?: number;
      dynamicFeed: Promise<VtbDynamicFeed>;
    }>
  >();

  try {
    for (const [streamerName, groups] of streamerGroups) {
      try {
        const streamer = await resolveTrackedVtbStreamer(streamerName, config.vtb, repository);
      if (!streamer) {
        logger.warn("plugin", "vtb streamer not found", { streamerName });
        continue;
      }

      const groupIds = [...groups];
        const cachedPush =
          pushCache.get(streamer.mid) ??
          Promise.all([
            getVtbLiveInfo(streamer, config.vtb),
            getVtbFanCount(streamer.mid, config.vtb).catch(() => undefined),
          ]).then(([live, fans]) => ({
            streamer,
            live,
            fans,
            dynamicFeed: getVtbDynamics(streamer, config.vtb, 5),
          }));
        pushCache.set(streamer.mid, cachedPush);
        const { live, fans, dynamicFeed } = await cachedPush;
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
        await Promise.all(groupIds.map((groupId) => gateway.sendGroupMessage(groupId, message)));
        logger.info("plugin", "vtb live started notification sent", { streamer: live.name, groupIds });
      } else if (live.isLive && !session) {
        logger.info("plugin", "vtb live start notification skipped: live is older than polling interval", {
          streamer: live.name,
          liveStartedAt: live.liveStartedAt,
        });
      } else if (!live.isLive && session) {
        await repository.stopLiveSession(streamer.mid, fans);
        const message = formatOfflineMessage(
          live.name,
          session.startedAt,
          session.startFans,
          fans,
          session.roomId,
        );
        await Promise.all(groupIds.map((groupId) => gateway.sendGroupMessage(groupId, message)));
        logger.info("plugin", "vtb live ended notification sent", { streamer: live.name, groupIds });
      }

        try {
          const feed = await dynamicFeed;
          const latestDynamic = feed.items[0];
          const lastPublishedAt = await repository.getLastDynamicTime(streamer.mid);
          const isUnseen = !lastPublishedAt || latestDynamic.publishedAt > lastPublishedAt;
          const isRecent = Date.now() - latestDynamic.publishedAt.getTime() < getVtbPollingIntervalMs(config.vtb.cron);

          if (isUnseen && isRecent) {
            const message = [
              { type: "text", data: { text: formatDynamicMessage(latestDynamic) } },
              ...(feed.avatarUrl ? [{ type: "image", data: { file: feed.avatarUrl } }] : []),
            ];
            await Promise.all(groupIds.map((groupId) => gateway.sendGroupMessage(groupId, message)));
            await repository.setLastDynamicTime(streamer.mid, latestDynamic.publishedAt);
            logger.info("plugin", "vtb dynamic notification sent", {
              streamer: streamer.name,
              groupIds,
              dynamics: 1,
            });
          } else if (isUnseen) {
            // Mark stale dynamics as seen so a restarted service never backfills old posts.
            await repository.setLastDynamicTime(streamer.mid, latestDynamic.publishedAt);
          }
        } catch (error) {
          logger.warn("plugin", "vtb dynamic poll failed; live status polling will continue", {
            streamer: streamer.name,
            error: normalizeError(error),
          });
        }
      } catch (error) {
        logger.error("plugin", "vtb subscription poll failed", { streamerName, error: normalizeError(error) });
      }
    }
  } finally {
    pushCache.clear();
  }
};

const getVtbPollingIntervalMs = (cronExpression: string) => {
  const minuteInterval = /^\*\/(\d+) \* \* \* \*$/.exec(cronExpression)?.[1];
  return (minuteInterval ? Number(minuteInterval) : 3) * 60_000;
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
  return { stop: () => task.stop() };
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

  return { stop: () => task.stop() };
};

const pushNewsToConfiguredGroups = async (
  config: MizConfig,
  gateway: Gateway,
  logger: Logger,
) => {
  const sentCounts = await Promise.all(
    config.news.groupIds.map(async (groupId) => {
      const news = await deliverUnsentNews(config.news.apiUrl, `group:${groupId}`, async (items) => {
        await gateway.sendGroupMessage(groupId, formatScheduledNewsItems(items).join("\n\n"));
      });
      return news.length;
    }),
  );
  const sentNewsCount = sentCounts.reduce((total, count) => total + count, 0);

  if (sentNewsCount === 0) {
    logger.info("plugin", "news task found no updates", { groups: config.news.groupIds.length });
    return;
  }

  logger.info("plugin", "news task sent updates", {
    groups: config.news.groupIds.length,
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
    stop: () => {
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

  for (const groupId of groupIds) {
    try {
      await gateway.sendGroupMessage(groupId, createWallpaperMessage(wallpaper));
      logger.info("plugin", "daily wallpaper sent", { groupId, wallpaperId: wallpaper.id });
    } catch (error) {
      logger.error("plugin", "daily wallpaper delivery failed", { groupId, error: normalizeError(error) });
    }
  }
};

const getGroupIds = (value: unknown): Array<number | string> => {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value.flatMap((group) => {
        if (!group || typeof group !== "object") {
          return [];
        }

        const groupId = (group as Record<string, unknown>).group_id;
        return typeof groupId === "number" || (typeof groupId === "string" && groupId.trim())
          ? [groupId]
          : [];
      }),
    ),
  );
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
    stop: () => {
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
  stop: () => {},
});

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
