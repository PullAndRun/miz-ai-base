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
import { deliverUnsentNews, formatNewsItems } from "@/news";

export type TaskRuntime = {
  stop(): void;
};

export const startScheduledTasks = (
  config: MizConfig,
  gateway: Gateway,
  logger: Logger,
): TaskRuntime => {
  const ff14Task = startFf14PriceAlertTask(config, gateway, logger);
  const wallpaperTask = startWallpaperTask(config, gateway, logger);
  const newsTask = startNewsTask(config, gateway, logger);

  return {
    stop: () => {
      ff14Task.stop();
      wallpaperTask.stop();
      newsTask.stop();
    },
  };
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
        await gateway.sendGroupMessage(groupId, formatNewsItems(items).join("\n\n"));
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
