import cron from "node-cron";
import dayjs from "dayjs";
import { updateVtbSubscriptionNames, type MizConfig } from "@/config";
import { isGroupMessageUnavailableError, type Gateway } from "@/gateway";
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
import { createExclusiveCronTask, type ScheduledTaskRuntime } from "@/scheduled-task";
import { serializeError } from "@/errors";
import {
  closeVtbRepository,
  createVtbNotificationMessage,
  formatDynamicMessage,
  formatLiveMessage,
  formatOfflineMessage,
  getVtbRepository,
  getVtbCardInfos,
  getVtbDynamics,
  getVtbImageFile,
  getVtbLiveInfos,
  prependVtbAtAllMention,
  resolveTrackedVtbStreamer,
  syncVtbSubscriptionNames,
  type VtbDynamicFeed,
  type VtbLiveInfo,
  type VtbStreamer,
} from "@/vtb";

const ALL_GROUPS_DELIVERED_MARKER = "*";
const SCHEDULED_DELIVERY_CONCURRENCY = 5;
const WALLPAPER_DELIVERY_CONCURRENCY = 3;
const WALLPAPER_SEND_INTERVAL_MS = 2_000;

type VtbPollState = {
  dynamicCursor: number;
  cardInfos: Map<string, { fans?: number; avatarUrl?: string; expiresAt: number }>;
};

export type TaskRuntime = ScheduledTaskRuntime;

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
    startedTasks.push(await startActivityTask(config, gateway, logger));
    startedTasks.push(await startTodoTask(config, gateway, logger));
    startedTasks.push(startYtDlpUpdateTask(config, logger));
    startedTasks.push(startVtbNameSyncTask(config, logger));
    startedTasks.push(await startVtbTask(config, gateway, logger));
    return { stop: () => stopTaskRuntime(startedTasks) };
  } catch (error) {
    try {
      await stopTaskRuntime(startedTasks);
    } catch (stopError) {
      logger.warn("plugin", "partially started tasks failed to stop cleanly", stopError);
    }
    throw error;
  }
};

const stopTaskRuntime = async (tasks: readonly TaskRuntime[]) => {
  let failure: unknown;
  try {
    await stopTasks(tasks);
  } catch (error) {
    failure = error;
  }

  try {
    await closeVtbRepository();
  } catch (error) {
    failure ??= error;
  }

  if (failure) {
    throw failure;
  }
};

const stopTasks = async (tasks: readonly TaskRuntime[]) => {
  const results = await Promise.allSettled(tasks.map((task) => task.stop()));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) {
    throw failure.reason;
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

  const runTask = async () => {
    const events = await repository.claimDueScheduleEvents(new Date(), config.schedule.batchSize);
    await settleWithConcurrency(events, SCHEDULED_DELIVERY_CONCURRENCY, async (event) => {
        try {
          await gateway.sendGroupMessageWithoutRetry(event.groupId, [
            { type: "at", data: { qq: event.creatorId } },
            {
              type: "text",
              data: {
                text: ` 📅 日程要开场啦\n「${event.content}」\n⏰ ${dayjs(event.eventAt).format("YYYY年MM月DD日 HH:mm")}\n准备一下，别错过时间。`,
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
          logGroupDeliveryFailure(logger, "schedule reminder delivery failed after claiming", {
            displayId: event.displayId,
            groupId: event.groupId,
          }, error);
        }
    });

    await repository.cleanupFinishedScheduleEvents();
  };

  logger.info("plugin", "schedule task started", { cronExpression, reminderMinutes: config.schedule.reminderMinutes });
  return createExclusiveCronTask({
    cronExpression,
    taskName: "schedule task",
    logger,
    run: runTask,
    skippedMessage: "schedule task skipped: previous run is still active",
    failureMessage: "schedule task failed",
    shutdownFailureMessage: "schedule task ended with an error during shutdown",
  });
};

const startActivityTask = async (config: MizConfig, gateway: Gateway, logger: Logger): Promise<TaskRuntime> => {
  if (!config.activity.enabled) {
    logger.info("plugin", "activity task disabled: config switch is off");
    return createNoopTask();
  }

  const cronExpression = config.activity.cron;
  if (!cron.validate(cronExpression)) {
    logger.warn("plugin", "activity task disabled: invalid cron expression", { cronExpression });
    return createNoopTask();
  }

  let repository;
  try {
    repository = await getVtbRepository(config);
    await repository.ensureActivityStorage();
  } catch (error) {
    logger.error("plugin", "activity task disabled: database initialization failed", error);
    return createNoopTask();
  }

  const runTask = async () => {
    const activities = await repository.claimDueActivities(new Date(), config.activity.batchSize);
    await settleWithConcurrency(activities, SCHEDULED_DELIVERY_CONCURRENCY, async (activity) => {
        try {
          const participantIds = activity.registrations.length > 0
            ? activity.registrations.map((registration) => registration.userId)
            : [activity.creatorId];
          const mentions = Array.from(new Set(participantIds)).flatMap((userId) => [
            { type: "at", data: { qq: userId } },
            { type: "text", data: { text: " " } },
          ]);
          await gateway.sendGroupMessageWithoutRetry(activity.groupId, [
            ...mentions,
            {
              type: "text",
              data: {
                text: `🎊 活动快开场啦\n#${activity.displayId} · 「${activity.content}」\n⏰ ${dayjs(activity.eventAt).format("YYYY年M月D日 HH:mm")}\n报过名的朋友，准备集合！`,
              },
            },
          ]);
          logger.info("plugin", "activity reminder sent", {
            displayId: activity.displayId,
            groupId: activity.groupId,
            participantCount: activity.registrations.length,
          });
        } catch (error) {
          try {
            await repository.releaseActivityClaim(activity);
          } catch (releaseError) {
            logger.error("plugin", "activity reminder claim could not be released", {
              displayId: activity.displayId,
              groupId: activity.groupId,
              error: normalizeError(releaseError),
            });
          }
          logGroupDeliveryFailure(logger, "activity reminder delivery failed after claiming", {
            displayId: activity.displayId,
            groupId: activity.groupId,
          }, error);
        }
    });
    await repository.cleanupFinishedActivities();
  };

  logger.info("plugin", "activity task started", {
    cronExpression,
    reminderMinutes: config.activity.reminderMinutes,
  });
  return createExclusiveCronTask({
    cronExpression,
    taskName: "activity task",
    logger,
    run: runTask,
    skippedMessage: "activity task skipped: previous run is still active",
    failureMessage: "activity task failed",
    shutdownFailureMessage: "activity task ended with an error during shutdown",
  });
};

const startTodoTask = async (config: MizConfig, gateway: Gateway, logger: Logger): Promise<TaskRuntime> => {
  if (!config.todo.enabled) {
    logger.info("plugin", "todo task disabled: config switch is off");
    return createNoopTask();
  }

  const cronExpression = config.todo.cron;
  if (!cron.validate(cronExpression)) {
    logger.warn("plugin", "todo task disabled: invalid cron expression", { cronExpression });
    return createNoopTask();
  }

  let repository;
  try {
    repository = await getVtbRepository(config);
    await repository.ensureTodoStorage();
  } catch (error) {
    logger.error("plugin", "todo task disabled: database initialization failed", error);
    return createNoopTask();
  }

  const runTask = async () => {
    const todos = await repository.claimDueTodos(new Date(), config.todo.batchSize);
    await settleWithConcurrency(todos, SCHEDULED_DELIVERY_CONCURRENCY, async (todo) => {
        try {
          const targetId = todo.assigneeId ?? todo.creatorId;
          await gateway.sendGroupMessageWithoutRetry(todo.groupId, [
            { type: "at", data: { qq: targetId } },
            {
              type: "text",
              data: {
                text: ` ⏰ 待办快到点啦\n#${todo.displayId} · 「${todo.content}」\n截止于 ${dayjs(todo.dueAt).format("YYYY年M月D日 HH:mm")}\n完成后发 miz todo done ${todo.displayId} 打个勾吧。`,
              },
            },
          ]);
          logger.info("plugin", "todo reminder sent", { displayId: todo.displayId, groupId: todo.groupId });
        } catch (error) {
          try {
            await repository.releaseTodoClaim(todo);
          } catch (releaseError) {
            logger.error("plugin", "todo reminder claim could not be released", {
              displayId: todo.displayId,
              groupId: todo.groupId,
              error: normalizeError(releaseError),
            });
          }
          logGroupDeliveryFailure(logger, "todo reminder delivery failed after claiming", {
            displayId: todo.displayId,
            groupId: todo.groupId,
          }, error);
        }
    });
    await repository.cleanupFinishedTodos();
  };

  logger.info("plugin", "todo task started", { cronExpression, reminderMinutes: config.todo.reminderMinutes });
  return createExclusiveCronTask({
    cronExpression,
    taskName: "todo task",
    logger,
    run: runTask,
    skippedMessage: "todo task skipped: previous run is still active",
    failureMessage: "todo task failed",
    shutdownFailureMessage: "todo task ended with an error during shutdown",
  });
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

  const runTask = async () => {
    const reminders = await repository.claimDueReminders(new Date(), config.reminder.batchSize);
    await settleWithConcurrency(reminders, SCHEDULED_DELIVERY_CONCURRENCY, async (reminder) => {
        try {
          await gateway.sendGroupMessageWithoutRetry(reminder.groupId, [
            { type: "at", data: { qq: reminder.targetId } },
            { type: "text", data: { text: ` 🔔 时间到啦：${reminder.content}` } },
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
          logGroupDeliveryFailure(logger, "reminder delivery failed after claiming", {
            id: reminder.id,
            groupId: reminder.groupId,
          }, error);
        }
    });
  };

  logger.info("plugin", "reminder task started", { cronExpression });
  return createExclusiveCronTask({
    cronExpression,
    taskName: "reminder task",
    logger,
    run: runTask,
    skippedMessage: "reminder task skipped: previous run is still active",
    failureMessage: "reminder task failed",
    shutdownFailureMessage: "reminder task ended with an error during shutdown",
  });
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

  const runTask = async () => {
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
  };

  logger.info("plugin", "vtb name sync task started", { cronExpression });
  return createExclusiveCronTask({
    cronExpression,
    taskName: "vtb name sync task",
    logger,
    run: runTask,
    skippedMessage: "vtb name sync task skipped: previous run is still active",
    failureMessage: "vtb name sync task failed",
    shutdownFailureMessage: "vtb name sync task ended with an error during shutdown",
  });
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

  const pollState: VtbPollState = {
    dynamicCursor: 0,
    cardInfos: new Map(),
  };
  const runTask = () => pollVtbSubscriptions(config, gateway, logger, repository, pollState);

  logger.info("plugin", "vtb task started", {
    cronExpression,
    subscriptions: config.vtb.subscriptions.length,
    dynamicPollMinutes: config.vtb.dynamicPollMinutes,
    dynamicConcurrency: config.vtb.dynamicConcurrency,
    cardCacheMinutes: config.vtb.cardCacheMinutes,
  });

  return createExclusiveCronTask({
    cronExpression,
    taskName: "vtb task",
    logger,
    run: runTask,
    failureMessage: "vtb task failed",
    shutdownFailureMessage: "vtb task ended with an error during shutdown",
  });
};

const pollVtbSubscriptions = async (
  config: MizConfig,
  gateway: Gateway,
  logger: Logger,
  repository: Awaited<ReturnType<typeof getVtbRepository>>,
  pollState: VtbPollState,
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
      avatarUrl?: string;
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

    const streamerMids = Array.from(new Set(
      resolvedSubscriptions.map((subscription) => subscription.streamer.mid),
    ));
    const now = Date.now();
    const cardCacheMs = config.vtb.cardCacheMinutes * 60_000;
    const cardRefreshMids = streamerMids.filter((mid) => {
      const cached = pollState.cardInfos.get(mid);
      return !cached || cached.expiresAt <= now;
    });
    if (cardRefreshMids.length > 0) {
      try {
        const refreshedCards = await getVtbCardInfos(cardRefreshMids, config.vtb);
        for (const mid of cardRefreshMids) {
          pollState.cardInfos.set(mid, {
            fans: refreshedCards.get(mid)?.fans,
            avatarUrl: refreshedCards.get(mid)?.avatarUrl,
            expiresAt: now + cardCacheMs,
          });
        }
      } catch (error) {
        logger.warn("plugin", "vtb batch card request failed; cached fan counts will be reused", normalizeError(error));
      }
    }
    const cardInfos = new Map(
      streamerMids.map((mid) => [mid, {
        fans: pollState.cardInfos.get(mid)?.fans,
        avatarUrl: pollState.cardInfos.get(mid)?.avatarUrl,
      }]),
    );

    const uniqueDynamicSubscriptions = Array.from(
      new Map(resolvedSubscriptions.map((subscription) => [subscription.streamer.mid, subscription])).values(),
    );
    const dynamicSubscriptions = selectVtbDynamicPollBatch(
      uniqueDynamicSubscriptions,
      pollState,
      getVtbPollingIntervalMs(config.vtb.cron),
      config.vtb.dynamicPollMinutes * 60_000,
    );
    const dynamicTasks = startWithConcurrency(dynamicSubscriptions, config.vtb.dynamicConcurrency, async (subscription) => {
      try {
        return await getVtbDynamics(subscription.streamer, config.vtb);
      } catch {
        // Dynamic feeds are optional. Network failures, including HTTP 503,
        // must not interrupt live polling or create noisy periodic warnings.
        return undefined;
      }
    });
    const dynamicFeeds = new Map(
      dynamicSubscriptions.map((subscription, index) => [subscription.streamer.mid, dynamicTasks[index]]),
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
            Promise.resolve(liveInfos.get(streamer.mid)),
            Promise.resolve(cardInfos.get(streamer.mid)),
          ]).then(([live, card]) => {
            if (!live) {
              throw new Error(`Bilibili live API omitted streamer ${streamer.mid}`);
            }
            return { streamer, live, fans: card?.fans, avatarUrl: card?.avatarUrl };
          });
        pushCache.set(streamer.mid, cachedPush);
        const { live, fans, avatarUrl } = await cachedPush;
        const session = await repository.getLiveSession(streamer.mid);
        const activeSession = session?.endedAt ? undefined : session;
        const belongsToEndedSession = session?.endedAt !== undefined &&
          live.liveStartedAt !== undefined &&
          live.liveStartedAt <= session.endedAt;
        const undeliveredGroupIds = groupIds.filter(
          (groupId) => !activeSession?.deliveredGroupIds.includes(String(groupId)),
        );
        const isRecentLive = isVtbLiveStartRecent(live.liveStartedAt, config.vtb.cron, now);
        if (
          live.isLive &&
          !belongsToEndedSession &&
          (!activeSession ? isRecentLive : undeliveredGroupIds.length > 0)
        ) {
          const imageFile = await resolveVtbNotificationImage(
            live.coverUrl ?? avatarUrl,
            config,
            logger,
            "live start",
            live.name,
          );
          const message = createVtbNotificationMessage(
            formatLiveMessage(live, fans, config.vtb.liveWebUrl),
            imageFile,
          );
          const deliveredGroups = await sendVtbGroupMessage(
            undeliveredGroupIds,
            message,
            gateway,
            logger,
            "live start",
            live.name,
            new Set(
              [...atAllGroupIds].filter((groupId) => undeliveredGroupIds.some((id) => String(id) === groupId)),
            ),
          );
          const deliveredGroupIds = deliveredGroups.map(String);
          if (activeSession) {
            await repository.recordLiveDelivery(streamer.mid, deliveredGroupIds);
          } else {
            // Store an empty list as a pending delivery as well, so a failed
            // first send is retried even after the freshness window closes.
            await repository.startLiveSession(streamer, live, fans, deliveredGroupIds);
          }
          if (deliveredGroups.length > 0) {
            logger.info("plugin", "vtb live started notification sent", { streamer: live.name, groupIds: deliveredGroups });
          }
          if (deliveredGroups.length !== undeliveredGroupIds.length) {
            logger.warn("plugin", "vtb live start notification partially delivered; will retry failed groups", {
              streamer: live.name,
              groupIds: undeliveredGroupIds,
              deliveredGroups,
            });
          }
        } else if (live.isLive && !activeSession && !belongsToEndedSession) {
          logger.info("plugin", "vtb live start notification skipped: live is older than the freshness window", {
            streamer: live.name,
            liveStartedAt: live.liveStartedAt,
          });
        } else if (!live.isLive && session) {
          const endedAt = session.endedAt ?? new Date(now);
          const endFans = session.endFans ?? fans;
          if (!session.endedAt) {
            await repository.markLiveSessionEnded(streamer.mid, endFans, endedAt);
          }
          const undeliveredEndGroupIds = session.endDeliveredGroupIds.includes(ALL_GROUPS_DELIVERED_MARKER)
            ? []
            : groupIds.filter((groupId) => !session.endDeliveredGroupIds.includes(String(groupId)));
          if (undeliveredEndGroupIds.length > 0) {
            const message = createVtbNotificationMessage(
              formatOfflineMessage(
                live.name,
                session.startedAt,
                endedAt,
                session.startFans,
                endFans,
                session.roomId,
                config.vtb.liveWebUrl,
              ),
            );
            const deliveredGroups = await sendVtbGroupMessage(
              undeliveredEndGroupIds,
              message,
              gateway,
              logger,
              "live end",
              live.name,
            );
            await repository.recordLiveEndDelivery(streamer.mid, deliveredGroups.map(String));
            logger.info("plugin", "vtb live ended notification sent", { streamer: live.name, groupIds: deliveredGroups });
          }
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
        const dynamicState = await repository.getDynamicDeliveryState(streamer.mid);
        const isNewDynamic = !dynamicState || latestDynamic.publishedAt > dynamicState.publishedAt;
        const isCurrentDynamic = dynamicState?.publishedAt.getTime() === latestDynamic.publishedAt.getTime();
        const isRecent = now - latestDynamic.publishedAt.getTime() <
          config.vtb.dynamicPollMinutes * 60_000 + getVtbPollingIntervalMs(config.vtb.cron);
        const isLivePromotion = latestDynamic.description.includes(config.vtb.liveWebUrl);

        if ((isNewDynamic || isCurrentDynamic) && isRecent && !isLivePromotion) {
            const deliveredGroupIds = isCurrentDynamic ? dynamicState.deliveredGroupIds : [];
            const undeliveredDynamicGroupIds = deliveredGroupIds.includes(ALL_GROUPS_DELIVERED_MARKER)
              ? []
              : groupIds.filter((groupId) => !deliveredGroupIds.includes(String(groupId)));
            if (undeliveredDynamicGroupIds.length === 0) {
              continue;
            }
            const imageFile = await resolveVtbNotificationImage(
              feed.avatarUrl,
              config,
              logger,
              "dynamic",
              streamer.name,
            );
            const message = createVtbNotificationMessage(
              formatDynamicMessage(latestDynamic, config.vtb.webUrl),
              imageFile,
            );
            const deliveredGroups = await sendVtbGroupMessage(
              undeliveredDynamicGroupIds,
              message,
              gateway,
              logger,
              "dynamic",
              streamer.name,
            );
            if (isNewDynamic) {
              await repository.startDynamicDelivery(streamer.mid, latestDynamic.publishedAt, deliveredGroups.map(String));
            } else {
              await repository.recordDynamicDelivery(streamer.mid, deliveredGroups.map(String));
            }
            logger.info("plugin", "vtb dynamic notification sent", {
              streamer: streamer.name,
              groupIds: deliveredGroups,
              dynamics: 1,
            });
          } else if (isNewDynamic) {
            // Mark stale and live-promotion dynamics as seen so they are never retried.
            await repository.startDynamicDelivery(streamer.mid, latestDynamic.publishedAt);
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

const selectVtbDynamicPollBatch = <T>(
  subscriptions: readonly T[],
  pollState: VtbPollState,
  livePollIntervalMs: number,
  dynamicPollIntervalMs: number,
) => {
  if (subscriptions.length === 0) {
    pollState.dynamicCursor = 0;
    return [];
  }

  const pollsPerCycle = Math.max(1, Math.ceil(dynamicPollIntervalMs / livePollIntervalMs));
  const batchSize = Math.max(1, Math.ceil(subscriptions.length / pollsPerCycle));
  const cursor = pollState.dynamicCursor % subscriptions.length;
  const batch = subscriptions.slice(cursor, cursor + batchSize);
  pollState.dynamicCursor = (cursor + batch.length) % subscriptions.length;
  return batch;
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
      return gateway.sendGroupMessageWithoutRetry(
        groupId,
        shouldMentionAll ? prependVtbAtAllMention(message) : message,
      );
    },
  );
  const deliveredGroups: Array<string | number> = [];
  for (const [index, result] of results.entries()) {
    const groupId = groupIds[index];
    if (result.status === "fulfilled") {
      deliveredGroups.push(groupId);
      continue;
    }

    logGroupDeliveryFailure(logger, "vtb notification delivery failed", {
      kind,
      streamer,
      groupId,
    }, result.reason);
  }
  return deliveredGroups;
};

const resolveVtbNotificationImage = async (
  imageUrl: string | undefined,
  config: MizConfig,
  logger: Logger,
  kind: "live start" | "dynamic",
  streamer: string,
) => {
  try {
    return await getVtbImageFile(imageUrl, config.vtb);
  } catch (error) {
    logger.warn("plugin", "vtb notification image unavailable; sending text only", {
      kind,
      streamer,
      error: normalizeError(error),
    });
    return undefined;
  }
};

const getVtbPollingIntervalMs = (cronExpression: string) => {
  const minuteInterval = /^\*\/(\d+) \* \* \* \*$/.exec(cronExpression)?.[1];
  return Math.max(1, minuteInterval ? Number(minuteInterval) : 3) * 60_000;
};

/**
 * Cron dispatch and upstream requests have normal timing jitter.  Keep a
 * bounded grace period so a stream opened just after the previous poll is not
 * discarded merely because this poll begins a few seconds late.  Some live
 * API responses also omit live_time; while the stream is reported live, that
 * must not suppress its first notification.
 */
const isVtbLiveStartRecent = (
  liveStartedAt: Date | undefined,
  cronExpression: string,
  nowMs: number,
) =>
  liveStartedAt === undefined ||
  nowMs - liveStartedAt.getTime() < getVtbPollingIntervalMs(cronExpression) + 60_000;

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

  const runTask = async () => {
    await updateYtDlp(config.video);
    logger.info("plugin", "yt-dlp updated");
  };

  logger.info("plugin", "yt-dlp update task started", { cronExpression });
  return createExclusiveCronTask({
    cronExpression,
    taskName: "yt-dlp update task",
    logger,
    run: runTask,
    skippedMessage: "yt-dlp update task skipped: previous run is still active",
    failureMessage: "yt-dlp update failed",
    shutdownFailureMessage: "yt-dlp update ended with an error during shutdown",
  });
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

  const runTask = async () => {
    await pushNewsToConfiguredGroups(config, gateway, logger);
  };

  logger.info("plugin", "news task started", {
    cronExpression,
    groups: config.news.groupIds.length,
  });

  return createExclusiveCronTask({
    cronExpression,
    taskName: "news task",
    logger,
    run: runTask,
    skippedMessage: "news task skipped: previous run is still active",
    failureMessage: "news task failed",
    shutdownFailureMessage: "news task ended with an error during shutdown",
  });
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
        await gateway.sendGroupMessageWithoutRetry(groupId, formatScheduledNewsItems(items).join("\n\n"));
      },
      latestNews,
    );
    return news.length;
  });
  const sentCounts = results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }

    logGroupDeliveryFailure(logger, "news delivery failed", {
      groupId: groupIds[index],
    }, result.reason);
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

  const runTask = async () => {
    await sendDailyWallpaper(config, gateway, logger);
  };

  void getDailyWallpaper(config.wallpaper.apiUrl, config.wallpaper.imageBaseUrl).catch((error) => {
    logger.warn("plugin", "wallpaper cache warmup failed; scheduled task will retry", normalizeError(error));
  });
  void gateway.getGroupList().catch((error) => {
    logger.warn("plugin", "wallpaper group list warmup failed; scheduled task will retry", normalizeError(error));
  });

  logger.info("plugin", "wallpaper task started", { cronExpression });

  return createExclusiveCronTask({
    cronExpression,
    taskName: "wallpaper task",
    logger,
    run: runTask,
    skippedMessage: "wallpaper task skipped: previous run is still active",
    failureMessage: "wallpaper task failed",
    shutdownFailureMessage: "wallpaper task ended with an error during shutdown",
  });
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

  const waitForSendSlot = createIntervalGate(WALLPAPER_SEND_INTERVAL_MS);
  const results = await settleWithConcurrency(
    groupIds,
    WALLPAPER_DELIVERY_CONCURRENCY,
    async (groupId) => {
      await waitForSendSlot();
      await gateway.sendGroupMessageWithoutRetry(groupId, createWallpaperMessage(wallpaper));
    },
  );
  let sentCount = 0;
  for (const [index, result] of results.entries()) {
    const groupId = groupIds[index];
    if (result.status === "fulfilled") {
      sentCount += 1;
      logger.info("plugin", "daily wallpaper sent", { groupId, wallpaperId: wallpaper.id });
      continue;
    }

    logGroupDeliveryFailure(logger, "daily wallpaper delivery failed", {
      groupId,
    }, result.reason);
  }

  logger.info("plugin", "wallpaper task delivery completed", {
    groups: groupIds.length,
    sent: sentCount,
    failed: groupIds.length - sentCount,
    wallpaperId: wallpaper.id,
  });
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

  const runTask = async () => {
    await runFf14PriceAlerts(config, gateway, logger);
  };

  logger.info("plugin", "ff14 price alert task started", {
    cronExpression,
    alerts: alerts.length,
  });

  return createExclusiveCronTask({
    cronExpression,
    taskName: "ff14 price alert task",
    logger,
    run: runTask,
    skippedMessage: "ff14 price alert task skipped: previous run is still active",
    failureMessage: "ff14 price alert task failed",
    shutdownFailureMessage: "ff14 price alert task ended with an error during shutdown",
  });
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
          title: `🪙 FF14 低价提醒 · ${result.item.Name}`,
          source: "miz ff14",
          summary: `${FF14_REGION_NAMES[alert.region]} · 好价出现，已到 ${alert.minimumPrice.toLocaleString("zh-CN")} gil 以下`,
        },
      );

      logger.info("plugin", "ff14 price alert sent", {
        ...alert,
        lowestPrice,
      });
    } catch (error) {
      logGroupDeliveryFailure(logger, "ff14 price alert failed", {
        alert,
      }, error);
    }
  }
};

const createNoopTask = (): TaskRuntime => ({
  stop: async () => {},
});

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const createIntervalGate = (intervalMilliseconds: number) => {
  let nextStartAt = Date.now();
  return async () => {
    const startAt = nextStartAt;
    nextStartAt += intervalMilliseconds;
    await wait(Math.max(0, startAt - Date.now()));
  };
};

const hasVtbApiEndpoints = (config: MizConfig["vtb"]) =>
  Boolean(
    config.userApiUrl &&
    config.cardApiUrl &&
    config.liveApiUrl &&
    config.dynamicApiUrl &&
    config.webUrl &&
    config.liveWebUrl
  );

const normalizeError = serializeError;

const logGroupDeliveryFailure = (
  logger: Logger,
  message: string,
  metadata: Record<string, unknown>,
  error: unknown,
) => {
  if (isGroupMessageUnavailableError(error)) {
    return;
  }
  logger.error("plugin", message, { ...metadata, error: normalizeError(error) });
};
