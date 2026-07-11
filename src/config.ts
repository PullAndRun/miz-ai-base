import { z } from "zod";
import { rename, rm } from "node:fs/promises";

const logLevelSchema = z.enum(["debug", "info", "warn", "error", "off"]);
const nonEmptyStringSchema = z.string().trim().min(1);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const targetIdSchema = z.union([z.string().trim().min(1), z.number().int().nonnegative()]);
const runtimeModeSchema = z.enum(["normal", "docker"]);
const ff14RegionKeySchema = z.enum(["猫", "猪", "狗", "鸟"]);

const rawMizConfigSchema = z.object({
  gateway: z.object({
    url: nonEmptyStringSchema,
    accessToken: nonEmptyStringSchema,
  }),
  postgresql: z.object({
    url: nonEmptyStringSchema,
    database: nonEmptyStringSchema,
    username: nonEmptyStringSchema,
    password: nonEmptyStringSchema,
  }),
  naplink: z
    .object({
      logLevel: logLevelSchema.optional(),
      connectTimeoutMs: nonNegativeIntegerSchema.optional(),
      pingIntervalMs: nonNegativeIntegerSchema.optional(),
      apiTimeoutMs: nonNegativeIntegerSchema.optional(),
      apiRetries: nonNegativeIntegerSchema.optional(),
      reconnectMaxAttempts: nonNegativeIntegerSchema.optional(),
    })
    .optional(),
  plugins: z
    .object({
      commandPrefix: nonEmptyStringSchema.optional(),
      directory: nonEmptyStringSchema.optional(),
    })
    .optional(),
  network: z
    .object({
      proxyUrl: nonEmptyStringSchema.optional(),
    })
    .optional(),
  bilibili: z
    .object({
      cookie: z.string().optional(),
    })
    .optional(),
  ff14: z
    .object({
      priceAlertEnabled: z.boolean().optional(),
      priceAlertCron: nonEmptyStringSchema.optional(),
      maxListingCount: z.number().int().positive().optional(),
      itemSearchApiUrl: nonEmptyStringSchema.optional(),
      marketApiUrl: nonEmptyStringSchema.optional(),
      priceAlerts: z
        .array(
          z.object({
            groupId: targetIdSchema,
            region: ff14RegionKeySchema,
            itemName: nonEmptyStringSchema,
            minimumPrice: nonNegativeIntegerSchema,
          }),
        )
        .optional(),
    })
    .optional(),
  wallpaper: z
    .object({
      enabled: z.boolean().optional(),
      cron: nonEmptyStringSchema.optional(),
      apiUrl: nonEmptyStringSchema.optional(),
      imageBaseUrl: nonEmptyStringSchema.optional(),
    })
    .optional(),
  news: z
    .object({
      enabled: z.boolean().optional(),
      cron: nonEmptyStringSchema.optional(),
      groupIds: z.array(targetIdSchema).optional(),
      apiUrl: nonEmptyStringSchema.optional(),
    })
    .optional(),
  reminder: z
    .object({
      enabled: z.boolean().optional(),
      cron: nonEmptyStringSchema.optional(),
      batchSize: z.number().int().positive().max(100).optional(),
      manageWhitelistUserIds: z.array(targetIdSchema).optional(),
    })
    .optional(),
  schedule: z
    .object({
      enabled: z.boolean().optional(),
      cron: nonEmptyStringSchema.optional(),
      reminderMinutes: z.number().int().positive().max(10_080).optional(),
      batchSize: z.number().int().positive().max(100).optional(),
      manageWhitelistUserIds: z.array(targetIdSchema).optional(),
    })
    .optional(),
  broadcast: z
    .object({
      whitelistUserIds: z.array(targetIdSchema).optional(),
    })
    .optional(),
  video: z
    .object({
      enabled: z.boolean().optional(),
      whitelistUserIds: z.array(targetIdSchema).optional(),
      downloadDirectory: nonEmptyStringSchema.optional(),
      napcatMediaDirectory: nonEmptyStringSchema.optional(),
      ytDlpLinuxPath: nonEmptyStringSchema.optional(),
      ytDlpWindowsPath: nonEmptyStringSchema.optional(),
      ffmpegLinuxPath: nonEmptyStringSchema.optional(),
      ffmpegWindowsPath: nonEmptyStringSchema.optional(),
      updateCron: nonEmptyStringSchema.optional(),
    })
    .optional(),
  vtb: z
    .object({
      enabled: z.boolean().optional(),
      cron: nonEmptyStringSchema.optional(),
      userApiUrl: nonEmptyStringSchema.optional(),
      cardApiUrl: nonEmptyStringSchema.optional(),
      liveApiUrl: nonEmptyStringSchema.optional(),
      dynamicApiUrl: nonEmptyStringSchema.optional(),
      nameSyncCron: nonEmptyStringSchema.optional(),
      syncWhitelistUserIds: z.array(targetIdSchema).optional(),
      subscriptionWhitelistUserIds: z.array(targetIdSchema).optional(),
      subscriptions: z
        .array(
          z.object({
            groupId: targetIdSchema,
            streamers: z.array(nonEmptyStringSchema).min(1),
          }),
        )
        .optional(),
    })
    .optional(),
});

const mizConfigSchema = rawMizConfigSchema.transform((config) => ({
  runtime: {
    mode: getRuntimeMode(),
  },
  gateway: config.gateway,
  postgresql: config.postgresql,
  naplink: {
    logLevel: config.naplink?.logLevel ?? "info",
    connectTimeoutMs: config.naplink?.connectTimeoutMs ?? 30_000,
    pingIntervalMs: config.naplink?.pingIntervalMs ?? 30_000,
    apiTimeoutMs: config.naplink?.apiTimeoutMs ?? 30_000,
    apiRetries: config.naplink?.apiRetries ?? 3,
    reconnectMaxAttempts: config.naplink?.reconnectMaxAttempts ?? 10,
  },
  plugins: {
    commandPrefix: config.plugins?.commandPrefix ?? "miz",
    directory: config.plugins?.directory ?? "plugins",
  },
  network: {
    proxyUrl: config.network?.proxyUrl ?? "",
  },
  bilibili: {
    cookie: config.bilibili?.cookie?.trim() ?? "",
  },
  ff14: {
    priceAlertEnabled: config.ff14?.priceAlertEnabled ?? true,
    priceAlertCron: config.ff14?.priceAlertCron ?? "0 * * * *",
    maxListingCount: config.ff14?.maxListingCount ?? 10,
    itemSearchApiUrl: config.ff14?.itemSearchApiUrl ?? "",
    marketApiUrl: config.ff14?.marketApiUrl ?? "",
    priceAlerts: config.ff14?.priceAlerts ?? [],
  },
  wallpaper: {
    enabled: config.wallpaper?.enabled ?? true,
    cron: config.wallpaper?.cron ?? "0 7 * * *",
    apiUrl:
      config.wallpaper?.apiUrl ?? "",
    imageBaseUrl: config.wallpaper?.imageBaseUrl ?? "",
  },
  news: {
    enabled: config.news?.enabled ?? true,
    cron: config.news?.cron ?? "*/5 * * * *",
    groupIds: config.news?.groupIds ?? [],
    apiUrl: config.news?.apiUrl ?? "",
  },
  reminder: {
    enabled: config.reminder?.enabled ?? true,
    cron: config.reminder?.cron ?? "* * * * *",
    batchSize: config.reminder?.batchSize ?? 20,
    manageWhitelistUserIds: config.reminder?.manageWhitelistUserIds ?? [],
  },
  schedule: {
    enabled: config.schedule?.enabled ?? true,
    cron: config.schedule?.cron ?? "* * * * *",
    reminderMinutes: config.schedule?.reminderMinutes ?? 30,
    batchSize: config.schedule?.batchSize ?? 20,
    manageWhitelistUserIds: config.schedule?.manageWhitelistUserIds ?? [],
  },
  broadcast: {
    whitelistUserIds: config.broadcast?.whitelistUserIds ?? [],
  },
  video: {
    enabled: config.video?.enabled ?? true,
    runtimeMode: getRuntimeMode(),
    proxyUrl: config.network?.proxyUrl ?? "",
    bilibiliCookie: config.bilibili?.cookie?.trim() ?? "",
    whitelistUserIds: config.video?.whitelistUserIds ?? [],
    downloadDirectory: config.video?.downloadDirectory ?? "/temp",
    napcatMediaDirectory: config.video?.napcatMediaDirectory ?? "/app/media",
    ytDlpLinuxPath: config.video?.ytDlpLinuxPath ?? "",
    ytDlpWindowsPath: config.video?.ytDlpWindowsPath ?? "",
    ffmpegLinuxPath: config.video?.ffmpegLinuxPath ?? "tools/ffmpeg",
    ffmpegWindowsPath: config.video?.ffmpegWindowsPath ?? "tools/ffmpeg.exe",
    updateCron: config.video?.updateCron ?? "0 0 * * *",
  },
  vtb: {
    enabled: config.vtb?.enabled ?? true,
    cron: config.vtb?.cron ?? "*/3 * * * *",
    userApiUrl: config.vtb?.userApiUrl ?? "",
    cardApiUrl: config.vtb?.cardApiUrl ?? "",
    liveApiUrl: config.vtb?.liveApiUrl ?? "",
    dynamicApiUrl: config.vtb?.dynamicApiUrl ?? "",
    nameSyncCron: config.vtb?.nameSyncCron ?? "0 0 * * 0",
    syncWhitelistUserIds: config.vtb?.syncWhitelistUserIds ?? [],
    subscriptionWhitelistUserIds: config.vtb?.subscriptionWhitelistUserIds ?? [],
    bilibiliCookie: config.bilibili?.cookie?.trim() ?? "",
    subscriptions: config.vtb?.subscriptions ?? [],
  },
}));

const appConfigSchema = z.object({
  miz: mizConfigSchema,
});

export type LogLevel = z.infer<typeof logLevelSchema>;
export type RuntimeMode = z.infer<typeof runtimeModeSchema>;
export type RuntimeConfig = {
  mode: RuntimeMode;
};
export type WallpaperConfig = {
  enabled: boolean;
  cron: string;
  apiUrl: string;
  imageBaseUrl: string;
};

export type NewsConfig = {
  enabled: boolean;
  cron: string;
  groupIds: Array<string | number>;
  apiUrl: string;
};

export type ReminderConfig = {
  enabled: boolean;
  cron: string;
  batchSize: number;
  manageWhitelistUserIds: Array<string | number>;
};

export type ScheduleConfig = {
  enabled: boolean;
  cron: string;
  reminderMinutes: number;
  batchSize: number;
  manageWhitelistUserIds: Array<string | number>;
};

export type BroadcastConfig = {
  whitelistUserIds: Array<string | number>;
};

export type NetworkConfig = {
  proxyUrl: string;
};

export type BilibiliConfig = {
  cookie: string;
};

export type VideoConfig = {
  enabled: boolean;
  runtimeMode: RuntimeMode;
  proxyUrl: string;
  bilibiliCookie: string;
  whitelistUserIds: Array<string | number>;
  downloadDirectory: string;
  napcatMediaDirectory: string;
  ytDlpLinuxPath: string;
  ytDlpWindowsPath: string;
  ffmpegLinuxPath: string;
  ffmpegWindowsPath: string;
  updateCron: string;
};

export type VtbConfig = {
  enabled: boolean;
  cron: string;
  userApiUrl: string;
  cardApiUrl: string;
  liveApiUrl: string;
  dynamicApiUrl: string;
  nameSyncCron: string;
  syncWhitelistUserIds: Array<string | number>;
  subscriptionWhitelistUserIds: Array<string | number>;
  bilibiliCookie: string;
  subscriptions: ReadonlyArray<{
    readonly groupId: string | number;
    readonly streamers: readonly string[];
  }>;
};

// Keep normalized optional sections explicit for plugin consumers. Besides
// documenting the runtime contract, this prevents editor type servers from
// losing transform output fields such as `wallpaper` during incremental checks.
export type MizConfig = z.infer<typeof mizConfigSchema> & {
  runtime: RuntimeConfig;
  network: NetworkConfig;
  bilibili: BilibiliConfig;
  wallpaper: WallpaperConfig;
  news: NewsConfig;
  reminder: ReminderConfig;
  schedule: ScheduleConfig;
  broadcast: BroadcastConfig;
  video: VideoConfig;
  vtb: VtbConfig;
};

const getRuntimeMode = (): RuntimeMode => runtimeModeSchema.parse(process.env.MIZ_RUNTIME_MODE ?? "normal");

const CONFIG_PATH = "config/app.toml";
const LOCAL_CONFIG_PATH = "config/app.local.toml";
const DOCKER_CONFIG_PATH = "config/app.docker.toml";
const FF14_CONFIG_PATH = "config/ff14.toml";
const VTB_CONFIG_PATH = "config/vtb.toml";
let vtbSubscriptionUpdateQueue = Promise.resolve();

export const loadConfig = async (): Promise<MizConfig> => {
  const configFile = Bun.file(CONFIG_PATH);
  if (!(await configFile.exists())) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }

  const normalConfig = mergeConfig(
    mergeConfig(
      mergeConfig(
        Bun.TOML.parse(await configFile.text()),
        await loadOptionalConfig(FF14_CONFIG_PATH),
      ),
      await loadOptionalConfig(VTB_CONFIG_PATH),
    ),
    await loadOptionalConfig(LOCAL_CONFIG_PATH),
  );
  const source = getRuntimeMode() === "docker"
    ? mergeConfig(normalConfig, await loadDockerConfig())
    : normalConfig;
  return appConfigSchema.parse(source).miz;
};

export const updateVtbSubscriptionNames = (renames: ReadonlyMap<string, string>) => {
  return queueVtbSubscriptionUpdate(() => writeVtbSubscriptionNames(renames));
};

export const addVtbSubscription = (groupId: string | number, streamerName: string) =>
  queueVtbSubscriptionUpdate(async () => {
    const source = await readVtbSubscriptionConfig();
    const subscription = findVtbSubscriptionBlock(source, groupId);
    if (!subscription) {
      const separator = getSubscriptionBlockSeparator(source);
      await writeVtbSubscriptionConfig(
        `${source}${separator}[[miz.vtb.subscriptions]]\ngroupId = ${JSON.stringify(groupId)}\nstreamers = ${JSON.stringify([streamerName])}\n`,
      );
      return { changed: true, streamers: [streamerName] };
    }

    if (subscription.streamers.includes(streamerName)) {
      return { changed: false, streamers: subscription.streamers };
    }

    const streamers = [...subscription.streamers, streamerName];
    await writeVtbSubscriptionConfig(replaceSubscriptionBlock(source, subscription, streamers));
    return { changed: true, streamers };
  });

export const removeVtbSubscription = (groupId: string | number, streamerName: string) =>
  queueVtbSubscriptionUpdate(async () => {
    const source = await readVtbSubscriptionConfig();
    const subscription = findVtbSubscriptionBlock(source, groupId);
    if (!subscription || !subscription.streamers.includes(streamerName)) {
      return { changed: false, streamers: subscription?.streamers ?? [] };
    }

    const streamers = subscription.streamers.filter((name) => name !== streamerName);
    const updated = streamers.length > 0
      ? replaceSubscriptionBlock(source, subscription, streamers)
      : `${source.slice(0, subscription.start)}${source.slice(subscription.end)}`;
    await writeVtbSubscriptionConfig(updated);
    return { changed: true, streamers };
  });

const writeVtbSubscriptionNames = async (renames: ReadonlyMap<string, string>) => {
  if (renames.size === 0) {
    return false;
  }

  const source = await readVtbSubscriptionConfig();
  let changed = false;
  const updated = source.replace(/^streamers[ \t]*=[ \t]*(\[[^\r\n]*\])[ \t]*$/gm, (line, value: string) => {
    const parsed = Bun.TOML.parse(`streamers = ${value}`) as { streamers?: unknown };
    if (!Array.isArray(parsed.streamers) || !parsed.streamers.every((name) => typeof name === "string")) {
      return line;
    }

    const names = parsed.streamers as string[];
    const nextNames = names.map((name) => renames.get(name) ?? name);
    if (nextNames.every((name, index) => name === names[index])) {
      return line;
    }

    changed = true;
    return `streamers = ${JSON.stringify(nextNames)}`;
  });

  if (changed) {
    await writeVtbSubscriptionConfig(updated);
  }

  return changed;
};

const queueVtbSubscriptionUpdate = <T>(operation: () => Promise<T>) => {
  const update = vtbSubscriptionUpdateQueue.then(operation);
  vtbSubscriptionUpdateQueue = update.then(
    () => undefined,
    () => undefined,
  );
  return update;
};

type VtbSubscriptionBlock = {
  start: number;
  end: number;
  text: string;
  streamers: string[];
};

const findVtbSubscriptionBlock = (source: string, groupId: string | number): VtbSubscriptionBlock | undefined => {
  const marker = "[[miz.vtb.subscriptions]]";
  let start = source.indexOf(marker);
  while (start >= 0) {
    const nextStart = source.indexOf(marker, start + marker.length);
    const end = nextStart >= 0 ? nextStart : source.length;
    const text = source.slice(start, end);
    const parsedGroupId = parseTomlAssignment(text, "groupId");
    if (String(parsedGroupId) === String(groupId)) {
      const streamers = parseTomlAssignment(text, "streamers");
      if (!Array.isArray(streamers) || !streamers.every((name) => typeof name === "string")) {
        throw new Error(`Invalid streamers for VTB subscription group ${groupId}`);
      }
      return { start, end, text, streamers };
    }
    start = nextStart;
  }

  return undefined;
};

const parseTomlAssignment = (source: string, key: string) => {
  const matched = new RegExp(`^${key}[ \\t]*=[ \\t]*(.+)$`, "m").exec(source)?.[1];
  return matched === undefined
    ? undefined
    : (Bun.TOML.parse(`${key} = ${matched}`) as Record<string, unknown>)[key];
};

const replaceSubscriptionBlock = (
  source: string,
  subscription: VtbSubscriptionBlock,
  streamers: readonly string[],
) => {
  const updatedBlock = subscription.text.replace(
    /^streamers[ \t]*=[ \t]*\[[^\r\n]*\][ \t]*$/m,
    `streamers = ${JSON.stringify(streamers)}`,
  );
  return `${source.slice(0, subscription.start)}${updatedBlock}${source.slice(subscription.end)}`;
};

const getSubscriptionBlockSeparator = (source: string) => {
  if (!source) {
    return "";
  }

  return source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : "\n\n";
};

const loadDockerConfig = async () => {
  const configFile = Bun.file(DOCKER_CONFIG_PATH);
  if (!(await configFile.exists())) {
    throw new Error(`Docker configuration file not found: ${DOCKER_CONFIG_PATH}`);
  }

  return Bun.TOML.parse(await configFile.text());
};

const loadOptionalConfig = async (path: string) => {
  const configFile = Bun.file(path);
  return (await configFile.exists()) ? Bun.TOML.parse(await configFile.text()) : {};
};

const readVtbSubscriptionConfig = async () => {
  const configFile = Bun.file(VTB_CONFIG_PATH);
  return (await configFile.exists()) ? configFile.text() : "";
};

const writeVtbSubscriptionConfig = async (source: string) => {
  const temporaryPath = `${VTB_CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    await Bun.write(temporaryPath, source);
    await rename(temporaryPath, VTB_CONFIG_PATH);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const mergeConfig = (base: unknown, override: unknown): Record<string, unknown> => {
  const baseRecord = asRecord(base);
  const overrideRecord = asRecord(override);
  const merged: Record<string, unknown> = { ...baseRecord };

  for (const [key, value] of Object.entries(overrideRecord)) {
    merged[key] = isRecord(baseRecord[key]) && isRecord(value)
      ? mergeConfig(baseRecord[key], value)
      : value;
  }

  return merged;
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error("Configuration root must be a table");
  }

  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
