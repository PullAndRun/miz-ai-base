import type { MizPlugin, PluginContext } from "@/plugins";
import { settleWithConcurrency } from "@/concurrency";
import { summarizeError } from "@/errors";
import { isVideoSendTimeoutError } from "@/video-delivery";
import {
  BILI_GIFT_MEDIA_SEND_TIMEOUT_MS,
  loadBiliGiftLibrary,
  readBiliGiftMedia,
} from "@/bili-gift";
import {
  BILI_GIFT_LOTTERY_LEADERBOARD_SIZE,
  createBiliGiftLotteryForwardMessages,
  createBiliGiftLotteryLeaderboardMessage,
  drawBiliGiftLottery,
  formatBiliGiftLotteryCard,
  formatBiliGiftLotteryStars,
  getBiliGiftLotteryCoins,
} from "@/bili-gift-lottery";
import {
  formatGiftLotteryDrawDate,
  giftLotteryDrawStore,
  type GiftLotteryCoinEntry,
  type GiftLotteryDailyDraw,
  type GiftLotteryDrawStore,
} from "@/gift-lottery-draws";

export type BiliGiftLotteryContext = Pick<
  PluginContext,
  "gateway" | "logger" | "message" | "reply" | "replyForwardWithoutRetry"
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

/** 同一天再次抽奖的提示；群里明确说「本群」，私聊就按用户算。 */
export const createAlreadyDrawnMessage = (
  isGroupChat: boolean,
  giftName?: string,
  coins?: number,
  winnerName?: string,
) => {
  const scope = isGroupChat ? "本群" : "";
  const winner = winnerName?.trim() ? `${winnerName.trim()} ` : "";
  const detail = giftName
    ? `，${winner}抽到的是「${giftName}」${coins ? `（+${coins} 迷币）` : ""}`
    : "";
  return [`${scope}今天已经抽过啦${detail}。`, "明天再来试试手气吧～"].join("\n");
};

export const createBiliGiftLotteryUsage = (commandPrefix: string) => [
  "🎰 迷子的小游戏，每天可以抽一次：",
  `用法：${commandPrefix} 抽奖`,
  `看榜：${commandPrefix} 抽奖 榜单`,
  "从 B 站直播礼物里随机抽一款，抽中什么全看运气～",
].join("\n");

/** 抽奖参数：空是抽一次，「榜单」或 leaderboard 是看迷币榜。 */
export const parseBiliGiftLotteryArguments = (
  args: string,
): "draw" | "leaderboard" | undefined => {
  const normalized = args.trim().toLowerCase();
  if (normalized === "") {
    return "draw";
  }
  return normalized === "榜单" || normalized === "leaderboard" ? "leaderboard" : undefined;
};

/** 昵称查询的并发与超时：取不到就退回 QQ 号，别让榜单卡住。 */
const LEADERBOARD_NAME_CONCURRENCY = 3;
const LEADERBOARD_NAME_TIMEOUT_MS = 3_000;

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

/** 取群成员昵称；超时或失败都返回 undefined，由调用方决定退回文案。 */
const loadMemberName = async (
  gateway: BiliGiftLotteryContext["gateway"],
  groupId: string,
  userId: string,
): Promise<string | undefined> =>
  withTimeout(gateway.getGroupMemberName(groupId, userId), LEADERBOARD_NAME_TIMEOUT_MS)
    .catch(() => undefined);

/** 给榜单条目补上群昵称，失败或超时就退回 QQ 号。 */
const resolveLeaderboardNames = async (
  entries: readonly GiftLotteryCoinEntry[],
  gateway: BiliGiftLotteryContext["gateway"],
  groupId: string,
): Promise<readonly { userId: string; coins: number; name?: string }[]> => {
  const results = await settleWithConcurrency(entries, LEADERBOARD_NAME_CONCURRENCY, async (entry) => ({
    ...entry,
    name: await loadMemberName(gateway, groupId, entry.userId),
  }));
  return results.map((result, index) =>
    result.status === "fulfilled" ? result.value : entries[index]!);
};

/** 榜单只读，不消耗每天的抽奖名额。 */
export const handleBiliGiftLotteryLeaderboard = async ({
  commandPrefix,
  gateway,
  groupId,
  isGroupChat,
  logger,
  reply,
  store,
  userId,
}: {
  commandPrefix: string;
  gateway: BiliGiftLotteryContext["gateway"];
  groupId: string;
  isGroupChat: boolean;
  logger: BiliGiftLotteryContext["logger"];
  reply: BiliGiftLotteryContext["reply"];
  store: GiftLotteryDrawStore;
  userId: string;
}) => {
  if (!isGroupChat) {
    await reply("迷币榜是按群统计的，回群里发 " + commandPrefix + " 抽奖 榜单 就能看到啦～");
    return;
  }

  let entries;
  let viewer;
  try {
    entries = await store.listTopCoins(groupId, BILI_GIFT_LOTTERY_LEADERBOARD_SIZE);
    viewer = await store.readCoinRank({ groupId, userId });
  } catch (error) {
    logger.warn("plugin", "bilibili gift lottery leaderboard failed", {
      error: summarizeError(error),
    });
    await reply("迷币榜暂时读不到，稍后再试一次吧～");
    return;
  }

  const namedEntries = await resolveLeaderboardNames(entries, gateway, groupId);
  let text = createBiliGiftLotteryLeaderboardMessage(namedEntries, { commandPrefix });
  if (entries.length > 0) {
    if (!viewer) {
      text += "\n\n你还没有迷币，发一次 " + commandPrefix + " 抽奖 就能上榜～";
    } else if (!entries.some((entry) => entry.userId === userId)) {
      text += "\n\n你的排名：第 " + viewer.rank + " 名 · " + viewer.coins + " 迷币";
    }
  }
  await reply(text);
};
export const handleBiliGiftLotteryCommand = async ({
  args,
  commandPrefix,
  gateway,
  logger,
  message,
  reply,
  replyForwardWithoutRetry,
}: BiliGiftLotteryContext, options: BiliGiftLotteryCommandOptions = {}) => {
  const request = parseBiliGiftLotteryArguments(args);
  if (request === undefined) {
    await reply(`${createBiliGiftLotteryUsage(commandPrefix)}\n抽奖指令后面只支持「榜单」。`);
    return;
  }

  const userId = message.userId === undefined ? "" : String(message.userId);
  if (userId === "") {
    await reply("没有认出发消息的账号，换个群再试试吧。");
    return;
  }

  const isGroupChat = message.groupId !== undefined;
  // 每个群各有一份每日名额；私聊按用户算一份。
  const groupId = isGroupChat ? String(message.groupId) : `private:${userId}`;
  const now = options.now ?? new Date();
  const drawDate = formatGiftLotteryDrawDate(now);
  const drawKey = { groupId, drawDate };
  const store = options.store ?? giftLotteryDrawStore;

  if (request === "leaderboard") {
    await handleBiliGiftLotteryLeaderboard({
      commandPrefix,
      gateway,
      groupId,
      isGroupChat,
      logger,
      reply,
      store,
      userId,
    });
    return;
  }

  // 读记录失败时放行：数据库抖动不该把娱乐功能整个挡在门外。
  let existing: GiftLotteryDailyDraw | undefined;
  try {
    existing = await store.find(drawKey);
  } catch (error) {
    logger.warn("plugin", "bilibili gift lottery daily lookup failed", {
      error: summarizeError(error),
    });
  }
  if (existing) {
    const winnerName = isGroupChat && existing.userId
      ? await loadMemberName(gateway, groupId, existing.userId)
      : undefined;
    await reply(
      createAlreadyDrawnMessage(isGroupChat, existing.giftName, existing.coins, winnerName),
    );
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

  const coins = getBiliGiftLotteryCoins(draw.gift);

  // 先占住这个群今天的名额，避免两条消息同时抽两次。
  let claimed = false;
  try {
    const result = await store.claim({
      ...drawKey,
      userId,
      giftId: draw.gift.id,
      giftName: draw.gift.name,
      coins,
    });
    if (result === "taken") {
      const taken = await store.find(drawKey).catch(() => undefined);
      const winnerName = isGroupChat && taken?.userId
        ? await loadMemberName(gateway, groupId, taken.userId)
        : undefined;
      await reply(
        createAlreadyDrawnMessage(isGroupChat, taken?.giftName, taken?.coins, winnerName),
      );
      return;
    }
    claimed = true;
  } catch (error) {
    logger.warn("plugin", "bilibili gift lottery claim failed", {
      error: summarizeError(error),
    });
  }

  // 公告里写上中奖群友的昵称，取不到就退回「你」。
  const winnerName = isGroupChat ? await loadMemberName(gateway, groupId, userId) : undefined;

  // 迷币总量按群按人记录，读不到就只显示本次获得的部分。
  let totalCoins = coins;
  try {
    totalCoins = (await store.readCoins({ groupId, userId })) + coins;
  } catch (error) {
    logger.warn("plugin", "bilibili gift lottery coin lookup failed", {
      error: summarizeError(error),
    });
  }

  // 没能把结果发出去时退回名额，让大家可以再试一次。
  const releaseClaim = async () => {
    if (!claimed) {
      return;
    }
    try {
      await store.release(drawKey);
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
        formatBiliGiftLotteryCard(draw, { totalCoins, winnerName }),
        media,
        `base64://${mediaBase64}`,
      ),
      {
        // 标题带中奖人，卡片预览里直接看出是谁抽的。
        title: winnerName
          ? `${winnerName} 抽到了「${draw.gift.name}」`
          : `${formatBiliGiftLotteryStars(draw.rarity)} · ${draw.gift.name}`,
        source: `${commandPrefix} 抽奖`,
        summary: `${formatBiliGiftLotteryStars(draw.rarity)} · +${coins} 迷币`,
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
    return;
  }

  // 发出去之后才入账，避免发送失败白拿迷币。
  try {
    await store.addCoins({ groupId, userId }, coins);
  } catch (error) {
    logger.warn("plugin", "bilibili gift lottery coin credit failed", {
      error: summarizeError(error),
    });
  }
};

const lotteryPlugin: MizPlugin = {
  name: "lottery",
  commands: ["lottery", "抽奖"],
  description: [
    "迷子的小游戏：从 B 站直播礼物里抽一款，连展示效果一起发出来。",
    "用法：miz 抽奖，看榜：miz 抽奖 榜单",
    "每个群每天只能抽一次，抽到的礼物按价值折算成迷币，入账到抽奖人头上。",
    "礼物按价值分五档：🌱 普通 / ⭐ 稀有 / ✨ 史诗 / 💎 传说 / 👑 神话，越贵越难抽到。",
  ].join("\n"),
  async handle({
    command,
    commandPrefix,
    gateway,
    logger,
    message,
    reply,
    replyForwardWithoutRetry,
  }) {
    await handleBiliGiftLotteryCommand({
      args: command.args,
      commandPrefix,
      gateway,
      logger,
      message,
      reply,
      replyForwardWithoutRetry,
    });
  },
};

export default lotteryPlugin;
