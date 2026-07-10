import { loadConfig } from "@/config";
import { createGateway, type Gateway } from "@/gateway";
import { createLogger, type Logger } from "@/logger";
import { createPluginRuntime } from "@/plugins";
import { startScheduledTasks, type TaskRuntime } from "@/tasks";

const registerShutdownHandlers = (gateway: Gateway, tasks: TaskRuntime, logger: Logger) => {
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    logger.info("miz", `received ${signal}, shutting down`);
    tasks.stop();
    gateway.dispose();
    process.exit(0);
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
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
