import cron from "node-cron";
import type { Logger } from "@/logger";

const CRON_EXECUTION_TOLERANCE_MS = 10_000;

export type ScheduledTaskRuntime = {
  stop(): Promise<void>;
};

type ExclusiveCronTaskOptions = {
  cronExpression: string;
  taskName: string;
} & ExclusiveTaskOptions;

type ExclusiveTaskOptions = {
  logger: Logger;
  run(): Promise<void>;
  skippedMessage?: string;
  failureMessage: string;
  shutdownFailureMessage: string;
};

export type ExclusiveTaskRunner = {
  start(): void;
  stop(): Promise<void>;
};

/**
 * Creates a cron task that never overlaps executions and drains the active run
 * during shutdown. Feature-specific validation and startup logging stay with
 * the caller, while concurrency and lifecycle behavior remain consistent.
 */
export const createExclusiveCronTask = ({
  cronExpression,
  taskName,
  ...taskOptions
}: ExclusiveCronTaskOptions): ScheduledTaskRuntime => {
  const runner = createExclusiveTaskRunner(taskOptions);
  const task = cron.createTask(cronExpression, runner.start, {
    name: taskName,
    missedExecutionTolerance: CRON_EXECUTION_TOLERANCE_MS,
  });
  task.on("execution:missed", ({ date, triggeredAt }) => {
    taskOptions.logger.warn("plugin", `${taskName} missed its cron slot; running catch-up`, {
      cronExpression,
      scheduledAt: date.toISOString(),
      delayMs: Math.max(0, triggeredAt.getTime() - date.getTime()),
    });
    runner.start();
  });
  void task.start();
  return {
    stop: async () => {
      await task.stop();
      await runner.stop();
    },
  };
};

export const createExclusiveTaskRunner = ({
  logger,
  run,
  skippedMessage,
  failureMessage,
  shutdownFailureMessage,
}: ExclusiveTaskOptions): ExclusiveTaskRunner => {
  let currentRun: Promise<void> | undefined;
  let stopping = false;

  const startRun = () => {
    if (stopping) {
      return;
    }
    if (currentRun) {
      if (skippedMessage) {
        logger.warn("plugin", skippedMessage);
      }
      return;
    }

    const execution = Promise.resolve().then(run);
    const trackedRun = execution.finally(() => {
      if (currentRun === trackedRun) {
        currentRun = undefined;
      }
    });
    currentRun = trackedRun;
    void currentRun.catch((error) => logger.error("plugin", failureMessage, error));
  };

  return {
    start: startRun,
    stop: async () => {
      stopping = true;
      await currentRun?.catch((error) => logger.warn("plugin", shutdownFailureMessage, error));
    },
  };
};
