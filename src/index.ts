import { loadConfig } from "@/config";
import { ensureProjectDirectories } from "@/directories";
import { createGateway, type Gateway } from "@/gateway";
import { createLogger, type Logger } from "@/logger";
import { createPluginRuntime } from "@/plugins";
import { startScheduledTasks, type TaskRuntime } from "@/tasks";
import { disableUnavailableVtbSubscriptions, syncConfiguredVtbStreamers } from "@/vtb";

const registerShutdownHandlers = (gateway: Gateway, tasks: TaskRuntime, logger: Logger) => {
  let stopping = false;
  const stop = async (signal: "SIGINT" | "SIGTERM") => {
    if (stopping) {
      return;
    }

    stopping = true;
    logger.info("miz", `received ${signal}, shutting down`);
    try {
      await tasks.stop();
    } catch (error) {
      logger.error("miz", "scheduled tasks failed to stop cleanly", error);
    } finally {
      gateway.dispose();
      process.exit(0);
    }
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
};

const main = async () => {
  const createdDirectories = await ensureProjectDirectories();
  const config = await loadConfig();
  const logger = createLogger(config.naplink.logLevel);
  if (createdDirectories.length > 0) {
    logger.info("miz", "created missing project directories", { directories: createdDirectories });
  }
  const gateway = createGateway(config, logger);
  const plugins = await createPluginRuntime(config, gateway, logger);

  gateway.onMessage(plugins.handleMessage);

  logger.info("miz", `connecting to ${config.gateway.url}`);

  await gateway.connect();
  await gateway.reportServerInfo();
  await prepareVtbSubscriptions(config, gateway, logger);
  await syncConfiguredVtbStreamersOnStartup(config, logger);

  const tasks = await startScheduledTasks(config, gateway, logger);
  registerShutdownHandlers(gateway, tasks, logger);
};

const prepareVtbSubscriptions = async (
  config: Awaited<ReturnType<typeof loadConfig>>,
  gateway: Gateway,
  logger: Logger,
) => {
  if (!config.vtb.enabled) {
    return;
  }

  try {
    const groupIds = getGroupIds(await gateway.getGroupList());
    if (groupIds) {
      const disabled = disableUnavailableVtbSubscriptions(config, groupIds);
      for (const subscription of disabled) {
        logger.warn("plugin", "vtb subscription temporarily disabled: bot is not in the group", {
          groupId: subscription.groupId,
          streamers: subscription.streamers,
        });
      }
    } else {
      logger.warn("plugin", "vtb subscription availability check skipped: invalid group list response");
    }
  } catch (error) {
    logger.warn("plugin", "vtb subscription availability check failed; keeping all subscriptions enabled", error);
  }

};

const syncConfiguredVtbStreamersOnStartup = async (
  config: Awaited<ReturnType<typeof loadConfig>>,
  logger: Logger,
) => {
  if (!config.vtb.enabled || config.vtb.subscriptions.length === 0) {
    return;
  }

  try {
    const { added, skipped, removed, failed } = await syncConfiguredVtbStreamers(config);
    logger.info("plugin", "vtb subscription streamers synchronized to database", {
      added: added.length,
      removed: removed.length,
      skipped: skipped.length,
    });
    if (skipped.length > 0) {
      logger.warn("plugin", "vtb streamers not found during startup synchronization", { streamers: skipped });
    }
    if (failed.length > 0) {
      logger.warn("plugin", "vtb streamer startup synchronization partially failed", { streamers: failed });
    }
  } catch (error) {
    logger.warn("plugin", "vtb streamer startup synchronization failed; polling will continue", error);
  }
};

const getGroupIds = (value: unknown) => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return new Set(
    value.flatMap((group) => {
      if (!group || typeof group !== "object") {
        return [];
      }

      const groupId = (group as Record<string, unknown>).group_id;
      return typeof groupId === "number" || (typeof groupId === "string" && groupId.trim())
        ? [String(groupId)]
        : [];
    }),
  );
};

const logger = createLogger();

main().catch((error) => {
  logger.error("miz", "failed to start", error);
  process.exit(1);
});
