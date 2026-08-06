import type { Ff14PriceAlertInput, MizConfig } from "@/config";
import {
  addFf14PriceAlert,
  loadConfig,
  removeFf14PriceAlerts,
} from "@/config";
import {
  createFf14PriceAlertKey,
  FF14_REGION_NAMES,
  formatFf14MarketMessages,
  isFf14RegionKey,
  normalizeFf14ItemQueryName,
  queryFf14Market,
  type Ff14RegionKey,
} from "@/ff14";
import { canManageGroupFeature } from "@/group-permissions";
import type { MizPlugin } from "@/plugins";
import { getVtbRepository } from "@/vtb";

type Ff14PluginRepository = Pick<Awaited<ReturnType<typeof getVtbRepository>>,
  | "disableFf14PriceAlert"
  | "enableFf14PriceAlert"
  | "listDisabledFf14PriceAlerts"
  | "findFf14Item"
  | "upsertFf14Item"
>;

type Ff14PluginDependencies = {
  loadCurrentConfig?: typeof loadConfig;
  addPriceAlert?: typeof addFf14PriceAlert;
  removePriceAlerts?: typeof removeFf14PriceAlerts;
  getRepository?: (config: MizConfig) => Promise<Ff14PluginRepository>;
};

type Ff14Action =
  | { type: "query"; regionKey: Ff14RegionKey; itemName: string }
  | { type: "list" }
  | { type: "add"; region: Ff14RegionKey; minimumPrice: number; itemName: string; atUserIds: string[] }
  | { type: "remove" | "disable" | "enable"; itemName: string };

export const createFf14Plugin = ({
  loadCurrentConfig = loadConfig,
  addPriceAlert = addFf14PriceAlert,
  removePriceAlerts = removeFf14PriceAlerts,
  getRepository = getVtbRepository,
}: Ff14PluginDependencies = {}): MizPlugin => ({
  name: "ff14",
  commands: ["ff14"],
  description: [
    "查询 FF14 国服市场板，也能维护本群的低价商品推送。",
    "市场查询：miz ff14 分区 道具名",
    "推送列表：miz ff14 list",
    "新增推送：miz ff14 add 分区 最高价 道具名 [@成员 ...]",
    "删除推送：miz ff14 remove 道具名",
    "暂时禁用：miz ff14 disable 道具名",
    "恢复启用：miz ff14 enable 道具名",
    "分区简写：猫、猪、狗、鸟；推送变更需要群管理或 FF14 管理白名单权限。",
  ].join("\n"),
  async handle({ command, config, logger, message, reply, replyForward }) {
    const action = parseFf14Action(command.args);
    if (!action) {
      await reply(createUsageMessage());
      return;
    }

    if (action.type !== "query") {
      if (message.groupId === undefined) {
        await reply("FF14 商品推送跟着群聊走，请回到目标群里管理。");
        return;
      }

      const canManage = canManageGroupFeature(
        message.raw,
        message.userId,
        config.ff14.manageWhitelistUserIds,
      );
      if (action.type !== "list" && !canManage) {
        await reply("查看推送列表可以直接用；新增、删除、启用或禁用需要群管理或 FF14 管理白名单权限。");
        return;
      }

      try {
        const latestConfig = await loadCurrentConfig();
        const groupAlerts = findGroupPriceAlerts(latestConfig, message.groupId);

        if (action.type === "list") {
          if (groupAlerts.length === 0) {
            await reply("🪙 这个群还没有 FF14 商品推送。\n添加：miz ff14 add 分区 最高价 道具名 [@成员 ...]");
            return;
          }
          const repository = await getRepository(config);
          const disabledKeys = new Set(
            (await repository.listDisabledFf14PriceAlerts(message.groupId)).map((disabled) =>
              createFf14PriceAlertKey(disabled.groupId, disabled.itemName)),
          );
          await reply([
            `🪙 这个群有 ${groupAlerts.length} 条 FF14 商品推送：`,
            ...groupAlerts.map((alert) => {
              const enabled = !disabledKeys.has(createFf14PriceAlertKey(alert.groupId, alert.itemName));
              const mentions = alert.priceAlertAtUserIds.length > 0
                ? ` · 提醒 ${alert.priceAlertAtUserIds.map((id) => `@${id}`).join(" ")}`
                : "";
              return `· ${enabled ? "启用" : "禁用"} · ${alert.region}(${FF14_REGION_NAMES[alert.region]}) · ${alert.itemName} · ≤ ${alert.minimumPrice.toLocaleString("zh-CN")} gil${mentions}`;
            }),
          ].join("\n"));
          return;
        }

        if (action.type === "add") {
          const result = await addPriceAlert({
            groupId: message.groupId,
            region: action.region,
            itemName: action.itemName,
            minimumPrice: action.minimumPrice,
            priceAlertAtUserIds: action.atUserIds,
          });
          if (result.changed) {
            try {
              const repository = await getRepository(config);
              await repository.enableFf14PriceAlert(message.groupId, action.itemName);
            } catch (error) {
              logger.warn("plugin", "ff14 added alert suppression cleanup failed", {
                groupId: message.groupId,
                itemName: action.itemName,
                error,
              });
            }
          }
          await reply(result.changed
            ? `🪙 已添加“${result.alert.itemName}”推送：${action.region}(${FF14_REGION_NAMES[action.region]})，价格不高于 ${action.minimumPrice.toLocaleString("zh-CN")} gil 时提醒${action.atUserIds.length > 0 ? ` ${action.atUserIds.map((id) => `@${id}`).join(" ")}` : "本群"}。`
            : `这个群已经有“${result.alert.itemName}”在 ${result.alert.region}(${FF14_REGION_NAMES[result.alert.region]}) 的推送了。`);
          return;
        }

        const matchingAlerts = groupAlerts.filter((alert) =>
          normalizeFf14ItemQueryName(alert.itemName) === normalizeFf14ItemQueryName(action.itemName));

        if (action.type === "remove") {
          const result = await removePriceAlerts(message.groupId, action.itemName);
          if (!result.changed) {
            await reply(`这个群的推送列表里没有“${action.itemName}”。`);
            return;
          }
          try {
            const repository = await getRepository(config);
            await repository.enableFf14PriceAlert(message.groupId, normalizeFf14ItemQueryName(action.itemName));
          } catch (error) {
            logger.warn("plugin", "ff14 removed alert suppression cleanup failed", {
              groupId: message.groupId,
              itemName: action.itemName,
              error,
            });
          }
          await reply(`已删除“${action.itemName}”的 ${result.removed.length} 条商品推送。`);
          return;
        }

        const repository = await getRepository(config);
        const disabledAlerts = await repository.listDisabledFf14PriceAlerts(message.groupId);
        const canonicalItemName = matchingAlerts[0]?.itemName ?? disabledAlerts.find((disabled) =>
          normalizeFf14ItemQueryName(disabled.itemName) === normalizeFf14ItemQueryName(action.itemName))?.itemName;
        if (!canonicalItemName) {
          await reply(`这个群的推送列表里没有“${action.itemName}”。先发 miz ff14 list 看看吧。`);
          return;
        }

        if (action.type === "disable") {
          const changed = await repository.disableFf14PriceAlert(
            message.groupId,
            normalizeFf14ItemQueryName(canonicalItemName),
            message.userId,
          );
          await reply(changed
            ? `⏸️ 已在这个群暂时禁用“${canonicalItemName}”的商品推送；配置仍然保留。`
            : `“${canonicalItemName}”在这个群已经是禁用状态。`);
          return;
        }

        const changed = await repository.enableFf14PriceAlert(
          message.groupId,
          normalizeFf14ItemQueryName(canonicalItemName),
        );
        await reply(changed
          ? `▶️ 已在这个群恢复“${canonicalItemName}”的商品推送。`
          : `“${canonicalItemName}”在这个群已经是启用状态。`);
      } catch (error) {
        logger.error("plugin", "ff14 price alert command failed", error);
        await reply("FF14 商品推送刚才没改成功，稍后再试一次吧。");
      }
      return;
    }

    if (!config.ff14.itemSearchApiUrl || !config.ff14.marketApiUrl) {
      await reply("FF14 市场板的查询通道还没接好，请联系管理员完成配置。");
      return;
    }

    logger.info("plugin", "ff14 price query", {
      region: FF14_REGION_NAMES[action.regionKey],
      itemName: action.itemName,
    });

    try {
      const itemStore = await getRepository(config);
      const result = await queryFf14Market({
        regionKey: action.regionKey,
        itemName: action.itemName,
        itemSearchApiUrl: config.ff14.itemSearchApiUrl,
        marketApiUrl: config.ff14.marketApiUrl,
        proxyUrl: config.network.proxyUrl,
        maxListingCount: config.ff14.maxListingCount,
        itemStore,
      });
      if (!result) {
        await reply(`市场板里没找到“${action.itemName}”。检查一下道具名和分区，再搜一次吧。`);
        return;
      }

      await replyForward(
        formatFf14MarketMessages({
          ...result,
          maxListingCount: config.ff14.maxListingCount,
        }),
        {
          title: `🪙 FF14 市场 · ${result.item.Name}`,
          source: "miz ff14",
          summary: `${result.regionName} · ${result.item.Name}`,
        },
      );
    } catch (error) {
      logger.error("plugin", "ff14 price query failed", error);
      await reply("市场板刚才没回话，过一会儿再去逛一次吧。");
    }
  },
});

export default createFf14Plugin();

export const parseFf14Action = (args: string): Ff14Action | undefined => {
  const normalized = args.trim();
  if (!normalized) return undefined;

  if (normalized === "list" || normalized === "列表" || normalized === "展示") {
    return { type: "list" };
  }

  const [rawType, ...parts] = normalized.split(/\s+/);
  const simpleAction = normalizeManagementAction(rawType);
  if (simpleAction === "remove" || simpleAction === "disable" || simpleAction === "enable") {
    const itemName = parts.join(" ").trim();
    return itemName ? { type: simpleAction, itemName: normalizeFf14ItemQueryName(itemName) } : undefined;
  }

  if (simpleAction === "add") {
    const [region, rawMinimumPrice, ...itemParts] = parts;
    if (!isFf14RegionKey(region) || !/^\d+$/.test(rawMinimumPrice ?? "")) {
      return undefined;
    }
    const minimumPrice = Number(rawMinimumPrice);
    if (!Number.isSafeInteger(minimumPrice) || minimumPrice <= 0) {
      return undefined;
    }
    const remainder = itemParts.join(" ");
    const atUserIds = [...remainder.matchAll(/(?:^|\s)@(\d+)(?=\s|$)/g)].map((match) => match[1]);
    const itemName = normalizeFf14ItemQueryName(
      remainder.replace(/(?:^|\s)@\d+(?=\s|$)/g, " "),
    );
    if (!itemName) return undefined;
    return {
      type: "add",
      region,
      minimumPrice,
      itemName,
      atUserIds: [...new Set(atUserIds)],
    };
  }

  const [regionKey, ...itemNameParts] = normalized.split(/\s+/);
  const itemName = normalizeFf14ItemQueryName(itemNameParts.join(" "));
  return isFf14RegionKey(regionKey) && itemName
    ? { type: "query", regionKey, itemName }
    : undefined;
};

const normalizeManagementAction = (action: string) => {
  if (action === "add" || action === "添加" || action === "新增") return "add" as const;
  if (action === "remove" || action === "delete" || action === "删除") return "remove" as const;
  if (action === "disable" || action === "pause" || action === "禁用" || action === "暂停") return "disable" as const;
  if (action === "enable" || action === "resume" || action === "启用" || action === "恢复") return "enable" as const;
  return undefined;
};

const findGroupPriceAlerts = (config: MizConfig, groupId: string | number): Ff14PriceAlertInput[] =>
  config.ff14.priceAlerts.filter((alert) => String(alert.groupId) === String(groupId));

const createUsageMessage = () => [
  "🪙 FF14 市场与商品推送：",
  "查询：miz ff14 分区 道具名",
  "列表：miz ff14 list",
  "添加：miz ff14 add 分区 最高价 道具名 [@成员 ...]",
  "删除：miz ff14 remove 道具名",
  "禁用：miz ff14 disable 道具名",
  "启用：miz ff14 enable 道具名",
  "分区：猫=猫小胖，猪=莫古力，狗=豆豆柴，鸟=陆行鸟",
  "例如：miz ff14 add 猫 1000 水之碎晶 @123456789",
].join("\n");
