import type { MizPlugin, PluginContext } from "@/plugins";
import { summarizeError } from "@/errors";
import { isVideoSendTimeoutError } from "@/video-delivery";
import {
  BILI_GIFT_MEDIA_SEND_TIMEOUT_MS,
  loadBiliGiftLibrary,
  readBiliGiftMedia,
} from "@/bili-gift";
import {
  createBiliGiftLotteryForwardMessages,
  drawBiliGiftLottery,
  formatBiliGiftLotteryCard,
  formatBiliGiftLotteryValue,
} from "@/bili-gift-lottery";
import {
  formatGiftLotteryDrawDate,
  giftLotteryDrawStore,
  type GiftLotteryDailyDraw,
  type GiftLotteryDrawStore,
} from "@/gift-lottery-draws";

export type BiliGiftLotteryContext = Pick<
  PluginContext,
  "logger" | "message" | "reply" | "replyForwardWithoutRetry"
> & Readonly<{
  args: string;
  commandPrefix: string;
}>;

export type BiliGiftLotteryCommandOptions = Readonly<{
  /** 素材库目录，默认 resource/bili-gift。 */
  directory?: string;
  /** 便于测试的随机源。 */
  random?: () => number;
  /** 便于测试的当前时间。 */
  now?: Date;
  /** 便于测试的每日记录存储。 */
  store?: GiftLotteryDrawStore;
}>;

export const createBiliGiftLotteryUsage = (commandPrefix: string) => [
  "🎰 想抽礼物的话，发这条就行：",
  `用法：${commandPrefix} 抽奖`,
  "每人每天只能抽一次。",
].join("\n");

export const handleBiliGiftLotteryCommand = async ({
  args,
  commandPrefix,
  logger,
  message,
  reply,
  replyForwardWithoutRetry,
}: BiliGiftLotteryContext, options: BiliGiftLotteryCommandOptions = {}) => {
  if (args.trim() !== "") {
    await reply(`${createBiliGiftLotteryUsage(commandPrefix)}\n抽奖指令后面不用再加参数。`);
    return;
  }

  const userId = message.userId === undefined ? "" : String(message.userId);
  if (userId === "") {
    await reply("没有认出发消息的账号，换个群再试试吧。");
    return;
  }

  const now = options.now ?? new Date();
  const drawDate = formatGiftLotteryDrawDate(now);
  const store = options.store ?? giftLotteryDrawStore;

  // 读记录失败时放行：数据库抖动不该把娱乐功能整个挡在门外。
  let existing: GiftLotteryDailyDraw | undefined;
  try {
    existing = await store.find({ userId, drawDate });
  } catch (error) {
    logger.warn("plugin", "bilibili gift lottery daily lookup failed", {
      error: summarizeError(error),
    });
  }
  if (existing) {
    await reply([
      `今天已经抽过啦，抽到的是「${existing.giftName}」。`,
      "明天再来试试手气吧～",
    ].join("\n"));
    return;
  }

  let gifts;
  try {
    gifts = await loadBiliGiftLibrary(options.directory);
  } catch (error) {
    logger.error("plugin", "bilibili gift library unavailable for lottery", {
      error: summarizeError(error),
    });
    await reply("礼物素材库暂时读不到，请管理员检查 resource/bili-gift 里的素材索引。");
    return;
  }

  const draw = drawBiliGiftLottery(gifts, { random: options.random });
  const media = draw?.media;
  if (!draw || !media) {
    logger.error("plugin", "bilibili gift lottery has nothing to show");
    await reply("这次没抽到能展示的礼物，稍后再试一次吧。");
    return;
  }

  // 先占住今天的名额，避免两条消息同时抽两次。
  let claimed = false;
  try {
    const result = await store.claim({
      userId,
      drawDate,
      giftId: draw.gift.id,
      giftName: draw.gift.name,
    });
    if (result === "taken") {
      await reply("今天已经抽过啦，明天再来试试手气吧～");
      return;
    }
    claimed = true;
  } catch (error) {
    logger.warn("plugin", "bilibili gift lottery claim failed", {
      error: summarizeError(error),
    });
  }

  // 没能把结果发出去时退回名额，让人可以再试一次。
  const releaseClaim = async () => {
    if (!claimed) {
      return;
    }
    try {
      await store.release({ userId, drawDate });
    } catch (error) {
      logger.warn("plugin", "bilibili gift lottery claim release failed", {
        error: summarizeError(error),
      });
    }
  };

  let mediaBase64;
  try {
    mediaBase64 = (await readBiliGiftMedia(media, options.directory)).base64;
  } catch (error) {
    logger.error("plugin", "bilibili gift lottery media unreadable", {
      relativePath: media.relativePath,
      error: summarizeError(error),
    });
    await releaseClaim();
    await reply("抽到的礼物素材读不出来，请管理员检查 resource/bili-gift 是否完整。");
    return;
  }

  try {
    await replyForwardWithoutRetry(
      createBiliGiftLotteryForwardMessages(
        formatBiliGiftLotteryCard(draw),
        media,
        `base64://${mediaBase64}`,
      ),
      {
        title: `${draw.rarity.emoji} ${draw.rarity.label} · ${draw.gift.name}`,
        source: `${commandPrefix} 抽奖`,
        summary: `礼物 #${draw.gift.id} · ${formatBiliGiftLotteryValue(draw.gift)}`,
        timeoutMs: BILI_GIFT_MEDIA_SEND_TIMEOUT_MS,
      },
    );
  } catch (error) {
    await releaseClaim();
    if (isVideoSendTimeoutError(error)) {
      logger.warn("plugin", "bilibili gift lottery delivery timed out with an unknown result", {
        relativePath: media.relativePath,
      });
      await reply("抽奖结果发送超时了，先看看群里有没有出现，稍等一下再试吧～");
      return;
    }
    logger.warn("plugin", "bilibili gift lottery delivery failed", {
      relativePath: media.relativePath,
      error: summarizeError(error),
    });
    await reply("抽奖结果没能发出去，稍后再试一次吧。");
  }
};

const lotteryPlugin: MizPlugin = {
  name: "lottery",
  commands: ["lottery", "抽奖"],
  description: [
    "从 B 站直播礼物里抽一款，连礼物特效一起发出来。",
    "用法：miz 抽奖",
    "每人每天只能抽一次。",
    "礼物按价值分五档：🌱 普通 / ⭐ 稀有 / ✨ 史诗 / 💎 传说 / 👑 神话，越贵越难抽到。",
  ].join("\n"),
  async handle({
    command,
    commandPrefix,
    logger,
    message,
    reply,
    replyForwardWithoutRetry,
  }) {
    await handleBiliGiftLotteryCommand({
      args: command.args,
      commandPrefix,
      logger,
      message,
      reply,
      replyForwardWithoutRetry,
    });
  },
};

export default lotteryPlugin;
