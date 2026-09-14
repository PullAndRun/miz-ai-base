import dayjs from "dayjs";
import { createDatabaseClient } from "@/database";
import type { PrismaClient } from "@/generated/prisma/client";

export type GiftLotteryDailyDrawKey = Readonly<{
  /** 群号；私聊用 `private:<用户号>`，这样每个群各算一份名额。 */
  groupId: string;
  /** 抽奖人，每个群每人每天一次。 */
  userId: string;
  /** 本地日期，格式 YYYY-MM-DD。 */
  drawDate: string;
}>;

export type GiftLotteryDailyDraw = Readonly<{
  giftId: number;
  giftName: string;
  /** 当天这一抽获得的迷币。 */
  coins: number;
}>;

export type GiftLotteryCoinKey = Readonly<{
  /** 群号；私聊用 `private:<用户号>`。 */
  groupId: string;
  userId: string;
}>;

export type GiftLotteryCoinEntry = Readonly<{
  userId: string;
  coins: number;
}>;

export type GiftLotteryCoinRank = Readonly<{
  rank: number;
  coins: number;
}>;

/** 每日一次的限制依赖这层存储；测试可以注入内存实现。 */
export type GiftLotteryDrawStore = Readonly<{
  find: (key: GiftLotteryDailyDrawKey) => Promise<GiftLotteryDailyDraw | undefined>;
  claim: (draw: GiftLotteryDailyDrawKey & GiftLotteryDailyDraw) => Promise<"claimed" | "taken">;
  release: (key: GiftLotteryDailyDrawKey) => Promise<void>;
  /** 该群该用户累计的迷币。 */
  readCoins: (key: GiftLotteryCoinKey) => Promise<number>;
  /** 发送成功后给该群该用户入账。 */
  addCoins: (key: GiftLotteryCoinKey, amount: number) => Promise<void>;
  /** 群里迷币最多的前几名。 */
  listTopCoins: (groupId: string, limit: number) => Promise<readonly GiftLotteryCoinEntry[]>;
  /** 某人在群里的名次，没有记录时返回 undefined。 */
  readCoinRank: (key: GiftLotteryCoinKey) => Promise<GiftLotteryCoinRank | undefined>;
}>;

let drawDatabase: PrismaClient | undefined;
let drawDatabaseUrl: string | undefined;

/** 抽奖记录和 B 站凭据一样保存在 PostgreSQL 里。 */
export const configureGiftLotteryDrawStore = (databaseUrl: string) => {
  if (drawDatabase && drawDatabaseUrl === databaseUrl) {
    return;
  }
  const previousDatabase = drawDatabase;
  drawDatabase = createDatabaseClient(databaseUrl);
  drawDatabaseUrl = databaseUrl;
  // 重新配置是同步的，旧连接在后台断掉即可。
  void previousDatabase?.$disconnect().catch(() => undefined);
};

export const formatGiftLotteryDrawDate = (now: Date) => dayjs(now).format("YYYY-MM-DD");

const requireDrawDatabase = () => {
  if (!drawDatabase) {
    throw new Error("Gift lottery draw store is not configured");
  }
  return drawDatabase;
};

export const findGiftLotteryDailyDraw = async (
  key: GiftLotteryDailyDrawKey,
): Promise<GiftLotteryDailyDraw | undefined> => {
  const record = await requireDrawDatabase().giftLotteryDailyDraw.findUnique({
    where: {
      groupId_userId_drawDate: {
        groupId: key.groupId,
        userId: key.userId,
        drawDate: key.drawDate,
      },
    },
  });
  return record
    ? { giftId: record.giftId, giftName: record.giftName, coins: record.coins }
    : undefined;
};

/** 先占位再发奖：唯一键冲突说明这个群当天已经抽过了。 */
export const claimGiftLotteryDailyDraw = async (
  draw: GiftLotteryDailyDrawKey & GiftLotteryDailyDraw,
): Promise<"claimed" | "taken"> => {
  try {
    await requireDrawDatabase().giftLotteryDailyDraw.create({
      data: {
        groupId: draw.groupId,
        userId: draw.userId,
        drawDate: draw.drawDate,
        giftId: draw.giftId,
        giftName: draw.giftName,
        coins: draw.coins,
      },
    });
    return "claimed";
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      return "taken";
    }
    throw error;
  }
};

/** 发送失败时退回这个群当天的抽奖资格。 */
export const releaseGiftLotteryDailyDraw = async (key: GiftLotteryDailyDrawKey) => {
  await requireDrawDatabase().giftLotteryDailyDraw.deleteMany({
    where: { groupId: key.groupId, userId: key.userId, drawDate: key.drawDate },
  });
};

export const readGiftLotteryCoins = async (key: GiftLotteryCoinKey): Promise<number> => {
  const record = await requireDrawDatabase().giftLotteryCoinBalance.findUnique({
    where: { groupId_userId: { groupId: key.groupId, userId: key.userId } },
  });
  return record?.coins ?? 0;
};

/** 用 upsert + increment 入账，避免并发下丢硬币。 */
export const addGiftLotteryCoins = async (key: GiftLotteryCoinKey, amount: number) => {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return;
  }
  await requireDrawDatabase().giftLotteryCoinBalance.upsert({
    where: { groupId_userId: { groupId: key.groupId, userId: key.userId } },
    create: { groupId: key.groupId, userId: key.userId, coins: amount },
    update: { coins: { increment: amount } },
  });
};

export const listGiftLotteryTopCoins = async (
  groupId: string,
  limit: number,
): Promise<readonly GiftLotteryCoinEntry[]> => {
  const rows = await requireDrawDatabase().giftLotteryCoinBalance.findMany({
    where: { groupId },
    orderBy: [{ coins: "desc" }, { userId: "asc" }],
    take: Math.max(1, Math.floor(limit)),
  });
  return rows.map((row) => ({ userId: row.userId, coins: row.coins }));
};

export const readGiftLotteryCoinRank = async (
  key: GiftLotteryCoinKey,
): Promise<GiftLotteryCoinRank | undefined> => {
  const client = requireDrawDatabase();
  const record = await client.giftLotteryCoinBalance.findUnique({
    where: { groupId_userId: { groupId: key.groupId, userId: key.userId } },
  });
  if (!record) {
    return undefined;
  }
  const above = await client.giftLotteryCoinBalance.count({
    where: { groupId: key.groupId, coins: { gt: record.coins } },
  });
  return { rank: above + 1, coins: record.coins };
};

export const giftLotteryDrawStore: GiftLotteryDrawStore = {
  find: findGiftLotteryDailyDraw,
  claim: claimGiftLotteryDailyDraw,
  release: releaseGiftLotteryDailyDraw,
  readCoins: readGiftLotteryCoins,
  addCoins: addGiftLotteryCoins,
  listTopCoins: listGiftLotteryTopCoins,
  readCoinRank: readGiftLotteryCoinRank,
};

const isUniqueConstraintViolation = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
