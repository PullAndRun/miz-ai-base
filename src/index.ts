import { watch } from "node:fs";
import { loadConfig } from "@/config";
import { ensureProjectDirectories } from "@/directories";
import { createGateway, type Gateway } from "@/gateway";
import { getGroupIds } from "@/group-ids";
import { createLogger, type Logger } from "@/logger";
import { createPluginRuntime } from "@/plugins";
import { startScheduledTasks } from "@/tasks";
import { partitionAvailableVtbSubscriptions, syncConfiguredVtbStreamers } from "@/vtb";

const CONFIG_RELOAD_DELAY_MS = 500;

type AppRuntime = {
  config: Awaited<ReturnType<typeof loadConfig>>;
  stop(): Promise<void>;
};

const registerShutdownHandlers = (
  gateway: Gateway,
  getRuntime: () => AppRuntime,
  stopConfigWatcher: () => void,
  logger: Logger,
) => {
  let stopping = false;
  const stop = async (signal: "SIGINT" | "SIGTERM") => {
    if (stopping) {
      return;
    }

    stopping = true;
    logger.info("miz", `received ${signal}, shutting down`);
    try {
      stopConfigWatcher();
      await getRuntime().stop();
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
  const loadedConfig = await loadConfig();
  const logger = createLogger(loadedConfig.naplink.logLevel);
  if (createdDirectories.length > 0) {
    logger.info("miz", "created missing project directories", { directories: createdDirectories });
  }
  const gateway = createGateway(loadedConfig, logger);

  logger.info("miz", `connecting to ${loadedConfig.gateway.url}`);

  await gateway.connect();
  await gateway.reportServerInfo();
  let runtime = await createAppRuntime(loadedConfig, gateway, logger);
  const stopConfigWatcher = watchConfig(logger, async (nextConfig) => {
    const previousRuntime = runtime;
    await previousRuntime.stop();
    try {
      runtime = await createAppRuntime(nextConfig, gateway, logger);
    } catch (error) {
      runtime = await createAppRuntime(previousRuntime.config, gateway, logger);
      throw error;
    }
  });
  registerShutdownHandlers(gateway, () => runtime, stopConfigWatcher, logger);
};

const createAppRuntime = async (
  loadedConfig: Awaited<ReturnType<typeof loadConfig>>,
  gateway: Gateway,
  logger: Logger,
): Promise<AppRuntime> => {
  const config = await prepareVtbSubscriptions(loadedConfig, gateway, logger);
  await syncConfiguredVtbStreamersOnStartup(config, logger);
  const plugins = await createPluginRuntime(config, gateway, logger);
  const detachPluginHandler = gateway.onMessage(plugins.handleMessage);

  try {
    const tasks = await startScheduledTasks(config, gateway, logger);
    return {
      config,
      stop: async () => {
        detachPluginHandler();
        await tasks.stop();
      },
    };
  } catch (error) {
    detachPluginHandler();
    throw error;
  }
};

const watchConfig = (
  logger: Logger,
  onReloaded: (config: Awaited<ReturnType<typeof loadConfig>>) => Promise<void>,
) => {
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let reloading = false;
  let reloadQueued = false;
  const reload = async () => {
    if (reloading) {
      reloadQueued = true;
      return;
    }

    reloading = true;
    try {
      const nextConfig = await loadConfig();
      await onReloaded(nextConfig);
      logger.info("miz", "configuration reloaded");
    } catch (error) {
      logger.warn("miz", "configuration reload failed; keeping the current configuration", error);
    } finally {
      reloading = false;
      if (reloadQueued) {
        reloadQueued = false;
        void reload();
      }
    }
  };
  const scheduleReload = () => {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      void reload();
    }, CONFIG_RELOAD_DELAY_MS);
  };
  const watcher = watch("config", (_eventType, filename) => {
    const name = filename?.toString();
    if (name?.endsWith(".toml")) {
      scheduleReload();
    }
  });
  watcher.on("error", (error) => logger.warn("miz", "configuration watcher stopped", error));

  logger.info("miz", "configuration auto-reload enabled");
  return () => {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }
    watcher.close();
  };
};

const prepareVtbSubscriptions = async (
  config: Awaited<ReturnType<typeof loadConfig>>,
  gateway: Gateway,
  logger: Logger,
) : Promise<Awaited<ReturnType<typeof loadConfig>>> => {
  if (!config.vtb.enabled) {
    return config;
  }

  try {
    const groupList = await gateway.getGroupList();
    if (!Array.isArray(groupList)) {
      logger.warn("plugin", "vtb subscription availability check skipped: invalid group list response");
      return config;
    }

    const groupIds = new Set(getGroupIds(groupList).map(String));
    const { enabled, disabled } = partitionAvailableVtbSubscriptions(config.vtb.subscriptions, groupIds);
    for (const subscription of disabled) {
      logger.warn("plugin", "vtb subscription temporarily disabled: bot is not in the group", {
        groupId: subscription.groupId,
        streamers: subscription.streamers,
      });
    }
    return { ...config, vtb: { ...config.vtb, subscriptions: enabled } };
  } catch (error) {
    logger.warn("plugin", "vtb subscription availability check failed; keeping all subscriptions enabled", error);
  }
  return config;
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

const logger = createLogger();

main().catch((error) => {
  logger.error("miz", "failed to start", error);
  process.exit(1);
});
