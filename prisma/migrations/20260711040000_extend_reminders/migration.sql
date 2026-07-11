ALTER TABLE "reminders" ADD COLUMN IF NOT EXISTS "target_id" TEXT;
UPDATE "reminders" SET "target_id" = "creator_id" WHERE "target_id" IS NULL;
ALTER TABLE "reminders" ALTER COLUMN "target_id" SET NOT NULL;
ALTER TABLE "reminders" ADD COLUMN IF NOT EXISTS "last_sent_at" TIMESTAMPTZ;
ALTER TABLE "reminders" ADD COLUMN IF NOT EXISTS "repeat_interval_minutes" INTEGER;
