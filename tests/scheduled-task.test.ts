import { describe, expect, test } from "bun:test";
import type { Logger } from "@/logger";
import { createExclusiveTaskRunner } from "@/scheduled-task";

const createTestLogger = () => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (_context, message) => warnings.push(message),
    error: (_context, message) => errors.push(message),
  };
  return { logger, warnings, errors };
};

describe("exclusive task lifecycle", () => {
  test("prevents overlapping runs and drains the active execution", async () => {
    const { logger, warnings } = createTestLogger();
    let finishRun: (() => void) | undefined;
    let runs = 0;
    const runner = createExclusiveTaskRunner({
      logger,
      run: async () => {
        runs += 1;
        await new Promise<void>((resolve) => {
          finishRun = resolve;
        });
      },
      skippedMessage: "skipped",
      failureMessage: "failed",
      shutdownFailureMessage: "shutdown failed",
    });

    runner.start();
    await Promise.resolve();
    runner.start();
    expect(runs).toBe(1);
    expect(warnings).toEqual(["skipped"]);

    const stopping = runner.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBeFalse();
    finishRun?.();
    await stopping;
    expect(stopped).toBeTrue();
    runner.start();
    await Promise.resolve();
    expect(runs).toBe(1);
  });
});
