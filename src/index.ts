import { loadConfig } from "@/config";
import { createGateway, type Gateway } from "@/gateway";
import { createLogger, type Logger } from "@/logger";
import { createPluginRuntime } from "@/plugins";
import { startScheduledTasks, type TaskRuntime } from "@/tasks";

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
  const config = await loadConfig();
  const logger = createLogger(config.naplink.logLevel);
  const gateway = createGateway(config, logger);
  const plugins = await createPluginRuntime(config, gateway, logger);

  gateway.onMessage(plugins.handleMessage);

  logger.info("miz", `connecting to ${config.gateway.url}`);

  await gateway.connect();
  await gateway.reportServerInfo();

  const tasks = await startScheduledTasks(config, gateway, logger);
  registerShutdownHandlers(gateway, tasks, logger);
};

const logger = createLogger();

main().catch((error) => {
  logger.error("miz", "failed to start", error);
  process.exit(1);
});
