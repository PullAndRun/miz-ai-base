-- 抽奖改为记录「迷币」：每日记录带上当天获得的迷币，并新增按群按人的迷币总量。
ALTER TABLE "gift_lottery_daily_draws"
  ADD COLUMN IF NOT EXISTS "coins" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "gift_lottery_coin_balances" (
  "group_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "coins" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gift_lottery_coin_balances_pkey" PRIMARY KEY ("group_id", "user_id")
);
