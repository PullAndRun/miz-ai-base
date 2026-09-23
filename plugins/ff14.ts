import type { Ff14PriceAlertInput, MizConfig } from "@/config";
import {
  addFf14PriceAlert,
  loadConfig,
  removeFf14PriceAlerts,
} from "@/config";
import {
  createFf14PriceAlertKey,
  FF14_REGION_NAMES,
  formatFf14BatchMessages,
  formatFf14MarketMessages,
  isFf14RegionKey,
  normalizeFf14ItemQueryName,
  queryFf14Batch,
  queryFf14Market,
  selectFf14BatchListedItems,
  type Ff14BatchResult,
  type Ff14RegionKey,
} from "@/ff14";
import { canManageGroupFeature } from "@/group-permissions";
import type { MizPlugin, PluginContext } from "@/plugins";
import { getVtbRepository } from "@/vtb";
import { notifyFf14AlertChange } from "@/ff14-alert-runtime";

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
  queryBatch?: typeof queryFf14Batch;
  notifyAlertChange?: typeof notifyFf14AlertChange;
};

type Ff14Action =
  | { type: "query"; regionKey: Ff14RegionKey; itemName: string }
  | { type: "batch"; targetGroupId?: number }
  | { type: "list" }
  | { type: "add"; region: Ff14RegionKey; minimumPrice: number; itemName: string; atUserIds: string[] }
  | { type: "remove" | "disable" | "enable"; itemName: string };

const FF14_ALERT_LIST_BATCH_SIZE = 10;

export const createFf14Plugin = ({
  loadCurrentConfig = loadConfig,
  addPriceAlert = addFf14PriceAlert,
  removePriceAlerts = removeFf14PriceAlerts,
  getRepository = getVtbRepository,
  queryBatch = queryFf14Batch,
  notifyAlertChange = notifyFf14AlertChange,
}: Ff14PluginDependencies = {}): MizPlugin => ({
  name: "ff14",
  commands: ["ff14"],
  description: [
    "查询 FF14 国服市场板，也能维护本群的低价商品推送。",
    "市场查询：miz ff14 分区 道具名",
    "批量查价：miz ff14 batch [群号]",
    "推送列表：miz ff14 list",
    "新增推送：miz ff14 add 分区 最高价 道具名 [@成员 ...]",
    "删除推送：miz ff14 remove 道具名",
    "暂时禁用：miz ff14 disable 道具名",
    "恢复启用：miz ff14 enable 道具名",
    "分区简写：猫、猪、狗、鸟；推送变更需要群管理或 FF14 管理白名单权限。",
  ].join("\n"),
  async handle(context: PluginContext) {
    const {
      command,
      commandPrefix,
      config,
      gateway,
      logger,
      message,
      reply,
      replyForward,
    } = context;
    const action = parseFf14Action(command.args);
    if (!action) {
      await reply(createUsageMessage());
      return;
    }

    if (action.type === "batch") {
      await handleFf14Batch({
        action,
        commandPrefix,
        config,
        gateway,
        getRepository,
        logger,
        message,
        queryBatch,
        reply,
        replyForward,
      });
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
          const batches = chunkFf14PriceAlerts(groupAlerts, FF14_ALERT_LIST_BATCH_SIZE);
          await replyForward(
            batches.map((batch, batchIndex) => {
              const firstItemNumber = batchIndex * FF14_ALERT_LIST_BATCH_SIZE + 1;
              const lastItemNumber = firstItemNumber + batch.length - 1;
              const enabledCount = batch.filter((alert) =>
                !disabledKeys.has(createFf14PriceAlertKey(alert.groupId, alert.itemName))).length;
              const disabledCount = batch.length - enabledCount;
              return [
                `📦 第 ${firstItemNumber}–${lastItemNumber} 个商品（共 ${groupAlerts.length} 个）`,
                disabledCount === 0
                  ? `这组 ${batch.length} 个商品都在正常关注。`
                  : `这组有 ${enabledCount} 个正在关注，${disabledCount} 个已暂停。`,
                ...batch.map((alert, itemIndex) => formatFf14PriceAlertListItem(
                  alert,
                  !disabledKeys.has(createFf14PriceAlertKey(alert.groupId, alert.itemName)),
                  firstItemNumber + itemIndex,
                )),
              ].join("\n\n");
            }),
            {
              title: "🪙 FF14 商品推送",
              source: "miz ff14 list",
              summary: `本群共 ${groupAlerts.length} 条商品推送 · 每 10 条分为一个节点`,
            },
          );
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
            notifyAlertChange((await loadCurrentConfig()).ff14.priceAlerts);
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
          notifyAlertChange((await loadCurrentConfig()).ff14.priceAlerts);
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
  if (isFf14BatchActionName(rawType)) {
    const rawTarget = parts[0];
    if (rawTarget === undefined) {
      return { type: "batch" };
    }

    const targetGroupId = Number(rawTarget);
    return parts.length === 1 && /^\d+$/.test(rawTarget) && Number.isSafeInteger(targetGroupId)
      ? { type: "batch", targetGroupId }
      : undefined;
  }

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

// 批量查价与 add/remove 这类管理动作分开解析：它只读配置，不改配置。
const isFf14BatchActionName = (value: string) =>
  value === "batch" || value === "批量" || value === "批量查价" || value === "查价";

const normalizeManagementAction = (action: string) => {
  if (action === "add" || action === "添加" || action === "新增") return "add" as const;
  if (action === "remove" || action === "delete" || action === "删除") return "remove" as const;
  if (action === "disable" || action === "pause" || action === "禁用" || action === "暂停") return "disable" as const;
  if (action === "enable" || action === "resume" || action === "启用" || action === "恢复") return "enable" as const;
  return undefined;
};

const findGroupPriceAlerts = (config: MizConfig, groupId: string | number): Ff14PriceAlertInput[] =>
  config.ff14.priceAlerts.filter((alert) => String(alert.groupId) === String(groupId));

const chunkFf14PriceAlerts = (
  alerts: readonly Ff14PriceAlertInput[],
  batchSize: number,
) => Array.from(
  { length: Math.ceil(alerts.length / batchSize) },
  (_, index) => alerts.slice(index * batchSize, (index + 1) * batchSize),
);

export const formatFf14PriceAlertListItem = (
  alert: Ff14PriceAlertInput,
  enabled: boolean,
  itemNumber?: number,
) => {
  const mentionLine = alert.priceAlertAtUserIds.length > 0
    ? `${enabled ? "到价时会提醒" : "恢复后会提醒"}：${alert.priceAlertAtUserIds.map((id) => `@${id}`).join("、")}`
    : `${enabled ? "到价时" : "恢复后"}只发群消息，不额外 at 成员。`;
  return [
    `${itemNumber === undefined ? "" : `${itemNumber}. `}${enabled ? "✅" : "⏸️"} ${alert.itemName}`,
    enabled
      ? `正在看 ${FF14_REGION_NAMES[alert.region]} 的价格，降到 ${alert.minimumPrice.toLocaleString("zh-CN")} gil 或更低就通知。`
      : `目前已暂停；原本关注 ${FF14_REGION_NAMES[alert.region]}，目标价是 ${alert.minimumPrice.toLocaleString("zh-CN")} gil 或更低。`,
    mentionLine,
  ].join("\n");
};

type Ff14BatchHandlerContext = Pick<PluginContext,
  | "commandPrefix"
  | "config"
  | "gateway"
  | "logger"
  | "message"
  | "reply"
  | "replyForward"
> & {
  action: Extract<Ff14Action, { type: "batch" }>;
  getRepository: (config: MizConfig) => Promise<Ff14PluginRepository>;
  queryBatch: typeof queryFf14Batch;
};

/** 批量查价是只读查询：查完直接把结果推到目标群，不改动任何配置。 */
const handleFf14Batch = async ({
  action,
  commandPrefix,
  config,
  gateway,
  getRepository,
  logger,
  message,
  queryBatch,
  reply,
  replyForward,
}: Ff14BatchHandlerContext) => {
  const targetGroupId = action.targetGroupId ?? message.groupId;
  if (targetGroupId === undefined) {
    await reply(`批量查价跟着群配置走：在群里发 ${commandPrefix} ff14 batch，或者带上群号 ${commandPrefix} ff14 batch 123456789。`);
    return;
  }

  const isCurrentGroup = message.groupId !== undefined && String(message.groupId) === String(targetGroupId);
  if (!isCurrentGroup && !canManageGroupFeature(message.raw, message.userId, config.ff14.manageWhitelistUserIds)) {
    await reply("把批量查价结果推到别的群需要群管理或 FF14 管理白名单权限。");
    return;
  }

  const batches = config.ff14.batchQueries.filter((batch) => String(batch.groupId) === String(targetGroupId));
  if (batches.length === 0) {
    await reply(`群 ${targetGroupId} 还没有批量查价清单，先在 config/ff14.toml 里加一段 [[miz.ff14.batchQueries]] 吧。`);
    return;
  }

  if (!config.ff14.itemSearchApiUrl || !config.ff14.marketApiUrl) {
    await reply("FF14 市场板的查询通道还没接好，请联系管理员完成配置。");
    return;
  }

  try {
    const itemStore = await getRepository(config);
    const results: Ff14BatchResult[] = [];
    for (const batch of batches) {
      results.push(await queryBatch({
        regionKey: batch.region,
        itemNames: batch.itemNames,
        sellPrice: batch.sellPrice,
        sampleSize: config.ff14.batchSampleSize,
        itemSearchApiUrl: config.ff14.itemSearchApiUrl,
        marketApiUrl: config.ff14.marketApiUrl,
        proxyUrl: config.network.proxyUrl,
        maxListingCount: config.ff14.maxListingCount,
        itemStore,
      }));
    }

    const itemCount = results.reduce((total, result) => total + result.items.length, 0);
    // 一个达标的都没有时只回一句提示，不推合并转发。
    const sellingResults = results.filter((result) => selectFf14BatchListedItems(result).length > 0);
    if (sellingResults.length === 0) {
      const regionNames = [...new Set(results.map((result) => result.regionName))].join("、");
      await reply(`🪙 ${regionNames} 批量查价：${itemCount} 个商品都没到售卖线，先不急着上线。`);
      logger.info("plugin", "ff14 batch price query sent: nothing above the sell line", {
        groupId: targetGroupId,
        senderGroupId: message.groupId,
        userId: message.userId,
        batches: batches.length,
        items: itemCount,
      });
      return;
    }

    const messages = sellingResults.flatMap((result) => formatFf14BatchMessages(result));
    const options = {
      title: "🪙 FF14 批量查价",
      source: "miz ff14 batch",
      summary: `最低 ${config.ff14.batchSampleSize} 条挂单中位参考 · 共 ${itemCount} 个商品`,
    };

    if (isCurrentGroup) {
      await replyForward(messages, options);
    } else {
      await gateway.sendForwardMessage(
        { text: "", groupId: targetGroupId, raw: {} },
        messages,
        options,
      );
      await reply(`已把批量查价结果推到群 ${targetGroupId} 了。`);
    }

    logger.info("plugin", "ff14 batch price query sent", {
      groupId: targetGroupId,
      senderGroupId: message.groupId,
      userId: message.userId,
      batches: batches.length,
      items: itemCount,
    });
  } catch (error) {
    logger.error("plugin", "ff14 batch price query failed", error);
    await reply("批量查价刚才没成功，稍后再试一次吧。");
  }
};

const createUsageMessage = () => [
  "🪙 FF14 市场与商品推送：",
  "查询：miz ff14 分区 道具名",
  "批量查价：miz ff14 batch [群号]",
  "列表：miz ff14 list",
  "添加：miz ff14 add 分区 最高价 道具名 [@成员 ...]",
  "删除：miz ff14 remove 道具名",
  "禁用：miz ff14 disable 道具名",
  "启用：miz ff14 enable 道具名",
  "分区：猫=猫小胖，猪=莫古力，狗=豆豆柴，鸟=陆行鸟",
  "例如：miz ff14 add 猫 1000 水之碎晶 @123456789",
  "例如：miz ff14 batch 627836955",
].join("\n");
