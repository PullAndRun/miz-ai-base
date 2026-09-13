-- 抽奖限制从「每人每天一次」改成「每个群每天一次」，主键换成 (group_id, draw_date)。
ALTER TABLE "gift_lottery_daily_draws"
  DROP CONSTRAINT IF EXISTS "gift_lottery_daily_draws_pkey";

ALTER TABLE "gift_lottery_daily_draws"
  ADD COLUMN IF NOT EXISTS "group_id" TEXT;

-- 旧记录是按人记的、没有群信息，转成不会和任何群冲突的 legacy 键留档。
UPDATE "gift_lottery_daily_draws"
   SET "group_id" = 'legacy:' || "user_id"
 WHERE "group_id" IS NULL;

ALTER TABLE "gift_lottery_daily_draws"
  ALTER COLUMN "group_id" SET NOT NULL;

ALTER TABLE "gift_lottery_daily_draws"
  ALTER COLUMN "user_id" DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gift_lottery_daily_draws_pkey'
  ) THEN
    ALTER TABLE "gift_lottery_daily_draws"
      ADD CONSTRAINT "gift_lottery_daily_draws_pkey" PRIMARY KEY ("group_id", "draw_date");
  END IF;
END $$;