import {
  FF14_REGION_NAMES,
  formatFf14MarketMessages,
  isFf14RegionKey,
  queryFf14Market,
} from "@/ff14";
import type { MizPlugin } from "@/plugins";

const ff14Plugin: MizPlugin = {
  name: "ff14",
  commands: ["ff14"],
  description: [
    "去 FF14 国服市场板逛一圈，带回道具价格和低价挂单。",
    "用法：miz ff14 分区 道具名",
    "分区：猫=猫小胖，猪=莫古力，狗=豆豆柴，鸟=陆行鸟",
    "示例：miz ff14 猫 水之碎晶",
    "结果包含最低价、均价、在售数量和 HQ/NQ 低价挂单。",
  ].join("\n"),
  async handle({ command, config, logger, reply, replyForward }) {
    const request = parseRequest(command.args);
    if (!request) {
      await reply(createUsageMessage());
      return;
    }

    if (!config.ff14.itemSearchApiUrl || !config.ff14.marketApiUrl) {
      await reply("FF14 市场板的查询通道还没接好，请联系管理员完成配置。");
      return;
    }

    logger.info("plugin", "ff14 price query", {
      region: FF14_REGION_NAMES[request.regionKey],
      itemName: request.itemName,
    });

    try {
      const result = await queryFf14Market({
        ...request,
        itemSearchApiUrl: config.ff14.itemSearchApiUrl,
        marketApiUrl: config.ff14.marketApiUrl,
      });
      if (!result) {
        await reply(`市场板里没找到“${request.itemName}”。检查一下道具名和分区，再搜一次吧。`);
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
};

export default ff14Plugin;

const parseRequest = (args: string) => {
  const [regionKey, ...itemNameParts] = args.trim().split(/\s+/);
  const itemName = itemNameParts.join(" ").trim();

  if (!isFf14RegionKey(regionKey) || !itemName) {
    return undefined;
  }

  return {
    regionKey,
    itemName,
  };
};

const createUsageMessage = () =>
  [
    "🪙 这样逛市场板：miz ff14 分区 道具名",
    "分区：猫=猫小胖，猪=莫古力，狗=豆豆柴，鸟=陆行鸟",
    "例如：miz ff14 猫 水之碎晶",
  ].join("\n");
