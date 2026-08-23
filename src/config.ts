import { z } from "zod";
import { rename, rm } from "node:fs/promises";

const logLevelSchema = z.enum(["debug", "info", "warn", "error", "off"]);
const nonEmptyStringSchema = z.string().trim().min(1);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const targetIdSchema = z.union([z.string().trim().min(1), z.number().int().nonnegative()]);
const runtimeModeSchema = z.enum(["normal", "docker"]);
const ff14RegionKeySchema = z.enum(["猫", "猪", "狗", "鸟"]);
const ff14PriceAlertSchema = z.object({
  groupId: targetIdSchema,
  region: ff14RegionKeySchema,
  itemName: nonEmptyStringSchema,
  minimumPrice: nonNegativeIntegerSchema,
  priceAlertAtUserIds: z.array(targetIdSchema).optional(),
});

const rawMizConfigSchema = z.object({
  gateway: z.object({
    url: nonEmptyStringSchema,
    accessToken: nonEmptyStringSchema,
    followedGroupMemberId: targetIdSchema.optional(),
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
      ffmpegReleaseApiUrl: nonEmptyStringSchema.optional(),
      ytDlpReleaseApiUrl: nonEmptyStringSchema.optional(),
    })
    .optional(),
  ff14: z
    .object({
      priceAlertEnabled: z.boolean().optional(),
      priceAlertCron: nonEmptyStringSchema.optional(),
      maxListingCount: z.number().int().positive().optional(),
      itemSearchApiUrl: nonEmptyStringSchema.optional(),
      marketApiUrl: nonEmptyStringSchema.optional(),
      manageWhitelistUserIds: z.array(targetIdSchema).optional(),
      priceAlerts: z.array(ff14PriceAlertSchema).optional(),
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
  activity: z
    .object({
      enabled: z.boolean().optional(),
      cron: nonEmptyStringSchema.optional(),
      reminderMinutes: z.number().int().positive().max(10_080).optional(),
      batchSize: z.number().int().positive().max(100).optional(),
      maxParticipants: z.number().int().positive().max(200).optional(),
      manageWhitelistUserIds: z.array(targetIdSchema).optional(),
    })
    .optional(),
  faq: z
    .object({
      maxEntries: z.number().int().positive().max(1_000).optional(),
      maxAnswerLength: z.number().int().positive().max(4_000).optional(),
      manageWhitelistUserIds: z.array(targetIdSchema).optional(),
    })
    .optional(),
  todo: z
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
  recall: z
    .object({
      whitelistUserIds: z.array(targetIdSchema).optional(),
    })
    .optional(),
  video: z
    .object({
      enabled: z.boolean().optional(),
      whitelistUserIds: z.array(targetIdSchema).optional(),
      bilibiliHosts: z.array(nonEmptyStringSchema).min(1).optional(),
      downloadDirectory: nonEmptyStringSchema.optional(),
      napcatMediaDirectory: nonEmptyStringSchema.optional(),
      ytDlpLinuxPath: nonEmptyStringSchema.optional(),
      ytDlpWindowsPath: nonEmptyStringSchema.optional(),
      ffmpegLinuxPath: nonEmptyStringSchema.optional(),
      ffmpegWindowsPath: nonEmptyStringSchema.optional(),
      maxConcurrentJobs: z.number().int().positive().max(8).optional(),
    })
    .optional(),
  vtb: z
    .object({
      enabled: z.boolean().optional(),
      cron: nonEmptyStringSchema.optional(),
      dynamicPollMinutes: z.number().int().min(5).max(1_440).optional(),
      dynamicConcurrency: z.number().int().positive().max(8).optional(),
      cardCacheMinutes: z.number().int().positive().max(1_440).optional(),
      userApiUrl: nonEmptyStringSchema.optional(),
      cardApiUrl: nonEmptyStringSchema.optional(),
      liveApiUrl: nonEmptyStringSchema.optional(),
      navApiUrl: nonEmptyStringSchema.optional(),
      wbiSearchApiUrl: nonEmptyStringSchema.optional(),
      dynamicApiUrl: nonEmptyStringSchema.optional(),
      guardApiUrl: nonEmptyStringSchema.optional(),
      fanClubApiUrl: nonEmptyStringSchema.optional(),
      liveMasterApiUrl: nonEmptyStringSchema.optional(),
      qrGenerateApiUrl: nonEmptyStringSchema.optional(),
      qrPollApiUrl: nonEmptyStringSchema.optional(),
      webUrl: nonEmptyStringSchema.optional(),
      liveWebUrl: nonEmptyStringSchema.optional(),
      nameSyncCron: nonEmptyStringSchema.optional(),
      adminWhitelistUserIds: z.array(targetIdSchema).optional(),
      syncWhitelistUserIds: z.array(targetIdSchema).optional(),
      subscriptionWhitelistUserIds: z.array(targetIdSchema).optional(),
      subscriptions: z
        .array(
          z.object({
            groupId: targetIdSchema,
            streamers: z.array(nonEmptyStringSchema).min(1),
            atAllStreamers: z.array(nonEmptyStringSchema).optional(),
            dynamicStreamers: z.array(nonEmptyStringSchema).optional(),
            dynamicAtAllStreamers: z.array(nonEmptyStringSchema).optional(),
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
  },
  plugins: {
    commandPrefix: config.plugins?.commandPrefix ?? "miz",
    directory: config.plugins?.directory ?? "plugins",
  },
  network: {
    proxyUrl: config.network?.proxyUrl ?? "",
    ffmpegReleaseApiUrl: config.network?.ffmpegReleaseApiUrl ?? "",
    ytDlpReleaseApiUrl: config.network?.ytDlpReleaseApiUrl ?? "",
  },
  ff14: {
    priceAlertEnabled: config.ff14?.priceAlertEnabled ?? true,
    priceAlertCron: config.ff14?.priceAlertCron ?? "0 * * * *",
    maxListingCount: config.ff14?.maxListingCount ?? 10,
    itemSearchApiUrl: config.ff14?.itemSearchApiUrl ?? "",
    marketApiUrl: config.ff14?.marketApiUrl ?? "",
    manageWhitelistUserIds: config.ff14?.manageWhitelistUserIds ?? [],
    priceAlerts: (config.ff14?.priceAlerts ?? []).map((alert) => ({
      ...alert,
      priceAlertAtUserIds: alert.priceAlertAtUserIds ?? [],
    })),
  },
  wallpaper: {
    enabled: config.wallpaper?.enabled ?? true,
    cron: config.wallpaper?.cron ?? "0 8 * * *",
    apiUrl: config.wallpaper?.apiUrl ?? "",
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
  activity: {
    enabled: config.activity?.enabled ?? true,
    cron: config.activity?.cron ?? "* * * * *",
    reminderMinutes: config.activity?.reminderMinutes ?? 30,
    batchSize: config.activity?.batchSize ?? 20,
    maxParticipants: config.activity?.maxParticipants ?? 50,
    manageWhitelistUserIds: config.activity?.manageWhitelistUserIds ?? [],
  },
  faq: {
    maxEntries: config.faq?.maxEntries ?? 100,
    maxAnswerLength: config.faq?.maxAnswerLength ?? 1_000,
    manageWhitelistUserIds: config.faq?.manageWhitelistUserIds ?? [],
  },
  todo: {
    enabled: config.todo?.enabled ?? true,
    cron: config.todo?.cron ?? "* * * * *",
    reminderMinutes: config.todo?.reminderMinutes ?? 30,
    batchSize: config.todo?.batchSize ?? 20,
    manageWhitelistUserIds: config.todo?.manageWhitelistUserIds ?? [],
  },
  broadcast: {
    whitelistUserIds: config.broadcast?.whitelistUserIds ?? [],
  },
  recall: {
    whitelistUserIds: config.recall?.whitelistUserIds ?? [],
  },
  video: {
    enabled: config.video?.enabled ?? true,
    runtimeMode: getRuntimeMode(),
    whitelistUserIds: config.video?.whitelistUserIds ?? [],
    bilibiliHosts: config.video?.bilibiliHosts ?? [],
    downloadDirectory: config.video?.downloadDirectory ?? "/temp",
    napcatMediaDirectory: config.video?.napcatMediaDirectory ?? "/app/media",
    ytDlpLinuxPath: config.video?.ytDlpLinuxPath ?? "",
    ytDlpWindowsPath: config.video?.ytDlpWindowsPath ?? "",
    ffmpegLinuxPath: config.video?.ffmpegLinuxPath ?? "tools/ffmpeg",
    ffmpegWindowsPath: config.video?.ffmpegWindowsPath ?? "tools/ffmpeg.exe",
    maxConcurrentJobs: config.video?.maxConcurrentJobs ?? 2,
  },
  vtb: {
    enabled: config.vtb?.enabled ?? true,
    cron: config.vtb?.cron ?? "*/3 * * * *",
    dynamicPollMinutes: config.vtb?.dynamicPollMinutes ?? 15,
    dynamicConcurrency: config.vtb?.dynamicConcurrency ?? 2,
    cardCacheMinutes: config.vtb?.cardCacheMinutes ?? 30,
    userApiUrl: config.vtb?.userApiUrl ?? "",
    cardApiUrl: config.vtb?.cardApiUrl ?? "",
    liveApiUrl: config.vtb?.liveApiUrl ?? "",
    navApiUrl: config.vtb?.navApiUrl ?? "",
    wbiSearchApiUrl: config.vtb?.wbiSearchApiUrl ?? "",
    dynamicApiUrl: config.vtb?.dynamicApiUrl ?? "",
    guardApiUrl: config.vtb?.guardApiUrl ?? "",
    fanClubApiUrl: config.vtb?.fanClubApiUrl ?? "",
    liveMasterApiUrl: config.vtb?.liveMasterApiUrl ?? "",
    qrGenerateApiUrl: config.vtb?.qrGenerateApiUrl ?? "",
    qrPollApiUrl: config.vtb?.qrPollApiUrl ?? "",
    webUrl: config.vtb?.webUrl ?? "",
    liveWebUrl: config.vtb?.liveWebUrl ?? "",
    nameSyncCron: config.vtb?.nameSyncCron ?? "0 0 * * 0",
    adminWhitelistUserIds: Array.from(new Map([
      ...(config.vtb?.adminWhitelistUserIds ?? []),
      ...(config.vtb?.syncWhitelistUserIds ?? []),
      ...(config.vtb?.subscriptionWhitelistUserIds ?? []),
    ].map((userId) => [String(userId), userId])).values()),
    proxyUrl: config.network?.proxyUrl ?? "",
    subscriptions: (config.vtb?.subscriptions ?? []).map((subscription) => ({
      ...subscription,
      ...(subscription.atAllStreamers === undefined
        ? {}
        : { atAllStreamers: subscription.atAllStreamers.filter((name) => subscription.streamers.includes(name)) }),
      ...(subscription.dynamicStreamers === undefined
        ? {}
        : { dynamicStreamers: subscription.dynamicStreamers.filter((name) => subscription.streamers.includes(name)) }),
      ...(subscription.dynamicAtAllStreamers === undefined
        ? {}
        : { dynamicAtAllStreamers: subscription.dynamicAtAllStreamers.filter((name) => subscription.streamers.includes(name)) }),
    })),
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

export type ActivityConfig = {
  enabled: boolean;
  cron: string;
  reminderMinutes: number;
  batchSize: number;
  maxParticipants: number;
  manageWhitelistUserIds: Array<string | number>;
};

export type FaqConfig = {
  maxEntries: number;
  maxAnswerLength: number;
  manageWhitelistUserIds: Array<string | number>;
};

export type TodoConfig = {
  enabled: boolean;
  cron: string;
  reminderMinutes: number;
  batchSize: number;
  manageWhitelistUserIds: Array<string | number>;
};

export type BroadcastConfig = {
  whitelistUserIds: Array<string | number>;
};

export type RecallConfig = {
  whitelistUserIds: Array<string | number>;
};

export type NetworkConfig = {
  proxyUrl: string;
  ffmpegReleaseApiUrl?: string;
  ytDlpReleaseApiUrl?: string;
};

export type VideoConfig = {
  enabled: boolean;
  runtimeMode: RuntimeMode;
  whitelistUserIds: Array<string | number>;
  bilibiliHosts: string[];
  downloadDirectory: string;
  napcatMediaDirectory: string;
  ytDlpLinuxPath: string;
  ytDlpWindowsPath: string;
  ffmpegLinuxPath: string;
  ffmpegWindowsPath: string;
  maxConcurrentJobs: number;
};

export type VtbConfig = {
  enabled: boolean;
  cron: string;
  dynamicPollMinutes: number;
  dynamicConcurrency: number;
  cardCacheMinutes: number;
  userApiUrl: string;
  cardApiUrl: string;
  liveApiUrl: string;
  navApiUrl: string;
  wbiSearchApiUrl: string;
  dynamicApiUrl: string;
  guardApiUrl: string;
  fanClubApiUrl: string;
  liveMasterApiUrl: string;
  qrGenerateApiUrl: string;
  qrPollApiUrl: string;
  webUrl: string;
  liveWebUrl: string;
  nameSyncCron: string;
  adminWhitelistUserIds: Array<string | number>;
  proxyUrl: string;
  subscriptions: ReadonlyArray<{
    readonly groupId: string | number;
    readonly streamers: readonly string[];
    /** Streamers whose live-start notification should mention every group member. */
    readonly atAllStreamers?: readonly string[];
    /** Streamers whose dynamic feed should be polled for this group. */
    readonly dynamicStreamers?: readonly string[];
    /** Streamers whose dynamic notifications should mention every group member. */
    readonly dynamicAtAllStreamers?: readonly string[];
  }>;
};

// Keep normalized optional sections explicit for plugin consumers. Besides
// documenting the runtime contract, this prevents editor type servers from
// losing transform output fields such as `wallpaper` during incremental checks.
export type MizConfig = z.infer<typeof mizConfigSchema> & {
  runtime: RuntimeConfig;
  network: NetworkConfig;
  wallpaper: WallpaperConfig;
  news: NewsConfig;
  reminder: ReminderConfig;
  schedule: ScheduleConfig;
  activity: ActivityConfig;
  faq: FaqConfig;
  todo: TodoConfig;
  broadcast: BroadcastConfig;
  recall: RecallConfig;
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
let ff14PriceAlertUpdateQueue = Promise.resolve();

export const loadConfig = async (): Promise<MizConfig> => {
  const configFile = Bun.file(CONFIG_PATH);
  if (!(await configFile.exists())) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }

  const runtimeMode = getRuntimeMode();
  const appConfig = Bun.TOML.parse(await configFile.text());
  const [ff14Config, vtbConfig, localConfig, dockerConfig] = await Promise.all([
    loadOptionalConfig(FF14_CONFIG_PATH),
    loadOptionalConfig(VTB_CONFIG_PATH),
    loadOptionalConfig(LOCAL_CONFIG_PATH),
    runtimeMode === "docker" ? loadDockerConfig() : Promise.resolve({}),
  ]);
  const normalConfig = mergeConfig(
    mergeConfig(
      mergeConfig(
        appConfig,
        ff14Config,
      ),
      vtbConfig,
    ),
    localConfig,
  );
  const source = runtimeMode === "docker"
    ? mergeConfig(normalConfig, dockerConfig)
    : normalConfig;
  return appConfigSchema.parse(restoreAppApiUrls(source, appConfig)).miz;
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

export const setVtbAtAllStreamer = (
  groupId: string | number,
  streamerName: string,
  enabled: boolean,
) => queueVtbSubscriptionUpdate(async () => {
  const source = await readVtbSubscriptionConfig();
  const result = setVtbAtAllStreamerInSource(source, groupId, streamerName, enabled);
  if (result.changed) {
    await writeVtbSubscriptionConfig(result.source);
  }
  return {
    changed: result.changed,
    subscribed: result.subscribed,
    atAllStreamers: result.atAllStreamers,
  };
});

export const setVtbDynamicStreamer = (
  groupId: string | number,
  streamerName: string,
  enabled: boolean,
) => queueVtbSubscriptionUpdate(async () => {
  const source = await readVtbSubscriptionConfig();
  const result = setVtbDynamicStreamerInSource(source, groupId, streamerName, enabled);
  if (result.changed) {
    await writeVtbSubscriptionConfig(result.source);
  }
  return {
    changed: result.changed,
    subscribed: result.subscribed,
    dynamicStreamers: result.dynamicStreamers,
  };
});

export const setVtbDynamicStreamerInSource = (
  source: string,
  groupId: string | number,
  streamerName: string,
  enabled: boolean,
) => {
  const subscription = findVtbSubscriptionBlock(source, groupId);
  if (!subscription || !subscription.streamers.includes(streamerName)) {
    return {
      changed: false,
      subscribed: false,
      source,
      dynamicStreamers: subscription?.dynamicStreamers ?? [],
    };
  }

  const current = subscription.dynamicStreamers ?? [];
  const alreadyEnabled = current.includes(streamerName);
  if (alreadyEnabled === enabled) {
    return { changed: false, subscribed: true, source, dynamicStreamers: current };
  }

  const dynamicStreamers = enabled
    ? [...current, streamerName]
    : current.filter((name) => name !== streamerName);
  const updatedBlock = replaceDynamicStreamersInBlock(subscription.text, dynamicStreamers);
  return {
    changed: true,
    subscribed: true,
    source: `${source.slice(0, subscription.start)}${updatedBlock}${source.slice(subscription.end)}`,
    dynamicStreamers,
  };
};

export const setVtbDynamicAtAllStreamer = (
  groupId: string | number,
  streamerName: string,
  enabled: boolean,
) => queueVtbSubscriptionUpdate(async () => {
  const source = await readVtbSubscriptionConfig();
  const result = setVtbDynamicAtAllStreamerInSource(source, groupId, streamerName, enabled);
  if (result.changed) {
    await writeVtbSubscriptionConfig(result.source);
  }
  return {
    changed: result.changed,
    subscribed: result.subscribed,
    dynamicAtAllStreamers: result.dynamicAtAllStreamers,
  };
});

export const setVtbDynamicAtAllStreamerInSource = (
  source: string,
  groupId: string | number,
  streamerName: string,
  enabled: boolean,
) => {
  const subscription = findVtbSubscriptionBlock(source, groupId);
  if (!subscription || !subscription.streamers.includes(streamerName)) {
    return {
      changed: false,
      subscribed: false,
      source,
      dynamicAtAllStreamers: subscription?.dynamicAtAllStreamers ?? [],
    };
  }

  const current = subscription.dynamicAtAllStreamers ?? [];
  const alreadyEnabled = current.includes(streamerName);
  if (alreadyEnabled === enabled) {
    return { changed: false, subscribed: true, source, dynamicAtAllStreamers: current };
  }

  const dynamicAtAllStreamers = enabled
    ? [...current, streamerName]
    : current.filter((name) => name !== streamerName);
  const updatedBlock = replaceDynamicAtAllStreamersInBlock(subscription.text, dynamicAtAllStreamers);
  return {
    changed: true,
    subscribed: true,
    source: `${source.slice(0, subscription.start)}${updatedBlock}${source.slice(subscription.end)}`,
    dynamicAtAllStreamers,
  };
};

export const setVtbAtAllStreamerInSource = (
  source: string,
  groupId: string | number,
  streamerName: string,
  enabled: boolean,
) => {
  const subscription = findVtbSubscriptionBlock(source, groupId);
  if (!subscription || !subscription.streamers.includes(streamerName)) {
    return {
      changed: false,
      subscribed: false,
      source,
      atAllStreamers: subscription?.atAllStreamers ?? [],
    };
  }

  const current = subscription.atAllStreamers ?? [];
  const alreadyEnabled = current.includes(streamerName);
  if (alreadyEnabled === enabled) {
    return { changed: false, subscribed: true, source, atAllStreamers: current };
  }

  const atAllStreamers = enabled
    ? [...current, streamerName]
    : current.filter((name) => name !== streamerName);
  const updatedBlock = replaceAtAllStreamersInBlock(subscription.text, atAllStreamers);
  return {
    changed: true,
    subscribed: true,
    source: `${source.slice(0, subscription.start)}${updatedBlock}${source.slice(subscription.end)}`,
    atAllStreamers,
  };
};

export type Ff14PriceAlertInput = MizConfig["ff14"]["priceAlerts"][number];

export const addFf14PriceAlert = (alert: Ff14PriceAlertInput) =>
  queueFf14PriceAlertUpdate(async () => {
    const source = await readFf14PriceAlertConfig();
    const result = addFf14PriceAlertToSource(source, alert);
    if (result.changed) {
      await writeFf14PriceAlertConfig(result.source);
    }
    return { changed: result.changed, alert: result.alert };
  });

export const removeFf14PriceAlerts = (groupId: string | number, itemName: string) =>
  queueFf14PriceAlertUpdate(async () => {
    const source = await readFf14PriceAlertConfig();
    const result = removeFf14PriceAlertsFromSource(source, groupId, itemName);
    if (result.changed) {
      await writeFf14PriceAlertConfig(result.source);
    }
    return { changed: result.changed, removed: result.removed };
  });

export const addFf14PriceAlertToSource = (source: string, alert: Ff14PriceAlertInput) => {
  const existing = findFf14PriceAlertBlocks(source).find((block) =>
    String(block.alert.groupId) === String(alert.groupId) &&
    block.alert.region === alert.region &&
    normalizeFf14ItemName(block.alert.itemName) === normalizeFf14ItemName(alert.itemName));
  if (existing) {
    return { changed: false, source, alert: existing.alert };
  }

  const normalizedAlert = {
    ...alert,
    itemName: normalizeFf14ItemName(alert.itemName),
    priceAlertAtUserIds: [...alert.priceAlertAtUserIds],
  };
  const separator = getSubscriptionBlockSeparator(source);
  const block = [
    "[[miz.ff14.priceAlerts]]",
    `groupId = ${JSON.stringify(normalizedAlert.groupId)}`,
    `region = ${JSON.stringify(normalizedAlert.region)}`,
    `itemName = ${JSON.stringify(normalizedAlert.itemName)}`,
    `minimumPrice = ${normalizedAlert.minimumPrice}`,
    `priceAlertAtUserIds = ${JSON.stringify(normalizedAlert.priceAlertAtUserIds)}`,
    "",
  ].join("\n");
  return { changed: true, source: `${source}${separator}${block}`, alert: normalizedAlert };
};

export const removeFf14PriceAlertsFromSource = (
  source: string,
  groupId: string | number,
  itemName: string,
) => {
  const matches = findFf14PriceAlertBlocks(source).filter((block) =>
    String(block.alert.groupId) === String(groupId) &&
    normalizeFf14ItemName(block.alert.itemName) === normalizeFf14ItemName(itemName));
  if (matches.length === 0) {
    return { changed: false, source, removed: [] as Ff14PriceAlertInput[] };
  }

  let updated = source;
  for (const block of [...matches].reverse()) {
    updated = `${updated.slice(0, block.start)}${updated.slice(block.end)}`;
  }
  return {
    changed: true,
    source: updated,
    removed: matches.map((block) => block.alert),
  };
};

const writeVtbSubscriptionNames = async (renames: ReadonlyMap<string, string>) => {
  if (renames.size === 0) {
    return false;
  }

  const source = await readVtbSubscriptionConfig();
  const updated = replaceVtbNameAssignments(source, renames);
  const changed = updated !== source;

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
  atAllStreamers?: string[];
  dynamicStreamers?: string[];
  dynamicAtAllStreamers?: string[];
};

const queueFf14PriceAlertUpdate = <T>(operation: () => Promise<T>) => {
  const update = ff14PriceAlertUpdateQueue.then(operation);
  ff14PriceAlertUpdateQueue = update.then(
    () => undefined,
    () => undefined,
  );
  return update;
};

type Ff14PriceAlertBlock = {
  start: number;
  end: number;
  alert: Ff14PriceAlertInput;
};

const findFf14PriceAlertBlocks = (source: string): Ff14PriceAlertBlock[] => {
  const marker = "[[miz.ff14.priceAlerts]]";
  const blocks: Ff14PriceAlertBlock[] = [];
  let start = source.indexOf(marker);
  while (start >= 0) {
    const nextStart = source.indexOf(marker, start + marker.length);
    const end = nextStart >= 0 ? nextStart : source.length;
    const text = source.slice(start, end);
    const groupId = parseTomlAssignment(text, "groupId");
    const region = parseTomlAssignment(text, "region");
    const itemName = parseTomlAssignment(text, "itemName");
    const minimumPrice = parseTomlAssignment(text, "minimumPrice");
    const rawAtUserIds = parseTomlAssignment(text, "priceAlertAtUserIds") ?? [];
    const parsed = ff14PriceAlertSchema.safeParse({
      groupId,
      region,
      itemName,
      minimumPrice,
      priceAlertAtUserIds: rawAtUserIds,
    });
    if (!parsed.success) {
      throw new Error(`Invalid FF14 price alert block: ${parsed.error.message}`);
    }
    const alert = parsed.data;
    blocks.push({
      start,
      end,
      alert: { ...alert, priceAlertAtUserIds: alert.priceAlertAtUserIds ?? [] },
    });
    start = nextStart;
  }
  return blocks;
};

const normalizeFf14ItemName = (itemName: string) => itemName.trim().normalize("NFKC");

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
      const rawAtAllStreamers = parseTomlAssignment(text, "atAllStreamers");
      if (
        rawAtAllStreamers !== undefined &&
        (!Array.isArray(rawAtAllStreamers) || !rawAtAllStreamers.every((name) => typeof name === "string"))
      ) {
        throw new Error(`Invalid atAllStreamers for VTB subscription group ${groupId}`);
      }
      const atAllStreamers = rawAtAllStreamers as string[] | undefined;
      const rawDynamicStreamers = parseTomlAssignment(text, "dynamicStreamers");
      if (rawDynamicStreamers !== undefined &&
        (!Array.isArray(rawDynamicStreamers) || !rawDynamicStreamers.every((name) => typeof name === "string"))) {
        throw new Error(`Invalid dynamicStreamers for VTB subscription group ${groupId}`);
      }
      const dynamicStreamers = rawDynamicStreamers as string[] | undefined;
      const rawDynamicAtAllStreamers = parseTomlAssignment(text, "dynamicAtAllStreamers");
      if (rawDynamicAtAllStreamers !== undefined &&
        (!Array.isArray(rawDynamicAtAllStreamers) || !rawDynamicAtAllStreamers.every((name) => typeof name === "string"))) {
        throw new Error(`Invalid dynamicAtAllStreamers for VTB subscription group ${groupId}`);
      }
      const dynamicAtAllStreamers = rawDynamicAtAllStreamers as string[] | undefined;
      return { start, end, text, streamers, atAllStreamers, dynamicStreamers, dynamicAtAllStreamers };
    }
    start = nextStart;
  }

  return undefined;
};

type TomlAssignment = {
  valueStart: number;
  valueEnd: number;
  lineEnd: number;
  value: string;
};

const findTomlAssignment = (source: string, key: string): TomlAssignment | undefined => {
  const matched = new RegExp(`^${key}[ \\t]*=[ \\t]*`, "m").exec(source);
  if (!matched || matched.index === undefined) {
    return undefined;
  }

  const valueStart = matched.index + matched[0].length;
  const valueEnd = findTomlValueEnd(source, valueStart);
  let lineEnd = valueEnd;
  while (lineEnd < source.length && source[lineEnd] !== "\n" && source[lineEnd] !== "\r") {
    lineEnd += 1;
  }
  return {
    valueStart,
    valueEnd,
    lineEnd,
    value: source.slice(valueStart, valueEnd),
  };
};

const findTomlValueEnd = (source: string, start: number) => {
  const first = source[start];
  if (first !== "[" && first !== "{") {
    let end = start;
    while (end < source.length && source[end] !== "\n" && source[end] !== "\r") {
      end += 1;
    }
    return end;
  }

  const closingStack: string[] = [];
  let quote: "\"" | "'" | "\"\"\"" | "'''" | undefined;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (quote === "\"" && character === "\\") {
        index += 1;
      } else if (quote.length === 3
        ? source.startsWith(quote, index)
        : character === quote) {
        index += quote.length - 1;
        quote = undefined;
      }
      continue;
    }

    if (source.startsWith("\"\"\"", index)) {
      quote = "\"\"\"";
      index += 2;
    } else if (source.startsWith("'''", index)) {
      quote = "'''";
      index += 2;
    } else if (character === "\"") {
      quote = "\"";
    } else if (character === "'") {
      quote = "'";
    } else if (character === "[") {
      closingStack.push("]");
    } else if (character === "{") {
      closingStack.push("}");
    } else if (character === closingStack[closingStack.length - 1]) {
      closingStack.pop();
      if (closingStack.length === 0) {
        return index + 1;
      }
    }
  }

  return source.length;
};

const replaceTomlArrayAssignment = (
  source: string,
  key: string,
  values: readonly string[],
) => {
  const assignment = findTomlAssignment(source, key);
  if (!assignment) {
    return source;
  }
  return `${source.slice(0, assignment.valueStart)}${JSON.stringify(values)}${source.slice(assignment.valueEnd)}`;
};

const replaceOrInsertTomlArrayAssignment = (
  source: string,
  key: string,
  values: readonly string[],
  anchorKey: string,
) => {
  const assignment = findTomlAssignment(source, key);
  if (assignment) {
    return replaceTomlArrayAssignment(source, key, values);
  }

  const anchor = findTomlAssignment(source, anchorKey);
  if (!anchor) {
    return source;
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return `${source.slice(0, anchor.lineEnd)}${newline}${key} = ${JSON.stringify(values)}${source.slice(anchor.lineEnd)}`;
};

const replaceVtbNameAssignments = (source: string, renames: ReadonlyMap<string, string>) => {
  const keys = ["streamers", "atAllStreamers", "dynamicStreamers", "dynamicAtAllStreamers"];
  const assignments = keys.flatMap((key) => {
    const matches: Array<{ key: string; assignment: TomlAssignment }> = [];
    let offset = 0;
    while (offset < source.length) {
      const match = new RegExp(`^${key}[ \\t]*=[ \\t]*`, "m").exec(source.slice(offset));
      if (!match || match.index === undefined) {
        break;
      }
      const absoluteIndex = offset + match.index;
      const assignment = findTomlAssignment(source.slice(absoluteIndex), key);
      if (!assignment) {
        break;
      }
      matches.push({
        key,
        assignment: {
          ...assignment,
          valueStart: assignment.valueStart + absoluteIndex,
          valueEnd: assignment.valueEnd + absoluteIndex,
          lineEnd: assignment.lineEnd + absoluteIndex,
        },
      });
      offset = absoluteIndex + match[0].length + Math.max(1, assignment.valueEnd - assignment.valueStart);
    }
    return matches;
  }).sort((left, right) => right.assignment.valueStart - left.assignment.valueStart);

  let updated = source;
  for (const { key, assignment } of assignments) {
    const parsed = Bun.TOML.parse(`${key} = ${assignment.value.trim()}`) as Record<string, unknown>;
    const names = parsed[key];
    if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) {
      continue;
    }
    const nextNames = names.map((name) => renames.get(name) ?? name);
    if (nextNames.every((name, index) => name === names[index])) {
      continue;
    }
    updated = `${updated.slice(0, assignment.valueStart)}${JSON.stringify(nextNames)}${updated.slice(assignment.valueEnd)}`;
  }
  return updated;
};

const parseTomlAssignment = (source: string, key: string) => {
  const assignment = findTomlAssignment(source, key);
  return assignment === undefined
    ? undefined
    : (Bun.TOML.parse(`${key} = ${assignment.value.trim()}`) as Record<string, unknown>)[key];
};

const replaceSubscriptionBlock = (
  source: string,
  subscription: VtbSubscriptionBlock,
  streamers: readonly string[],
) => {
  let updatedBlock = replaceTomlArrayAssignment(subscription.text, "streamers", streamers);
  if (subscription.atAllStreamers) {
    const atAllStreamers = subscription.atAllStreamers.filter((name) => streamers.includes(name));
    updatedBlock = replaceTomlArrayAssignment(updatedBlock, "atAllStreamers", atAllStreamers);
  }
  if (subscription.dynamicStreamers) {
    const dynamicStreamers = subscription.dynamicStreamers.filter((name) => streamers.includes(name));
    updatedBlock = replaceTomlArrayAssignment(updatedBlock, "dynamicStreamers", dynamicStreamers);
  }
  if (subscription.dynamicAtAllStreamers) {
    const dynamicAtAllStreamers = subscription.dynamicAtAllStreamers.filter((name) => streamers.includes(name));
    updatedBlock = replaceTomlArrayAssignment(updatedBlock, "dynamicAtAllStreamers", dynamicAtAllStreamers);
  }
  return `${source.slice(0, subscription.start)}${updatedBlock}${source.slice(subscription.end)}`;
};

const replaceAtAllStreamersInBlock = (
  block: string,
  atAllStreamers: readonly string[],
) => {
  return replaceOrInsertTomlArrayAssignment(block, "atAllStreamers", atAllStreamers, "streamers");
};

const replaceDynamicStreamersInBlock = (
  block: string,
  dynamicStreamers: readonly string[],
) => {
  return replaceOrInsertTomlArrayAssignment(block, "dynamicStreamers", dynamicStreamers, "streamers");
};

const replaceDynamicAtAllStreamersInBlock = (
  block: string,
  dynamicAtAllStreamers: readonly string[],
) => {
  return replaceOrInsertTomlArrayAssignment(
    block,
    "dynamicAtAllStreamers",
    dynamicAtAllStreamers,
    findTomlAssignment(block, "dynamicStreamers") ? "dynamicStreamers" : "streamers",
  );
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

const readFf14PriceAlertConfig = async () => {
  const configFile = Bun.file(FF14_CONFIG_PATH);
  return (await configFile.exists()) ? configFile.text() : "";
};

const writeFf14PriceAlertConfig = async (source: string) => {
  const temporaryPath = `${FF14_CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    await Bun.write(temporaryPath, source);
    await rename(temporaryPath, FF14_CONFIG_PATH);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
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

// API endpoints are application configuration, not runtime wiring. Keep the
// values explicitly selected in app.toml even when local or Docker config
// supplies environment-specific gateway, database, or proxy settings.
const APP_API_URL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  network: ["ffmpegReleaseApiUrl", "ytDlpReleaseApiUrl"],
  ff14: ["itemSearchApiUrl", "marketApiUrl"],
  wallpaper: ["apiUrl", "imageBaseUrl"],
  news: ["apiUrl"],
  vtb: [
    "userApiUrl",
    "cardApiUrl",
    "liveApiUrl",
    "navApiUrl",
    "wbiSearchApiUrl",
    "dynamicApiUrl",
    "guardApiUrl",
    "fanClubApiUrl",
    "liveMasterApiUrl",
    "qrGenerateApiUrl",
    "qrPollApiUrl",
    "webUrl",
    "liveWebUrl",
  ],
};

const restoreAppApiUrls = (source: unknown, appConfig: unknown): Record<string, unknown> => {
  const merged = asRecord(source);
  const app = asRecord(appConfig);
  const mergedMiz = asRecord(merged.miz);
  const appMiz = asRecord(app.miz);

  for (const [sectionName, fields] of Object.entries(APP_API_URL_FIELDS)) {
    const appSection = appMiz[sectionName];
    const mergedSection = mergedMiz[sectionName];
    if (!isRecord(appSection) || !isRecord(mergedSection)) {
      continue;
    }
    for (const field of fields) {
      const value = appSection[field];
      if (typeof value === "string" && value.trim() !== "") {
        mergedSection[field] = value;
      }
    }
  }

  return merged;
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
