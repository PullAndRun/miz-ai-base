import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "@/logger";

const DEFAULT_RELOAD_DELAY_MS = 500;
const DEFAULT_RECONCILIATION_INTERVAL_MS = 5_000;
const DEFAULT_WATCH_RESTART_DELAY_MS = 1_000;
const DEFAULT_APPLICATION_RETRY_DELAY_MS = 5_000;

type ConfigWatcherOptions<T> = {
  directory?: string;
  loadConfig(): Promise<T>;
  logger: Logger;
  onReloaded(config: T): Promise<void>;
  reloadDelayMs?: number;
  reconciliationIntervalMs?: number;
  watchRestartDelayMs?: number;
  applicationRetryDelayMs?: number;
  nativeWatch?: boolean;
  reloadOnStart?: boolean;
};

/**
 * Watches TOML files for low-latency reloads and independently reconciles a
 * content fingerprint. fs.watch is intentionally only the fast path: events
 * can be coalesced, omit filenames, or stop after an OS/filesystem error.
 */
export const createConfigWatcher = async <T>({
  directory = "config",
  loadConfig,
  logger,
  onReloaded,
  reloadDelayMs = DEFAULT_RELOAD_DELAY_MS,
  reconciliationIntervalMs = DEFAULT_RECONCILIATION_INTERVAL_MS,
  watchRestartDelayMs = DEFAULT_WATCH_RESTART_DELAY_MS,
  applicationRetryDelayMs = DEFAULT_APPLICATION_RETRY_DELAY_MS,
  nativeWatch = true,
  reloadOnStart = false,
}: ConfigWatcherOptions<T>) => {
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let watcherRestartTimer: ReturnType<typeof setTimeout> | undefined;
  let applicationRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  let activeReload: Promise<void> | undefined;
  let reloading = false;
  let reloadQueued = false;
  let stopped = false;
  let scanning = false;
  let lastFingerprint = await getConfigFingerprint(directory);
  const changedFiles = new Set<string>();

  const readFingerprint = async () => {
    try {
      return await getConfigFingerprint(directory);
    } catch (error) {
      logger.warn("miz", "configuration fingerprint refresh failed", error);
      return lastFingerprint;
    }
  };

  const reload = async () => {
    if (stopped) return;
    if (reloading) {
      reloadQueued = true;
      return;
    }

    reloading = true;
    const reloadedFiles = [...changedFiles];
    changedFiles.clear();
    const reloadedFingerprint = await readFingerprint();
    let nextConfig: T;
    try {
      nextConfig = await loadConfig();
    } catch (error) {
      logger.warn("miz", "configuration reload failed validation; keeping the current runtime", error);
      lastFingerprint = reloadedFingerprint;
      await reconcile();
      reloading = false;
      if (reloadQueued && !stopped) {
        reloadQueued = false;
        startReload();
      }
      return;
    }

    try {
      await onReloaded(nextConfig);
      if (applicationRetryTimer) {
        clearTimeout(applicationRetryTimer);
        applicationRetryTimer = undefined;
      }
      logger.info("miz", "configuration hot-reloaded", { files: reloadedFiles });
    } catch (error) {
      logger.warn("miz", "configuration runtime reload failed; restored the previous runtime and scheduled a retry", error);
      if (!applicationRetryTimer && !stopped) {
        applicationRetryTimer = setTimeout(() => {
          applicationRetryTimer = undefined;
          scheduleReload("<runtime application retry>");
        }, applicationRetryDelayMs);
      }
    } finally {
      lastFingerprint = reloadedFingerprint;
      await reconcile();
      reloading = false;
      if (reloadQueued && !stopped) {
        reloadQueued = false;
        startReload();
      }
    }
  };

  const startReload = () => {
    if (stopped) return;
    if (reloading) {
      reloadQueued = true;
      return;
    }
    const execution = reload();
    activeReload = execution;
    void execution.finally(() => {
      if (activeReload === execution) activeReload = undefined;
    });
  };

  const scheduleReload = (filename: string) => {
    if (stopped) return;
    changedFiles.add(filename);
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      startReload();
    }, reloadDelayMs);
  };

  const startNativeWatcher = () => {
    if (!nativeWatch || stopped || watcher) return;
    try {
      const activeWatcher = watch(directory, (_eventType, filename) => {
        const name = filename?.toString();
        if (name === undefined || name.endsWith(".toml")) {
          scheduleReload(name ?? "<unknown TOML change>");
        }
      });
      watcher = activeWatcher;
      activeWatcher.on("error", (error) => {
        if (watcher !== activeWatcher || stopped) return;
        watcher = undefined;
        activeWatcher.close();
        logger.warn("miz", "configuration watcher stopped; scheduling restart", error);
        watcherRestartTimer = setTimeout(() => {
          watcherRestartTimer = undefined;
          startNativeWatcher();
        }, watchRestartDelayMs);
      });
    } catch (error) {
      logger.warn("miz", "configuration watcher failed to start; scheduling restart", error);
      watcherRestartTimer = setTimeout(() => {
        watcherRestartTimer = undefined;
        startNativeWatcher();
      }, watchRestartDelayMs);
    }
  };

  const reconcile = async () => {
    if (stopped || scanning) return;
    scanning = true;
    try {
      const fingerprint = await getConfigFingerprint(directory);
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        scheduleReload("<fingerprint reconciliation>");
      }
    } catch (error) {
      logger.warn("miz", "configuration fingerprint reconciliation failed", error);
    } finally {
      scanning = false;
    }
  };

  startNativeWatcher();
  const reconciliationTimer = setInterval(() => void reconcile(), reconciliationIntervalMs);
  reconciliationTimer.unref?.();
  logger.info("miz", "configuration auto-reload enabled", {
    reconciliationIntervalMs,
  });
  if (reloadOnStart) scheduleReload("<startup reconciliation>");

  return async () => {
    stopped = true;
    if (reloadTimer) clearTimeout(reloadTimer);
    if (watcherRestartTimer) clearTimeout(watcherRestartTimer);
    if (applicationRetryTimer) clearTimeout(applicationRetryTimer);
    clearInterval(reconciliationTimer);
    watcher?.close();
    await activeReload;
  };
};

const getConfigFingerprint = async (directory: string) => {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".toml"))
    .sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(path.join(directory, name)));
    hash.update("\0");
  }
  return hash.digest("hex");
};
