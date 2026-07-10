import { z } from "zod";

const logLevelSchema = z.enum(["debug", "info", "warn", "error", "off"]);
const nonEmptyStringSchema = z.string().trim().min(1);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const targetIdSchema = z.union([z.string().trim().min(1), z.number().int().nonnegative()]);
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
});

const mizConfigSchema = rawMizConfigSchema.transform((config) => ({
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
}));

const appConfigSchema = z.object({
  miz: mizConfigSchema,
});

export type LogLevel = z.infer<typeof logLevelSchema>;
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

// Keep normalized optional sections explicit for plugin consumers. Besides
// documenting the runtime contract, this prevents editor type servers from
// losing transform output fields such as `wallpaper` during incremental checks.
export type MizConfig = z.infer<typeof mizConfigSchema> & {
  wallpaper: WallpaperConfig;
  news: NewsConfig;
};

const CONFIG_PATH = "config/app.toml";

export const loadConfig = async (): Promise<MizConfig> => {
  const configFile = Bun.file(CONFIG_PATH);
  if (!(await configFile.exists())) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }

  return appConfigSchema.parse(Bun.TOML.parse(await configFile.text())).miz;
};
