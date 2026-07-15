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

const ALL_GROUPS_DELIVERED_MARKER = "*";

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
                text: ` 日程快开始了\n安排：${event.content}\n时间：${dayjs(event.eventAt).format("YYYY年MM月DD日 HH:mm")}\n记得提前准备。`,
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

  let running = false;
  let currentRun: Promise<void> | undefined;
  const runTask = async () => {
    if (running) {
      logger.warn("plugin", "activity task skipped: previous run is still active");
      return;
    }

    running = true;
    try {
      const activities = await repository.claimDueActivities(new Date(), config.activity.batchSize);
      for (const activity of activities) {
        try {
          const participantIds = activity.registrations.length > 0
            ? activity.registrations.map((registration) => registration.userId)
            : [activity.creatorId];
          const mentions = Array.from(new Set(participantIds)).flatMap((userId) => [
            { type: "at", data: { qq: userId } },
            { type: "text", data: { text: " " } },
          ]);
          await gateway.sendGroupMessage(activity.groupId, [
            ...mentions,
            {
              type: "text",
              data: {
                text: `活动快开始了\n#${activity.displayId} · ${activity.content}\n时间：${dayjs(activity.eventAt).format("YYYY年M月D日 HH:mm")}\n报过名的朋友记得准备。`,
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
          logger.error("plugin", "activity reminder delivery failed after claiming", {
            displayId: activity.displayId,
            groupId: activity.groupId,
            error: normalizeError(error),
          });
        }
      }
      await repository.cleanupFinishedActivities();
    } finally {
      running = false;
    }
  };

  const task = cron.schedule(cronExpression, () => {
    const wasRunning = running;
    const run = runTask();
    if (!wasRunning) currentRun = run;
    void run.catch((error) => logger.error("plugin", "activity task failed", error));
  });
  logger.info("plugin", "activity task started", {
    cronExpression,
    reminderMinutes: config.activity.reminderMinutes,
  });
  return {
    stop: async () => {
      task.stop();
      await currentRun?.catch((error) => logger.warn("plugin", "activity task ended with an error during shutdown", error));
    },
  };
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

  let running = false;
  let currentRun: Promise<void> | undefined;
  const runTask = async () => {
    if (running) {
      logger.warn("plugin", "todo task skipped: previous run is still active");
      return;
    }

    running = true;
    try {
      const todos = await repository.claimDueTodos(new Date(), config.todo.batchSize);
      for (const todo of todos) {
        try {
          const targetId = todo.assigneeId ?? todo.creatorId;
          await gateway.sendGroupMessage(todo.groupId, [
            { type: "at", data: { qq: targetId } },
            {
              type: "text",
              data: {
                text: ` 待办快到期了\n#${todo.displayId} · ${todo.content}\n截止：${dayjs(todo.dueAt).format("YYYY年M月D日 HH:mm")}\n完成后发 miz todo done ${todo.displayId} 标记一下。`,
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
          logger.error("plugin", "todo reminder delivery failed after claiming", {
            displayId: todo.displayId,
            groupId: todo.groupId,
            error: normalizeError(error),
          });
        }
      }
      await repository.cleanupFinishedTodos();
    } finally {
      running = false;
    }
  };

  const task = cron.schedule(cronExpression, () => {
    const wasRunning = running;
    const run = runTask();
    if (!wasRunning) currentRun = run;
    void run.catch((error) => logger.error("plugin", "todo task failed", error));
  });
  logger.info("plugin", "todo task started", { cronExpression, reminderMinutes: config.todo.reminderMinutes });
  return {
    stop: async () => {
      task.stop();
      await currentRun?.catch((error) => logger.warn("plugin", "todo task ended with an error during shutdown", error));
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
            { type: "text", data: { text: ` 提醒你一下：${reminder.content}` } },
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
            Promise.resolve(liveInfos.get(streamer.mid)),
            Promise.resolve(cardInfos.get(streamer.mid)?.fans),
          ]).then(([live, fans]) => {
            if (!live) {
              throw new Error(`Bilibili live API omitted streamer ${streamer.mid}`);
            }
            return { streamer, live, fans };
          });
        pushCache.set(streamer.mid, cachedPush);
        const { live, fans } = await cachedPush;
        const session = await repository.getLiveSession(streamer.mid);
        const activeSession = session?.endedAt ? undefined : session;
        const belongsToEndedSession = session?.endedAt !== undefined &&
          live.liveStartedAt !== undefined &&
          live.liveStartedAt <= session.endedAt;
        const undeliveredGroupIds = groupIds.filter(
          (groupId) => !activeSession?.deliveredGroupIds.includes(String(groupId)),
        );
        const isRecentLive = isVtbLiveStartRecent(live.liveStartedAt, config.vtb.cron);
        if (
          live.isLive &&
          !belongsToEndedSession &&
          (!activeSession ? isRecentLive : undeliveredGroupIds.length > 0)
        ) {
          const message = [
            { type: "text", data: { text: formatLiveMessage(live, fans) } },
            ...(live.coverUrl ? [{ type: "image", data: { file: live.coverUrl } }] : []),
          ];
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
          const endedAt = session.endedAt ?? new Date();
          const endFans = session.endFans ?? fans;
          if (!session.endedAt) {
            await repository.markLiveSessionEnded(streamer.mid, endFans, endedAt);
          }
          const undeliveredEndGroupIds = session.endDeliveredGroupIds.includes(ALL_GROUPS_DELIVERED_MARKER)
            ? []
            : groupIds.filter((groupId) => !session.endDeliveredGroupIds.includes(String(groupId)));
          if (undeliveredEndGroupIds.length > 0) {
            const message = formatOfflineMessage(
              live.name,
              session.startedAt,
              endedAt,
              session.startFans,
              endFans,
              session.roomId,
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
        const isRecent = Date.now() - latestDynamic.publishedAt.getTime() < getVtbPollingIntervalMs(config.vtb.cron);
        const isLivePromotion = latestDynamic.description.includes("https://live.bilibili.com");

          if ((isNewDynamic || isCurrentDynamic) && isRecent && !isLivePromotion) {
            const deliveredGroupIds = isCurrentDynamic ? dynamicState.deliveredGroupIds : [];
            const undeliveredDynamicGroupIds = deliveredGroupIds.includes(ALL_GROUPS_DELIVERED_MARKER)
              ? []
              : groupIds.filter((groupId) => !deliveredGroupIds.includes(String(groupId)));
            if (undeliveredDynamicGroupIds.length === 0) {
              continue;
            }
            const message = [
              { type: "text", data: { text: formatDynamicMessage(latestDynamic) } },
              ...(feed.avatarUrl ? [{ type: "image", data: { file: feed.avatarUrl } }] : []),
            ];
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
      { type: "text", data: { text: "\n\n" } },
      { type: "at", data: { qq: "all" } },
      { type: "text", data: { text: " 主播开播了，想看的可以去直播间。" } },
    ]
  : message;

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
const isVtbLiveStartRecent = (liveStartedAt: Date | undefined, cronExpression: string) =>
  liveStartedAt === undefined ||
  Date.now() - liveStartedAt.getTime() < getVtbPollingIntervalMs(cronExpression) + 60_000;

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
  let currentRun: Promise<void> | undefined;
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
    const wasRunning = running;
    const run = runTask();
    if (!wasRunning) {
      currentRun = run;
    }
    void run.catch((error) => logger.error("plugin", "yt-dlp update failed", error));
  });

  logger.info("plugin", "yt-dlp update task started", { cronExpression });
  return {
    stop: async () => {
      task.stop();
      await currentRun?.catch((error) => logger.warn("plugin", "yt-dlp update ended with an error during shutdown", error));
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
  let currentRun: Promise<void> | undefined;
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
    const wasRunning = running;
    const run = runTask();
    if (!wasRunning) {
      currentRun = run;
    }
    void run.catch((error) => logger.error("plugin", "news task failed", error));
  });

  logger.info("plugin", "news task started", {
    cronExpression,
    groups: config.news.groupIds.length,
  });

  return {
    stop: async () => {
      task.stop();
      await currentRun?.catch((error) => logger.warn("plugin", "news task ended with an error during shutdown", error));
    },
  };
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
  let currentRun: Promise<void> | undefined;
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
    const wasRunning = running;
    const run = runTask();
    if (!wasRunning) {
      currentRun = run;
    }
    void run.catch((error) => {
      logger.error("plugin", "wallpaper task failed", error);
    });
  });

  logger.info("plugin", "wallpaper task started", { cronExpression });

  return {
    stop: async () => {
      task.stop();
      await currentRun?.catch((error) => logger.warn("plugin", "wallpaper task ended with an error during shutdown", error));
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
  let currentRun: Promise<void> | undefined;
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
    const wasRunning = running;
    const run = runTask();
    if (!wasRunning) {
      currentRun = run;
    }
    void run.catch((error) => {
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
      await currentRun?.catch((error) => logger.warn("plugin", "ff14 price alert task ended with an error during shutdown", error));
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
          title: `FF14 价格提醒 · ${result.item.Name}`,
          source: "miz ff14",
          summary: `${FF14_REGION_NAMES[alert.region]} · 价格已到 ${alert.minimumPrice.toLocaleString("zh-CN")} gil 以下`,
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
