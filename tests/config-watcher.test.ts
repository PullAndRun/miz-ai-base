import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConfigWatcher } from "@/config-watcher";
import type { Logger } from "@/logger";

const createTestLogger = () => {
  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (_context, message) => warnings.push(message),
    error: () => undefined,
  };
  return { logger, warnings };
};

const waitFor = async (condition: () => boolean, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for configuration reload");
    await Bun.sleep(10);
  }
};

describe("configuration watcher", () => {
  test("reconciles once after startup so changes during runtime construction are not lost", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "miz-config-start-"));
    const configPath = path.join(directory, "app.toml");
    await writeFile(configPath, "startup-revision");
    const applied: string[] = [];
    const { logger } = createTestLogger();
    const stop = await createConfigWatcher({
      directory,
      nativeWatch: false,
      reloadOnStart: true,
      reloadDelayMs: 5,
      reconciliationIntervalMs: 50,
      logger,
      loadConfig: () => readFile(configPath, "utf8"),
      onReloaded: async (config) => { applied.push(config); },
    });

    try {
      await waitFor(() => applied.includes("startup-revision"));
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reconciles a changed TOML file even when native watch emits no event", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "miz-config-watch-"));
    const configPath = path.join(directory, "app.toml");
    await writeFile(configPath, "value = 1\n");
    const applied: string[] = [];
    const { logger } = createTestLogger();
    const stop = await createConfigWatcher({
      directory,
      nativeWatch: false,
      reconciliationIntervalMs: 20,
      reloadDelayMs: 5,
      logger,
      loadConfig: () => readFile(configPath, "utf8"),
      onReloaded: async (config) => { applied.push(config); },
    });

    try {
      await writeFile(configPath, "value = 2\n");
      await waitFor(() => applied.includes("value = 2\n"));
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("recovers after an invalid change and applies the next valid revision", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "miz-config-recover-"));
    const configPath = path.join(directory, "app.toml");
    await writeFile(configPath, "valid-1");
    const applied: string[] = [];
    const { logger, warnings } = createTestLogger();
    const stop = await createConfigWatcher({
      directory,
      nativeWatch: false,
      reconciliationIntervalMs: 20,
      reloadDelayMs: 5,
      logger,
      loadConfig: async () => {
        const value = await readFile(configPath, "utf8");
        if (value.startsWith("invalid")) throw new Error("invalid config");
        return value;
      },
      onReloaded: async (config) => { applied.push(config); },
    });

    try {
      await writeFile(configPath, "invalid-2");
      await waitFor(() => warnings.some((message) => message.includes("failed validation")));
      await writeFile(configPath, "valid-3");
      await waitFor(() => applied.includes("valid-3"));
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("retries a valid revision when applying the new runtime fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "miz-config-apply-"));
    const configPath = path.join(directory, "app.toml");
    await writeFile(configPath, "revision-1");
    let attempts = 0;
    const applied: string[] = [];
    const { logger } = createTestLogger();
    const stop = await createConfigWatcher({
      directory,
      nativeWatch: false,
      reconciliationIntervalMs: 20,
      reloadDelayMs: 5,
      applicationRetryDelayMs: 20,
      logger,
      loadConfig: () => readFile(configPath, "utf8"),
      onReloaded: async (config) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient runtime failure");
        applied.push(config);
      },
    });

    try {
      await writeFile(configPath, "revision-2");
      await waitFor(() => applied.includes("revision-2"));
      expect(attempts).toBe(2);
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not lose a second revision written while the first is applying", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "miz-config-race-"));
    const configPath = path.join(directory, "app.toml");
    await writeFile(configPath, "revision-1");
    const applied: string[] = [];
    const { logger } = createTestLogger();
    const stop = await createConfigWatcher({
      directory,
      nativeWatch: false,
      reconciliationIntervalMs: 20,
      reloadDelayMs: 5,
      logger,
      loadConfig: () => readFile(configPath, "utf8"),
      onReloaded: async (config) => {
        applied.push(config);
        if (config === "revision-2") await writeFile(configPath, "revision-3");
      },
    });

    try {
      await writeFile(configPath, "revision-2");
      await waitFor(() => applied.includes("revision-3"));
      expect(applied).toEqual(["revision-2", "revision-3"]);
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
