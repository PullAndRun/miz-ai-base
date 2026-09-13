import type { MizPlugin, PluginContext } from "@/plugins";
import { summarizeError } from "@/errors";
import { isVideoSendTimeoutError } from "@/video-delivery";
import {
  BILI_GIFT_MEDIA_SEND_TIMEOUT_MS,
  MAX_BILI_GIFT_QUERY_LENGTH,
  createBiliGiftForwardMessages,
  findBiliGift,
  loadBiliGiftLibrary,
  parseBiliGiftCommandArguments,
  readBiliGiftMedia,
  resolveBiliGiftMedia,
  suggestBiliGiftNames,
} from "@/bili-gift";

export type BiliGiftCommandContext = Pick<
  PluginContext,
  "logger" | "reply" | "replyForwardWithoutRetry"
> & Readonly<{
  args: string;
  commandPrefix: string;
}>;

export const createBiliGiftUsage = (commandPrefix: string) => [
  "🎁 想看哪个礼物的特效？",
  `用法：${commandPrefix} 礼物 礼物名`,
  `例如：${commandPrefix} 礼物 小电视飞船`,
].join("\n");

export type BiliGiftCommandOptions = Readonly<{
  /** 素材库目录，默认 resource/bili-gift。 */
  directory?: string;
}>;

export const handleBiliGiftCommand = async ({
  args,
  commandPrefix,
  logger,
  reply,
  replyForwardWithoutRetry,
}: BiliGiftCommandContext, options: BiliGiftCommandOptions = {}) => {
  const { query, mode } = parseBiliGiftCommandArguments(args);
  if (!query) {
    await reply(createBiliGiftUsage(commandPrefix));
    return;
  }
  if (query.length > MAX_BILI_GIFT_QUERY_LENGTH) {
    await reply(`礼物名最多 ${MAX_BILI_GIFT_QUERY_LENGTH} 个字，用名字里的关键词再试一次吧～`);
    return;
  }

  let gifts;
  try {
    gifts = await loadBiliGiftLibrary(options.directory);
  } catch (error) {
    logger.error("plugin", "bilibili gift library unavailable", {
      error: summarizeError(error),
    });
    await reply("礼物素材库暂时读不到，请管理员检查 resource/bili-gift 里的素材索引。");
    return;
  }

  const match = findBiliGift(gifts, query);
  if (!match) {
    const suggestions = suggestBiliGiftNames(gifts, query);
    logger.info("plugin", "bilibili gift not found", { query, suggestions });
    await reply([
      `素材库里没有叫「${query}」的礼物。`,
      suggestions.length > 0
        ? `是不是想找：${suggestions.join("、")}？`
        : `可以换礼物名里的关键词试试，例如「飞船」「辣条」。`,
    ].join("\n"));
    return;
  }

  const media = resolveBiliGiftMedia(match.gift, mode);
  if (!media) {
    logger.info("plugin", "bilibili gift has no requested media", {
      giftId: match.gift.id,
      mode,
    });
    await reply(
      `「${match.gift.name}」的最新版本（#${match.gift.id}）没有全屏特效，发 ${commandPrefix} 礼物 ${match.gift.name} 动图 就能看到礼物动图。`,
    );
    return;
  }

  let mediaBase64;
  try {
    mediaBase64 = (await readBiliGiftMedia(media, options.directory)).base64;
  } catch (error) {
    logger.error("plugin", "bilibili gift media unreadable", {
      relativePath: media.relativePath,
      error: summarizeError(error),
    });
    await reply("这份礼物的素材文件读不出来，请管理员检查 resource/bili-gift 是否完整。");
    return;
  }

  try {
    await replyForwardWithoutRetry(
      createBiliGiftForwardMessages(match, media, `base64://${mediaBase64}`),
      {
        title: `🎁 ${match.gift.name}`,
        source: `${commandPrefix} 礼物`,
        summary: `${media.label} · 礼物 #${match.gift.id}`,
        timeoutMs: BILI_GIFT_MEDIA_SEND_TIMEOUT_MS,
      },
    );
  } catch (error) {
    if (isVideoSendTimeoutError(error)) {
      logger.warn("plugin", "bilibili gift delivery timed out with an unknown result", {
        relativePath: media.relativePath,
      });
      await reply("礼物特效发送超时了，先看看群里有没有出现，稍等一下再试吧～");
      return;
    }
    logger.warn("plugin", "bilibili gift delivery failed", {
      relativePath: media.relativePath,
      error: summarizeError(error),
    });
    await reply("礼物特效没能发出去，稍后再试一次吧。");
  }
};

const giftPlugin: MizPlugin = {
  name: "gift",
  commands: ["gift", "礼物"],
  description: [
    "把 B 站直播礼物做成一条转发消息：礼物名、价格等台账数据，加上礼物的展示效果。",
    "用法：miz 礼物 礼物名",
    "同名礼物取礼物 ID 最大的一版；有全屏特效的送特效视频，没有的送礼物动图，名字后面加「动图」可以只看动图。",
    "例如：miz 礼物 小电视飞船",
  ].join("\n"),
  async handle({ command, commandPrefix, logger, reply, replyForwardWithoutRetry }) {
    await handleBiliGiftCommand({
      args: command.args,
      commandPrefix,
      logger,
      reply,
      replyForwardWithoutRetry,
    });
  },
};

export default giftPlugin;
