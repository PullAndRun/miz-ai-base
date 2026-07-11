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
    "查询最终幻想14指定分区的道具市场价格。",
    "用法: miz ff14 分区 道具名",
    "分区: 猫=猫小胖, 猪=莫古力, 狗=豆豆柴, 鸟=陆行鸟",
    "示例: miz ff14 猫 水之碎晶",
    "示例: miz ff14 猪 风之碎晶",
    "示例: miz ff14 鸟 太阳神草",
    "返回: 汇总最低价、均价、在售数量，并按 HQ/NQ 分组展示挂单。",
  ].join("\n"),
  async handle({ command, config, logger, reply, replyForward }) {
    const request = parseRequest(command.args);
    if (!request) {
      await reply(createUsageMessage());
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
        await reply(`没有找到“${request.itemName}”。请检查道具名称和分区后再试。`);
        return;
      }

      await replyForward(
        formatFf14MarketMessages({
          ...result,
          maxListingCount: config.ff14.maxListingCount,
        }),
        {
          title: `FF14 价格: ${result.item.Name}`,
          source: "miz ff14",
          summary: `${result.regionName} / ${result.item.Name}`,
        },
      );
    } catch (error) {
      logger.error("plugin", "ff14 price query failed", error);
      await reply("FF14 市场价格暂时无法查询，请稍后再试。");
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
    "FF14 道具价格查询",
    "",
    "命令格式:",
    "miz ff14 分区 道具名",
    "",
    "分区可选:",
    "猫 = 猫小胖",
    "猪 = 莫古力",
    "狗 = 豆豆柴",
    "鸟 = 陆行鸟",
    "",
    "使用示例:",
    "miz ff14 猫 水之碎晶",
    "miz ff14 猪 风之碎晶",
    "miz ff14 鸟 太阳神草",
    "",
    "返回内容:",
    "最低价、均价、挂单数量、在售件数，以及按 HQ/NQ 分组的低价挂单。",
  ].join("\n");
