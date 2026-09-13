import dayjs from "dayjs";
import { createDatabaseClient } from "@/database";
import type { PrismaClient } from "@/generated/prisma/client";

export type GiftLotteryDailyDrawKey = Readonly<{
  userId: string;
  /** 本地日期，格式 YYYY-MM-DD。 */
  drawDate: string;
}>;

export type GiftLotteryDailyDraw = Readonly<{
  giftId: number;
  giftName: string;
}>;

/** 每日一次的限制依赖这层存储；测试可以注入内存实现。 */
export type GiftLotteryDrawStore = Readonly<{
  find: (key: GiftLotteryDailyDrawKey) => Promise<GiftLotteryDailyDraw | undefined>;
  claim: (draw: GiftLotteryDailyDrawKey & GiftLotteryDailyDraw) => Promise<"claimed" | "taken">;
  release: (key: GiftLotteryDailyDrawKey) => Promise<void>;
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
    where: { userId_drawDate: { userId: key.userId, drawDate: key.drawDate } },
  });
  return record ? { giftId: record.giftId, giftName: record.giftName } : undefined;
};

/** 先占位再发奖：唯一键冲突说明当天已经抽过了。 */
export const claimGiftLotteryDailyDraw = async (
  draw: GiftLotteryDailyDrawKey & GiftLotteryDailyDraw,
): Promise<"claimed" | "taken"> => {
  try {
    await requireDrawDatabase().giftLotteryDailyDraw.create({
      data: {
        userId: draw.userId,
        drawDate: draw.drawDate,
        giftId: draw.giftId,
        giftName: draw.giftName,
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

/** 发送失败时退回当天的抽奖资格。 */
export const releaseGiftLotteryDailyDraw = async (key: GiftLotteryDailyDrawKey) => {
  await requireDrawDatabase().giftLotteryDailyDraw.deleteMany({
    where: { userId: key.userId, drawDate: key.drawDate },
  });
};

export const giftLotteryDrawStore: GiftLotteryDrawStore = {
  find: findGiftLotteryDailyDraw,
  claim: claimGiftLotteryDailyDraw,
  release: releaseGiftLotteryDailyDraw,
};

const isUniqueConstraintViolation = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
