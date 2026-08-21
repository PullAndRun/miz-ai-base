import { loadConfig } from "@/config";
import { createConfigWatcher } from "@/config-watcher";
import { ensureProjectDirectories } from "@/directories";
import { createGateway, type Gateway } from "@/gateway";
import { getGroupIds } from "@/group-ids";
import { createLogger, type Logger } from "@/logger";
import { createPluginRuntime } from "@/plugins";
import { configureBilibiliCredentialStore } from "@/bilibili-credential";
import { getDatabaseUrl } from "@/database";
import { requiresGatewayRestart, requiresRuntimeReload } from "@/runtime-config";
import { replaceRuntimeWithFallback, type RuntimeReplacement } from "@/runtime-reload";
import { startScheduledTasks } from "@/tasks";
import { cleanupStaleVideoArtifacts } from "@/video";
import { closeVtbRepository, partitionAvailableVtbSubscriptions, syncConfiguredVtbStreamers } from "@/vtb";

type AppRuntime = {
  config: Awaited<ReturnType<typeof loadConfig>>;
  gateway: Gateway;
  stopFeatures(): Promise<void>;
  stop(): Promise<void>;
};

const registerShutdownHandlers = (
  getRuntime: () => AppRuntime,
  stopConfigWatcher: () => Promise<void>,
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
      await stopConfigWatcher();
      await getRuntime().stop();
    } catch (error) {
      logger.error("miz", "scheduled tasks failed to stop cleanly", error);
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
};

const main = async (logger: Logger) => {
  const createdDirectories = await ensureProjectDirectories();
  const loadedConfig = await loadConfig();
  configureBilibiliCredentialStore(getDatabaseUrl(loadedConfig));
  logger.setLevel?.(loadedConfig.naplink.logLevel);
  if (createdDirectories.length > 0) {
    logger.info("miz", "created missing project directories", { directories: createdDirectories });
  }
  if (loadedConfig.video.enabled) {
    try {
      const removedArtifacts = await cleanupStaleVideoArtifacts(loadedConfig.video);
      if (removedArtifacts.length > 0) {
        logger.info("miz", "removed stale video artifacts", { count: removedArtifacts.length });
      }
    } catch (error) {
      logger.warn("miz", "stale video artifact cleanup failed", error);
    }
  }
  let runtime = await createConnectedAppRuntime(loadedConfig, logger);
  const stopConfigWatcher = await createConfigWatcher({
    loadConfig,
    logger,
    onReloaded: async (nextConfig) => {
      if (!requiresRuntimeReload(runtime.config, nextConfig)) return;
      const result = await replaceAppRuntime(runtime, nextConfig, logger);
      runtime = result.runtime;
      if (!result.applied) throw result.error;
    },
    reloadOnStart: true,
  });
  registerShutdownHandlers(() => runtime, stopConfigWatcher, logger);
};

const createFeatureRuntime = async (
  loadedConfig: Awaited<ReturnType<typeof loadConfig>>,
  gateway: Gateway,
  logger: Logger,
): Promise<Pick<AppRuntime, "stopFeatures">> => {
  let detachPluginHandler: (() => void) | undefined;
  let taskRuntime: Awaited<ReturnType<typeof startScheduledTasks>> | undefined;

  try {
    const config = await prepareVtbSubscriptions(loadedConfig, gateway, logger);
    await syncConfiguredVtbStreamersOnStartup(config, logger);
    const plugins = await createPluginRuntime(config, gateway, logger);
    const tasks = await startScheduledTasks(config, gateway, logger);
    taskRuntime = tasks;
    const detach = gateway.onMessage(plugins.handleMessage);
    detachPluginHandler = detach;
    let stopPromise: Promise<void> | undefined;
    return {
      stopFeatures: () => {
        stopPromise ??= (async () => {
          detach();
          await plugins.stop();
          await tasks.stop();
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    detachPluginHandler?.();
    if (taskRuntime) {
      await taskRuntime.stop().catch((stopError) => {
        logger.warn("plugin", "scheduled tasks failed to stop after runtime startup error", stopError);
      });
    } else {
      await closeVtbRepository().catch((closeError) => {
        logger.warn("plugin", "database connection failed to close after runtime startup error", closeError);
      });
    }
    throw error;
  }
};

const createConnectedAppRuntime = async (
  config: Awaited<ReturnType<typeof loadConfig>>,
  logger: Logger,
): Promise<AppRuntime> => {
  logger.setLevel?.(config.naplink.logLevel);
  const gateway = createGateway(config, logger);
  try {
    logger.info("miz", `connecting to ${config.gateway.url}`);
    await gateway.connect();
    await gateway.reportServerInfo();
    const features = await createFeatureRuntime(config, gateway, logger);
    return createManagedAppRuntime(config, gateway, features.stopFeatures);
  } catch (error) {
    gateway.dispose();
    throw error;
  }
};

const createManagedAppRuntime = (
  config: Awaited<ReturnType<typeof loadConfig>>,
  gateway: Gateway,
  stopFeatures: () => Promise<void>,
): AppRuntime => {
  let stopPromise: Promise<void> | undefined;
  return {
    config,
    gateway,
    stopFeatures,
    stop: () => {
      stopPromise ??= (async () => {
        let failure: unknown;
        try {
          await stopFeatures();
        } catch (error) {
          failure = error;
        } finally {
          gateway.dispose();
        }
        if (failure) throw failure;
      })();
      return stopPromise;
    },
  };
};

const replaceAppRuntime = async (
  previous: AppRuntime,
  nextConfig: Awaited<ReturnType<typeof loadConfig>>,
  logger: Logger,
): Promise<RuntimeReplacement<AppRuntime>> => {
  const gatewayChanged = requiresGatewayRestart(previous.config, nextConfig);
  if (gatewayChanged) {
    return replaceRuntimeWithFallback({
      stopPrevious: previous.stop,
      createNext: () => createConnectedAppRuntime(nextConfig, logger),
      restorePrevious: () => {
        logger.setLevel?.(previous.config.naplink.logLevel);
        return createConnectedAppRuntime(previous.config, logger);
      },
      onStopError: (error) => logger.warn(
        "miz",
        "application runtime did not stop cleanly before configuration reload",
        error,
      ),
    });
  }

  return replaceRuntimeWithFallback({
    stopPrevious: previous.stopFeatures,
    createNext: async () => {
      logger.setLevel?.(nextConfig.naplink.logLevel);
      const features = await createFeatureRuntime(nextConfig, previous.gateway, logger);
      return createManagedAppRuntime(nextConfig, previous.gateway, features.stopFeatures);
    },
    restorePrevious: async () => {
      logger.setLevel?.(previous.config.naplink.logLevel);
      const features = await createFeatureRuntime(previous.config, previous.gateway, logger);
      return createManagedAppRuntime(previous.config, previous.gateway, features.stopFeatures);
    },
    onStopError: (error) => logger.warn(
      "miz",
      "feature runtime did not stop cleanly before configuration reload",
      error,
    ),
  });
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

main(logger).catch((error) => {
  logger.error("miz", "failed to start", error);
  process.exit(1);
});
