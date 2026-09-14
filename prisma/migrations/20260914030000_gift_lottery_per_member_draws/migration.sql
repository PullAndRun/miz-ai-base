-- 每日名额从「每个群一次」改成「每个群每人一次」：主键加上 user_id。
ALTER TABLE "gift_lottery_daily_draws"
  DROP CONSTRAINT IF EXISTS "gift_lottery_daily_draws_pkey";

-- 旧结构允许 user_id 为空（早期按人记录、群信息缺失的存档行），这些行无法参与按人限量，先清掉。
DELETE FROM "gift_lottery_daily_draws" WHERE "user_id" IS NULL;

ALTER TABLE "gift_lottery_daily_draws"
  ALTER COLUMN "user_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gift_lottery_daily_draws_pkey'
  ) THEN
    ALTER TABLE "gift_lottery_daily_draws"
      ADD CONSTRAINT "gift_lottery_daily_draws_pkey"
      PRIMARY KEY ("group_id", "user_id", "draw_date");
  END IF;
END $$;
